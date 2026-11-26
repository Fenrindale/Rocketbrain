'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { contextOf, loadSource } = require('../src/db/object-source');
const { inspectSequence } = require('../src/db/sequence-details');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const modern = /^12\./;
const bounds = { start: '18446744073709551000', maximum: '18446744073709551614', boundary: '18446744073709551035' };
const quote = name => '`' + name.replaceAll('`', '``') + '`';
const springState = { people: 2, departments: 1, rolledBackNames: 0 };
async function observedNumber(service) {
  const { rows } = await service.query("SELECT CAST(JSON_EXTRACT(?, '$.id') AS CHAR)", { values: ['{"id":' + bounds.start + '}'] });
  return rows[0][0];
}

async function readOwnedFixture(runtimePath = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) {
  const runtime = await read(runtimePath);
  assert.match(runtime.dbEngine, /^(mysql|mariadb)$/);
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  return { runtime, config };
}

async function verifyFixture({ runtime, config }, openDetails) {
  const client = await mysql.createConnection(config);
  const tag = 'rb_seq_details_' + randomBytes(4).toString('hex');
  const target = (name, kind = 'sequence') => ({ schema: config.database, name, kind });
  const qualified = name => quote(config.database) + '.' + quote(name);
  const cleanup = [];
  try {
    const [[{ version }]] = await client.query('SELECT VERSION() AS version');
    const isMaria = runtime.dbEngine === 'mariadb';
    const sequenceCases = [];
    let packageSource = false;
    let native = false;
    if (isMaria) {
      const typed = modern.test(version);
      const cases = [
        { suffix: 'cached', ddl: 'START WITH 29 MINVALUE -9 MAXVALUE 999 INCREMENT BY 3 CACHE 7 CYCLE',
          start: '29', maximum: '999', boundary: '50', cycle: true },
        { suffix: 'descending', ddl: 'START WITH -11 MINVALUE -99 MAXVALUE -2 INCREMENT BY -2 NOCACHE NOCYCLE',
          start: '-11', maximum: '-2', boundary: '-13', cycle: false },
        ...(typed ? [{ suffix: 'unsigned', ddl: 'AS BIGINT UNSIGNED START WITH ' + bounds.start +
          ' MINVALUE 1 MAXVALUE ' + bounds.maximum + ' INCREMENT BY 5 CACHE 7 CYCLE', ...bounds, cycle: true, unsigned: true }] : [])
      ];
      for (const item of cases) {
        const name = tag + '_' + item.suffix;
        const sqlName = qualified(name);
        await client.query('CREATE SEQUENCE ' + sqlName + ' ' + item.ddl);
        cleanup.unshift(() => client.query('DROP SEQUENCE IF EXISTS ' + sqlName));
        const object = target(name);
        const initial = await openDetails.inspect(object);
        assert.equal(initial.version, version);
        assert.equal(initial.nextNotCached, item.start);
        assert.equal(initial.maximum, item.maximum);
        assert.equal(initial.cycle, item.cycle);
        assert.deepEqual(initial.type, { name: 'BIGINT', unsigned: Boolean(item.unsigned), precision: 64 });
        assert.equal(initial.provenance, typed ? 'INFORMATION_SCHEMA.SEQUENCES and sequence state' : 'SHOW CREATE SEQUENCE and sequence state');
        // Existing cache on the server is retained. Only this explicit fixture operation allocates a value.
        const [[{ value }]] = await client.query('SELECT CAST(NEXT VALUE FOR ' + sqlName + ' AS CHAR) AS value');
        assert.equal(value, item.start);
        const later = await openDetails.inspect(object);
        assert.equal(later.nextNotCached, item.boundary);
        if (item.suffix === 'cached' && openDetails.native) {
          await openDetails.native(object, later, async () => {
            await client.query('ALTER SEQUENCE ' + sqlName + ' RESTART WITH 101');
          });
          native = true;
        }
        sequenceCases.push({ kind: item.suffix, provenance: later.provenance, maximum: later.maximum, durableBoundary: later.nextNotCached });
      }
      const name = tag + '_package';
      const qualifiedPackage = qualified(name);
      const [[{ mode }]] = await client.query('SELECT @@SESSION.sql_mode AS mode');
      await client.query("SET SESSION sql_mode='ORACLE'");
      try {
        await client.query('CREATE PACKAGE ' + qualifiedPackage + ' AS FUNCTION echo_value(n INT) RETURN INT; END');
        cleanup.unshift(async () => {
          await client.query("SET SESSION sql_mode='ORACLE'");
          try { await client.query('DROP PACKAGE IF EXISTS ' + qualifiedPackage); }
          finally { await client.query('SET SESSION sql_mode=?', [mode]); }
        });
        await client.query('CREATE PACKAGE BODY ' + qualifiedPackage +
          ' AS FUNCTION echo_value(n INT) RETURN INT AS BEGIN RETURN n; END; END');
      } finally { await client.query('SET SESSION sql_mode=?', [mode]); }
      for (const [kind, statement, field] of [
        ['package', 'PACKAGE', 'Create Package'], ['package-body', 'PACKAGE BODY', 'Create Package Body']
      ]) {
        const source = await openDetails.source(target(name, kind));
        const [[seen]] = await client.query('SHOW CREATE ' + statement + ' ' + qualifiedPackage);
        assert.equal(source.source, seen[field]);
      }
      packageSource = true;
    } else {
      const name = tag + '_table';
      const sqlName = qualified(name);
      await client.query('CREATE TABLE ' + sqlName + ' (id INT PRIMARY KEY)');
      cleanup.unshift(() => client.query('DROP TABLE IF EXISTS ' + sqlName));
      await assert.rejects(openDetails.inspect(target(name)), { code: 'ROCKETBRAIN_SEQUENCE_ENGINE' });
      await assert.rejects(openDetails.inspect(target(name, 'table')), { code: 'ROCKETBRAIN_SEQUENCE_ENGINE' });
      assert.match((await openDetails.source(target(name, 'table'))).source, /^CREATE TABLE /);
    }
    const projected = await openDetails.json();
    assert.equal(projected, bounds.start);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(9000) });
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), springState);
    return { engine: runtime.dbEngine, version, sequenceCases, packageSource, jsonPrecision: true, native, spring: springState };
  } finally {
    try { for (const drop of cleanup) await drop(); }
    finally { await client.end(); }
  }
}

