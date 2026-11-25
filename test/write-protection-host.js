'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runWriteProtectionChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  const raw = await mysql.createConnection(config);
  const suffix = randomBytes(5).toString('hex');
  const names = { ancestor: 'rb_ancestor_' + suffix, parent: 'rb_parent_' + suffix, protected: 'rb_guard_' + suffix,
    writable: 'rb_writable_' + suffix, triggered: 'rb_triggered_' + suffix, unrelated: 'rb_unrelated_' + suffix };
  const routine = 'rb_fn_guard_' + suffix;
  const sessions = new Set(), profiles = [], manager = api.dbConnections;
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    return response.json();
  };

  async function profile(writeProtection) {
    const record = await manager.save({ profile: { name: 'Owned protection ' + suffix, host: config.host,
      port: config.port, user: config.user, database: config.database, writeProtection }, password: config.password });
    profiles.push(record.id);
    await manager.connect({ id: record.id, password: config.password });
    return record;
  }

  async function document(sql, setWritable) {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    await vscode.window.showTextDocument(doc, { preview: false });
    const { sessionId } = await api.describeSqlScript('SELECT 1', { document: doc });
    sessions.add(sessionId);
    if (setWritable) await api.configureConsoleSession(sessionId, { readOnly: false });
    return { doc, sessionId };
  }

  async function query(sql, setWritable = false) {
    await document(sql, setWritable);
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    const record = api.results().at(-1);
    assert.equal(record.sql, sql);
    return record;
  }

  async function grid(name) {
    await vscode.commands.executeCommand('rocketbrain.openTable', name);
    const record = api.results().at(-1);
    assert.equal(record.result?.edit?.table, name, record.error);
    sessions.add(record.sessionId);
    return record;
  }

  try {
    const originalSpring = await probe();
    assert.deepEqual(originalSpring, { people: 2, departments: 1, rolledBackNames: 0 });
    for (const name of Object.values(names)) {
      await raw.query('CREATE TABLE ' + name + ' (id INT PRIMARY KEY, label VARCHAR(40)) ENGINE=InnoDB');
      await raw.query("INSERT INTO " + name + " VALUES (1,'original')");
    }
    await raw.query('ALTER TABLE ' + names.parent + ' ADD FOREIGN KEY (id) REFERENCES ' + names.ancestor + ' (id) ON UPDATE CASCADE');
    await raw.query('ALTER TABLE ' + names.protected + ' ADD COLUMN parent_id INT DEFAULT 1, ADD FOREIGN KEY (parent_id) REFERENCES '
      + names.parent + ' (id) ON UPDATE CASCADE');
    await raw.query('ALTER TABLE ' + names.unrelated + ' ADD FOREIGN KEY (id) REFERENCES ' + names.writable + ' (id) ON UPDATE CASCADE');
    await raw.query("CREATE TRIGGER rb_trigger_" + suffix + ' BEFORE UPDATE ON ' + names.triggered
      + " FOR EACH ROW UPDATE " + names.protected + " SET label='trigger-run' WHERE id=1");
    await raw.query('CREATE FUNCTION ' + routine + '() RETURNS INT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY INVOKER '
      + "BEGIN UPDATE " + names.protected + " SET label='function-run' WHERE id=1; RETURN 1; END");

    await profile({ connectionReadOnly: true });
    const locked = await document('SELECT 1', false);
    await assert.rejects(api.configureConsoleSession(locked.sessionId, { readOnly: false }), /locked to read-only/);
    const connectionGrid = await grid(names.writable);
    assert.equal(connectionGrid.result.edit.canEdit, false);
    assert.match(connectionGrid.result.edit.reason, /locked to read-only/);
    const deniedConnection = await query("UPDATE " + names.writable + " SET label='blocked' WHERE id=1");
    assert.match(deniedConnection.error, /read-only/);
    assert.equal(Number((await query('WITH r AS (SELECT 1 AS n) SELECT n FROM r')).result.rows[0][0]), 1);

    const tableProfile = await profile({ tables: [{ schema: config.database, name: names.protected }] });
    await assert.rejects(api.withDatabaseAdmin(() => assert.fail('write was forwarded'), { write: true }), /Database-wide writes/);
    await assert.rejects(manager.save({ profile: { ...tableProfile.profile, writeProtection: undefined },
      expectedRevision: tableProfile.revision, verify: false }), /Disconnect this profile/);
    const exported = manager.exportProfiles();
    assert.equal(exported.version, 4);
    assert.ok(exported.profiles.some(item => item.writeProtection?.tables.some(target => target.name === names.protected)));
    const tableGrid = await grid(names.protected);
    assert.equal(tableGrid.result.edit.canEdit, false);
    assert.match(tableGrid.result.edit.reason, /protects this table/);
    const deniedTable = await query("UPDATE " + names.protected + " SET label='blocked' WHERE id=1", true);
    assert.match(deniedTable.error, /protects this table/);
    const joined = await query('UPDATE ' + names.writable + ' a JOIN ' + names.protected
      + " b ON a.id=b.id SET b.label='blocked' WHERE a.id=1", true);
    assert.match(joined.error, /Identify one base table/);
    const script = 'UPDATE ' + names.writable + " SET label='script-first' WHERE id=1; UPDATE "
      + names.protected + " SET label='blocked' WHERE id=1;";
    const scripted = await document(script, true);
    await assert.rejects(api.previewSqlScript(script, { document: scripted.doc }), /protects this table/);
    const deniedTrigger = await query("UPDATE " + names.triggered + " SET label='blocked' WHERE id=1", true);
    assert.match(deniedTrigger.error, /no triggers/);
    const deniedCascade = await query('UPDATE ' + names.parent + ' SET id=2 WHERE id=1', true);
    assert.match(deniedCascade.error, /could cascade/);
    const deniedAncestor = await query('UPDATE ' + names.ancestor + ' SET id=2 WHERE id=1', true);
    assert.match(deniedAncestor.error, /could cascade/);
    const deniedFunction = await query('SELECT ' + routine + '()', true);
    assert.match(deniedFunction.error, /unverified SQL functions/);
    const readOnlyFunction = await query('SELECT ' + routine + '()');
    assert.match(readOnlyFunction.error, /read.only transaction/);
    const select = 'SELECT label FROM ' + names.protected + ' WHERE id=1';
    assert.match((await query(select, true)).error, /Use a read-only console/);
    assert.deepEqual((await query(select)).result.rows, [['original']]);

    const service = await api.withDatabaseAdmin(({ db }) => db);
    await raw.query('SET SESSION lock_wait_timeout=1');
    const verifyTarget = service._ensureSafeProtectedTarget;
    const concurrentTrigger = 'CREATE TRIGGER rb_concurrent_' + suffix + ' BEFORE UPDATE ON ' + names.writable
      + ' FOR EACH ROW SET NEW.label=NEW.label';
    const fkName = 'rb_concurrent_fk_' + suffix;
    const concurrentAlter = 'ALTER TABLE ' + names.parent + ' ADD CONSTRAINT ' + fkName
      + ' FOREIGN KEY (id) REFERENCES ' + names.writable + ' (id) ON UPDATE CASCADE';
    let ddlChecks = 0;
    service._ensureSafeProtectedTarget = async function (target, pin) {
      await verifyTarget.call(this, target, pin);
      if (!pin || target.name !== names.writable || ddlChecks) return;
      for (const ddl of [concurrentTrigger, concurrentAlter]) {
        await assert.rejects(raw.query(ddl), error => error.code === 'ER_LOCK_WAIT_TIMEOUT');
        ddlChecks++;
      }
    };
    let applicationWrite;
    try { applicationWrite = await query('UPDATE ' + names.writable + " SET label='allowed' WHERE id=1", true); }
    finally { service._ensureSafeProtectedTarget = verifyTarget; }
    assert.equal(ddlChecks, 2);
    assert.equal(applicationWrite.error, undefined);
    assert.equal(applicationWrite.result.affectedRows, 1);
    assert.equal(applicationWrite.result.state.inTransaction, false);
    await raw.query(concurrentAlter);
    assert.match((await query('UPDATE ' + names.writable + ' SET id=2 WHERE id=1', true)).error, /could cascade/);
    await raw.query('ALTER TABLE ' + names.parent + ' DROP FOREIGN KEY ' + fkName);
    await raw.query(concurrentTrigger);
    assert.match((await query('UPDATE ' + names.writable + " SET label='blocked' WHERE id=1", true)).error, /no triggers/);
    await raw.query('DROP TRIGGER rb_concurrent_' + suffix);
    const writableGrid = await grid(names.writable);
    assert.equal(writableGrid.result.edit.canEdit, true);
    const [[guarded]] = await raw.query('SELECT label,parent_id FROM ' + names.protected + ' WHERE id=1');
    assert.deepEqual({ ...guarded }, { label: 'original', parent_id: 1 });
    const [[allowed]] = await raw.query('SELECT label FROM ' + names.writable + ' WHERE id=1');
    assert.equal(allowed.label, 'allowed');
    const manual = await document('UPDATE ' + names.writable + " SET label='pending' WHERE id=1", true);
    await api.configureConsoleSession(manual.sessionId, { autocommit: false });
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    assert.equal(api.results().at(-1).result.state.inTransaction, true);
    assert.equal((await raw.query('SELECT label FROM ' + names.writable + ' WHERE id=1'))[0][0].label, 'allowed');
    await api.controlConsoleSession(manual.sessionId, 'rollback');
    assert.equal((await raw.query('SELECT label FROM ' + names.writable + ' WHERE id=1'))[0][0].label, 'allowed');
    const explicit = await document('UPDATE ' + names.writable + " SET label='explicit' WHERE id=1", true);
    await api.controlConsoleSession(explicit.sessionId, 'begin');
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    assert.equal(api.results().at(-1).result.state.inTransaction, true);
    assert.equal((await raw.query('SELECT label FROM ' + names.writable + ' WHERE id=1'))[0][0].label, 'allowed');
    await api.controlConsoleSession(explicit.sessionId, 'commit');
    assert.equal((await raw.query('SELECT label FROM ' + names.writable + ' WHERE id=1'))[0][0].label, 'explicit');
    const unrelated = await query('UPDATE ' + names.writable + ' SET id=2 WHERE id=1', true);
    assert.equal(unrelated.result.affectedRows, 1);
    assert.equal((await raw.query('SELECT id FROM ' + names.unrelated))[0][0].id, 2);
    assert.deepEqual(await probe(), originalSpring);
    checks.writeProtection = { profileConnectionLock: true, tableGridLock: true, directDmlRejected: true,
      rejectedJoinedMutation: true, rejectedScriptBeforeWrites: true, rejectedObservedTrigger: true,
      rejectedObservedCascade: true, rejectedRoutineInWriteMode: true, serverReadOnlyDeniedRoutineWrite: true,
      tabularReadsUseReadOnlySession: true, unrelatedWriteSucceeded: true, policyExportVersion: 4,
      rejectedActivePolicyEdit: true, rejectedDatabaseWideWrites: true, transitiveCascadeRefused: true,
      concurrentTriggerAndDependencyDdlBlocked: true, autocommitReleasedPins: true, manualRollbackPreserved: true,
      explicitCommitPreserved: true, unrelatedCascadeAllowed: true, spring: originalSpring };
  } finally {
    try {
      for (const id of sessions) await api.closeConsoleSession(id).catch(() => {});
      await api.connectMysql(config);
      for (const id of profiles) {
        const current = manager.list().find(record => record.id === id);
        if (current) await manager.remove({ id, expectedRevision: current.revision });
      }
      await raw.query('DROP FUNCTION IF EXISTS ' + routine);
      for (const name of Object.values(names).reverse()) await raw.query('DROP TABLE IF EXISTS ' + name);
    } finally { await raw.end(); }
  }
}

module.exports = { runWriteProtectionChecks };
