'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { normalizeSnapshot } = require('../src/db/schema-diff');

const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = value => '`' + value.replaceAll('`', '``') + '`';

async function owned(configPath) {
  const folder = path.dirname(await fs.realpath(configPath)), marker = await read(path.join(folder, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(marker.id, path.basename(folder));
  const config = await read(configPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const actor = await mysql.createConnection(config);
  try {
    const [[server]] = await actor.query('SELECT @@datadir datadir,VERSION() version');
    assert.equal(path.dirname(await fs.realpath(server.datadir)).toLowerCase(), folder.toLowerCase());
    return { actor, config, version: server.version };
  } catch (error) { await actor.end(); throw error; }
}

async function verifyStoredSchemaComparison(runtime, adapter) {
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const spring = async () => {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  await spring();
  const engine = runtime.dbEngine;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const secondary = engine === 'mysql' ? await require('../scripts/integration-mysql').startMysqlFixture()
    : await require('../scripts/integration-db-fixture').startFixture();
  const suffix = randomBytes(4).toString('hex'), name = part => 'rb_stored_' + suffix + '_' + part;
  let primary, peer;
  const statements = desired => [
    'CREATE TABLE ' + quote(name('records')) + ' (id INT PRIMARY KEY, work INT NOT NULL) ENGINE=InnoDB',
    'CREATE PROCEDURE ' + quote(name('changed')) + '() SELECT ' + (desired ? '11' : '19') + ' AS observed',
    'CREATE PROCEDURE ' + quote(name('match')) + '() SELECT 17 AS observed',
    ...(desired ? ['CREATE PROCEDURE ' + quote(name('one_side')) + '() SELECT 21 AS observed'] : []),
    "SET SESSION sql_mode='" + (desired ? 'NO_BACKSLASH_ESCAPES' : 'STRICT_TRANS_TABLES') + "'",
    'CREATE FUNCTION ' + quote(name('context')) + '(p INT) RETURNS INT DETERMINISTIC NO SQL RETURN p+1',
    "SET SESSION sql_mode='STRICT_TRANS_TABLES'",
    ...(desired ? ['z_first', 'a_second'] : ['a_second', 'z_first']).map(trigger =>
      'CREATE TRIGGER ' + quote(name(trigger)) + ' BEFORE INSERT ON ' + quote(name('records')) + ' FOR EACH ROW SET NEW.work=NEW.work+1'),
    "SET SESSION time_zone='" + (desired ? '+00:00' : '+01:00') + "'",
    'CREATE EVENT ' + quote(name('disabled_event')) +
      " ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' DISABLE DO SET @rb_event_never_runs=1"
  ];
  try {
    primary = await owned(runtime.dbConfigPath);
    peer = await owned(secondary.configPath);
    assert.equal(primary.version, peer.version);
    assert.notEqual(primary.config.port, peer.config.port);
    for (const [source, desired] of [[primary, true], [peer, false]]) {
      for (const sql of statements(desired)) await source.actor.query(sql);
    }
    await adapter.connect(primary.config);
    const wanted = await adapter.capture({ includeStoredObjects: true });
    const wantedStored = wanted.storedObjects;
    assert.equal(wanted.rowDataIncluded, false);
    assert.equal(wantedStored.objects.filter(item => item.name.startsWith(name('')) && item.state === 'observed').length, 7);
    const saved = await adapter.roundTrip(wanted);
    assert.equal(saved.storedObjects.fingerprint, wantedStored.fingerprint);
    const tampered = structuredClone(wanted);
    tampered.storedObjects.objects.find(item => item.name === name('changed')).definition += ' ';
    assert.throws(() => normalizeSnapshot(tampered), /stored-object snapshot content or server/);
    await adapter.connect(peer.config);
    const report = await adapter.compare(saved);
    assert.notEqual(report.currentServer.serverUniqueId, report.desiredServer.serverUniqueId);
    assert.equal(report.executedSql, false);
    const diff = report.storedObjects;
    assert.equal(diff.state, 'account-visible-comparison');
    assert.ok(diff.matchedExact >= 1);
    const forName = part => diff.differences.find(item => item.name === name(part));
    const procedure = forName('changed');
    assert.deepEqual(procedure.aspects, ['definition']);
    assert.match(procedure.before.definition, /19 AS observed/u);
    assert.match(procedure.after.definition, /11 AS observed/u);
    assert.deepEqual(forName('context').aspects, ['settings']);
    assert.equal(forName('context').before.settings.sql_mode, 'STRICT_TRANS_TABLES');
    assert.equal(forName('context').after.settings.sql_mode, 'NO_BACKSLASH_ESCAPES');
    assert.deepEqual(forName('z_first').aspects, ['trigger']);
    assert.equal(forName('z_first').before.trigger.actionOrder, 2);
    assert.equal(forName('z_first').after.trigger.actionOrder, 1);
    assert.equal(forName('disabled_event').before.settings.time_zone, '+01:00');
    assert.equal(forName('disabled_event').after.settings.time_zone, '+00:00');
    assert.ok(forName('disabled_event').aspects.includes('settings'));
    assert.equal(forName('one_side').state, 'seen-desired-only');
    assert(diff.differences.every(change => change.selectable === false));
    assert(!report.changes.some(change => diff.differences.some(item => item.id === change.id)));
    await assert.rejects(adapter.plan(report.id, [procedure.id]), /missing or not supported/);
    if (adapter.diff) await adapter.diff(report, procedure);

    const username = 'rb_diff_guest_' + suffix, password = randomBytes(18).toString('base64url');
    const account = [username, '127.0.0.1'];
    await secondary.withAdmin(async admin => {
      await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [...account, password]);
      await admin.query('GRANT SELECT ON rocketbrain_fixture.* TO ?@?', account);
      await admin.query('GRANT EXECUTE ON PROCEDURE rocketbrain_fixture.' + quote(name('changed')) + ' TO ?@?', account);
    });
    const restricted = { ...peer.config, user: username, password };
    let guest;
    try {
      guest = await mysql.createConnection(restricted);
      assert.equal(Number((await guest.query('CALL ' + quote(name('changed')) + '()'))[0][0][0].observed), 19);
      await adapter.connect(restricted);
      const report = await adapter.compare(saved);
      const changes = report.storedObjects.differences;
      const withheld = changes.find(change => change.name === name('changed'));
      assert.equal(withheld.state, 'definition-unavailable');
      assert.equal(withheld.before.state, 'withheld');
      assert.equal(withheld.before.definition, undefined);
      assert.ok(changes.some(change => change.name === name('disabled_event') && change.state === 'seen-desired-only'));
    } finally {
      if (guest) await guest.end();
      await adapter.disconnect();
      await secondary.withAdmin(admin => admin.query('DROP USER ?@?', account));
    }
    for (const { actor } of [primary, peer]) {
      const [[row]] = await actor.query('SELECT STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() AND EVENT_NAME=?',
        [name('disabled_event')]);
      assert.equal(row.STATUS, 'DISABLED');
      assert.equal(Number((await actor.query('SELECT COUNT(*) n FROM ' + quote(name('records'))))[0][0].n), 0);
    }
    await spring();
    return { engine, version: primary.version, distinctServers: true, observedStoredDefinitions: 7,
      exactSourceAndSettings: true, triggerActionOrder: true, disabledEventTimeZone: true, permissionWithheld: true,
      unmatchedVisibilityOnly: true, storedMigrationRefused: true, snapshotTamperRejected: true,
      readonlyNativeDiff: Boolean(adapter.diff), rowDataOrSqlExecution: false, spring: expectedSpring };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try {
        for (const instance of [primary, peer].filter(Boolean)) {
          try {
            for (const [kind, part] of [['EVENT', 'disabled_event'], ['FUNCTION', 'context'], ['PROCEDURE', 'changed'],
              ['PROCEDURE', 'one_side'], ['PROCEDURE', 'match'], ['TABLE', 'records']]) {
              await instance.actor.query('DROP ' + kind + ' IF EXISTS ' + quote(name(part)));
            }
          } finally { await instance.actor.end(); }
        }
      } finally { await secondary.stop(); }
    }
  }
}

async function runStoredSchemaDiffChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG), comparison = api.schemaComparison;
  const result = await verifyStoredSchemaComparison(runtime, {
    connect: config => api.connectMysql({ ...config, readOnly: true }),
    disconnect: () => api.disconnectMysql(),
    capture: options => comparison.capture(options), compare: wanted => comparison.compare(wanted),
    plan: (id, changes) => comparison.plan(id, changes),
    async roundTrip(snapshot) {
      const owner = path.dirname(await fs.realpath(runtime.dbConfigPath));
      const file = path.join(owner, 'stored-schema-fixture-' + randomBytes(5).toString('hex') + '.json');
      try { await fs.writeFile(file, JSON.stringify(snapshot), { flag: 'wx' }); return comparison.readSnapshot(vscode.Uri.file(file)); }
      finally { await fs.unlink(file); }
    },
    async diff(report, change) {
      const review = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/' + report.id + '/comparison.md'));
      assert.match(review.getText(), /Stored-object comparison/);
      assert.match(review.getText(), /changed-source-or-context/);
      const editor = await comparison.openStoredDiff(report.id, change.id);
      assert.equal(editor.executedSql, false);
      const current = await vscode.workspace.openTextDocument(vscode.Uri.parse(editor.current));
      const desired = await vscode.workspace.openTextDocument(vscode.Uri.parse(editor.desired));
      assert.equal(current.getText().replaceAll('\r\n', '\n'), change.before.definition.replaceAll('\r\n', '\n'));
      assert.equal(desired.getText().replaceAll('\r\n', '\n'), change.after.definition.replaceAll('\r\n', '\n'));
      assert.equal(current.isDirty, false);
      assert.equal(desired.isDirty, false);
      const exact = current.getText();
      await vscode.window.showTextDocument(current, { preview: false });
      await vscode.commands.executeCommand('type', { text: '-- readonly probe' });
      assert.equal(current.getText(), exact);
      assert.equal(current.isDirty, false);
      const titles = await vscode.commands.getCommands(true);
      assert.ok(titles.includes('rocketbrain.schema.saveSnapshotWithStoredObjects') && titles.includes('rocketbrain.schema.openStoredObjectDiff'));
    }
  });
  checks.push('Compared stored routine, trigger and disabled event source and creation context across two distinct disposable servers.');
  checks.push('Opened exact source in a read-only native diff, preserved partial account visibility, and refused stored changes as migration steps.');
  return result;
}

module.exports = { owned, verifyStoredSchemaComparison, runStoredSchemaDiffChecks };
