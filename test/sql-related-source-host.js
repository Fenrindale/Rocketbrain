'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };
const high = '9007199254740993', low = '9007199254740992';
const bytes = Buffer.from([0, 255, 65]), other = Buffer.from([0, 0]);

async function withFixture(runtime, use) {
  const owner = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const marker = await read(path.join(owner, 'owner.json')), cross = await read(path.join(owner, 'cross-schema.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(path.basename(owner), marker.id);
  assert.equal(cross.fixtureId, marker.id);
  assert.deepEqual(cross.schemas, ['rocketbrain_fixture', 'rocketbrain_related']);
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, cross.schemas[0]);
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const spring = async () => {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  const [local, remote] = cross.schemas, suffix = randomBytes(5).toString('hex'), table = 'rb_sql_related_' + suffix;
  const view = 'rb_sql_view_' + suffix, fk = 'rb_sql_fk_' + suffix;
  const actor = await mysql.createConnection(config);
  const actual = async (sql, params) => (await actor.query(sql, params))[0];
  try {
    const [{ datadir, version }] = await actual('SELECT @@datadir datadir,VERSION() version');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(), owner.toLowerCase());
    const engine = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
    assert.equal(engine, runtime.dbEngine);
    await spring();
    await actual('CREATE TABLE ??.?? (tenant BIGINT UNSIGNED, token VARBINARY(8), label VARCHAR(40), PRIMARY KEY(tenant,token)) ENGINE=InnoDB', [remote, table]);
    await actual('CREATE TABLE ?? (tenant BIGINT UNSIGNED, token VARBINARY(8), ref_id BIGINT UNSIGNED, ref_key VARBINARY(8), PRIMARY KEY(tenant,token), ' +
      'CONSTRAINT ?? FOREIGN KEY(ref_id,ref_key) REFERENCES ??.??(tenant,token)) ENGINE=InnoDB', [table, fk, remote, table]);
    await actual('CREATE VIEW ?? AS SELECT * FROM ??', [view, table]);
    await actual('INSERT INTO ??.?? VALUES ?', [remote, table, [[low, bytes, 'representable'], [high, bytes, 'exact'], [high, other, 'other']]]);
    await actual('INSERT INTO ?? VALUES ?', [table, [[low, bytes, low, bytes], [high, bytes, high, bytes], [high, other, null, bytes]]]);
    const details = await use({ actual, config, local, remote, table, view });
    await spring();
    return { engine, version, ...details, spring: expectedSpring };
  } finally {
    try {
      await actual('DROP VIEW IF EXISTS ??', [view]);
      await actual('DROP TABLE IF EXISTS ??', [table]);
      await actual('DROP TABLE IF EXISTS ??.??', [remote, table]);
    } finally { await actor.end(); }
  }
}

async function verifyProjection({ actual, local, remote, table, view }, tool) {
  const ordinary = 'SELECT s.tenant AS pair, s.token AS pair, s.ref_id AS referenced, s.ref_key AS bytes ' +
    'FROM `' + local + '`.`' + table + '` AS s ORDER BY s.tenant,s.token';
  const record = await tool.query(ordinary);
  assert.ok(record.origin, JSON.stringify(record.result.fields));
  assert.deepEqual(record.result.columns, ['pair', 'pair', 'referenced', 'bytes']);
  const index = record.result.rows.findIndex(row => row[0] === high && row[1] === '0x00ff41');
  assert.ok(index >= 0, JSON.stringify(record.result.rows));
  const nullable = record.result.rows.findIndex(row => row[2] === null);
  assert.ok(nullable >= 0);
  const options = await tool.choices(record, index);
  const relation = options.find(item => item.schema === remote && item.table === table && item.direction === 'referenced');
  assert.ok(relation);
  assert.equal((await tool.choices(record, nullable)).length, 0);
  const opened = await tool.follow(record, index, relation);
  assert.equal(opened.result.edit.schema, remote);
  assert.equal(opened.result.edit.canEdit, false);
  assert.deepEqual(opened.result.rows, [[high, '0x00ff41', 'exact']]);
  assert.match(opened.result.browse.sql, /`tenant` = CAST\(\? AS UNSIGNED\) AND `token` = \?/);
  if (tool.back) assert.deepEqual(await tool.back(opened), { resultId: record.id, rowId: record.origin.rowIds[index] });
  if (tool.forged) await tool.forged(record, index);

  await actual('UPDATE ?? SET ref_id=? WHERE tenant=CAST(? AS UNSIGNED) AND token=?', [table, low, high, bytes]);
  await assert.rejects(tool.follow(record, index, relation), /source row changed/);
  await actual('UPDATE ?? SET ref_id=? WHERE tenant=CAST(? AS UNSIGNED) AND token=?', [table, high, high, bytes]);
  await actual('ALTER TABLE ?? ADD COLUMN harmless_change INT NULL', [table]);
  await assert.rejects(tool.choices(record, index), /source table changed/);
  await actual('ALTER TABLE ?? DROP COLUMN harmless_change', [table]);

  const wildcard = await tool.query('SELECT s.* FROM `' + table + '` AS s ORDER BY s.tenant');
  assert.ok(wildcard.origin);
  if (tool.editorDrift) {
    await tool.editorDrift(wildcard);
    await assert.rejects(tool.choices(wildcard, 0), /captured SQL row, editor or connection changed/);
  }
  const refused = [
    'SELECT ref_id,ref_key FROM `' + table + '`',
    'SELECT tenant+0 AS tenant,token,ref_id,ref_key FROM `' + table + '`',
    'SELECT * FROM `' + view + '`',
    'SELECT x.* FROM `' + table + '` x JOIN `' + table + '` y ON x.tenant=y.tenant',
    'WITH rows_cte AS (SELECT * FROM `' + table + '`) SELECT * FROM rows_cte'
  ];
  for (const sql of refused) { const capture = await tool.query(sql); assert.equal(Boolean(capture.origin), false); }
  return { projectedAliasWithDuplicateLabels: true, wildcardVerified: true, physicalCrossSchema: true,
    compositeBigIntAndBinary: true, nullRelationSkipped: true, staleSourceRowAndSchemaRefused: true,
    refusedAmbiguousProjections: refused.length, nativeResultAndReturn: Boolean(tool.back), changedDocumentRefused: Boolean(tool.editorDrift) };
}

async function verifySqlRelatedSourceBackend(runtime) {
  return withFixture(runtime, async fixture => {
    const { MysqlService } = require('../src/db/mysql');
    const { relatedRowsFromObservation } = require('../src/db/related-rows');
    const db = new MysqlService(fixture.config);
    const verify = async (record, index) => {
      const { origin: source, result } = record, row = result.rows[index];
      await db.recheckSqlRowSource({ source, row });
      const catalog = await db.relatedRowsCatalog(source);
      return relatedRowsFromObservation(catalog, source.columns, row, source.definitions);
    };
    try {
      const proof = await verifyProjection(fixture, {
        async query(sql) {
          const result = await db.query(sql);
          return { result, origin: await db.captureSqlRowSource(sql, result, 'default') };
        },
        choices: verify,
        async follow(record, index, prior) {
          const match = (await verify(record, index)).find(edge => edge.key === prior.key);
          assert.ok(match);
          return { result: await db.previewRelatedTable({ ...match, sourceServer: record.origin.server }, { filters: match.filters }) };
        }
      });
      await db.openSession('formerly-writable', { readOnly: false });
      await db.setReadOnly(true, { sessionId: 'formerly-writable' });
      const sql = 'SELECT * FROM `' + fixture.table + '`';
      const result = await db.query(sql, { sessionId: 'formerly-writable' });
      assert.equal(await db.captureSqlRowSource(sql, result, 'formerly-writable'), null);
      return { ...proof, previouslyWritableRefused: true };
    } finally { await db.dispose(); }
  });
}

async function runSqlRelatedSourceChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const result = await withFixture(runtime, async fixture => {
    const select = (record, index) => ({ modelId: record.origin.modelId, rowId: record.origin.rowIds[index] });
    await api.connectMysql(fixture.config);
    try {
      return await verifyProjection(fixture, {
        async query(sql) {
          const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
          await vscode.window.showTextDocument(document, { preview: false });
          const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
          const record = api.results().find(item => item.id === id);
          assert.equal(record?.state, 'done', record?.error);
          return { ...record, document, origin: record.result.relatedRows };
        },
        choices: (record, index) => api.inspectRelatedRows(record.id, select(record, index)),
        async follow(record, index, prior) {
          const id = await api.openRelatedRows(record.id, select(record, index), prior.key);
          const opened = api.results().find(item => item.id === id);
          assert.equal(opened?.state, 'done', opened?.error);
          assert.notEqual(opened.sessionId, record.sessionId);
          return opened;
        },
        back: record => api.returnToRelatedSource(record.id),
        forged: record => assert.rejects(api.inspectRelatedRows(record.id, { modelId: 'unobserved-capture', rowId: '0' }), /captured SQL row/),
        async editorDrift(record) {
          const editor = await vscode.window.showTextDocument(record.document, { preview: false });
          const version = record.document.version;
          assert.equal(await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '-- changed\n')), true);
          const deadline = Date.now() + 1500;
          while (record.document.version === version && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          assert.ok(record.document.version > version);
        }
      });
    } finally { await api.disconnectMysql(); }
  });
  checks.push('Ordinary SQL Result and Record actions followed a captured composite-key row across schemas, keeping duplicate labels and exact typed values.');
  checks.push('Native Return restored the source row. Forged capture, edited SQL, live row/DDL drift and five unproved projections were refused.');
  return result;
}

module.exports = { runSqlRelatedSourceChecks, verifySqlRelatedSourceBackend, withFixture };