async function verifyMariaDbSequenceDetailsBackend(runtimePath) {
  const fixture = await readOwnedFixture(runtimePath);
  const service = new MysqlService(fixture.config), query = (sql, values) => service._metadataQuery(sql, values);
  try {
    const context = await contextOf(query);
    return await verifyFixture(fixture, {
      inspect: object => inspectSequence(query, context, object),
      source: object => loadSource(query, context, object),
      json: () => observedNumber(service)
    });
  } finally { await service.dispose(); }
}

async function runMariaDbSequenceDetailsChecks(api, vscode, checks) {
  const fixture = await readOwnedFixture();
  const { config } = fixture;
  const direct = new MysqlService(config);
  await api.connectMysql(config);
  const readOnlyScheme = 'rocketbrain-object-source';
  try {
    const report = await verifyFixture(fixture, {
      inspect: object => api.objectSources.openSequenceDetails(object),
      source: object => api.objectSources.open(object),
      json: () => observedNumber(direct),
      async native(object, later, restart) {
        const source = await api.objectSources.open(object);
        assert.notEqual(later.documentUri, source.documentUri);
        const result = await vscode.commands.executeCommand('rocketbrain.db.inspectSequence');
        assert.equal(result.documentUri, later.documentUri);
        assert.equal(result.nextNotCached, later.nextNotCached);
        const document = vscode.window.activeTextEditor.document;
        assert.equal(document.uri.scheme, readOnlyScheme);
        assert.match(document.uri.path, /\.sequence\.txt$/);
        assert.equal(document.languageId, 'plaintext');
        assert.match(document.getText(), /Next non-cached boundary 50/);
        await vscode.commands.executeCommand('type', { text: 'read-only probe' });
        assert.equal(document.isDirty, false);
        assert.ok(!document.getText().includes('read-only probe'));
        await restart();
        const refreshed = await vscode.commands.executeCommand('rocketbrain.db.refreshObjectSource', document.uri);
        assert.equal(refreshed.documentUri, result.documentUri);
        assert.equal(refreshed.nextNotCached, '101');
        for (let attempt = 0; attempt < 100 && document.getText() !== refreshed.text; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(document.getText(), refreshed.text);
      }
    });
    checks.push('Read exact MariaDB sequence state with version-specific catalog provenance and kept package source, JSON precision and Spring JDBC behavior.');
    return report;
  } finally {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input?.uri?.scheme === readOnlyScheme && tab.input.uri.path.includes('rb_seq_details_'));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      await api.disconnectMysql();
    } finally { await direct.dispose(); }
  }
}

if (require.main === module) verifyMariaDbSequenceDetailsBackend()
  .then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { runMariaDbSequenceDetailsChecks, verifyMariaDbSequenceDetailsBackend };
