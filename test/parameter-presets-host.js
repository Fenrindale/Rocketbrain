'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runParameterPresetChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owned = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owned.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  const raw = await mysql.createConnection(config);
  const marker = randomBytes(5).toString('hex'), table = 'rb_preset_' + marker;
  const source = 'SELECT label FROM ' + table + ' WHERE id=:exactId;';
  const stamp = '9007199254740993', label = 'owned preset ' + marker, exact = '1234567890123456789.123456';
  const sqlScripts = api.sqlScripts, saved = [], sessions = new Set();
  let alternateProfile;
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    return response.json();
  };
  async function describe(sql, writable = false) {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    await vscode.window.showTextDocument(document, { preview: false });
    if (writable) {
      const opened = await api.describeSqlScript('SELECT 1', { document });
      sessions.add(opened.sessionId);
      await api.configureConsoleSession(opened.sessionId, { readOnly: false });
    }
    const result = await sqlScripts.describe(document);
    sessions.add(result.sessionId);
    return result;
  }
  const preset = async (description, name, parameters) => {
    const created = await sqlScripts.savePreset(description.id, name, parameters);
    saved.push(created.id);
    return created;
  };
  try {
    const initial = await probe();
    assert.deepEqual(initial, { people: 2, departments: 1, rolledBackNames: 0 });
    await raw.query('CREATE TABLE ' + table + ' (id BIGINT PRIMARY KEY, label VARCHAR(64), amount DECIMAL(30,6)) ENGINE=InnoDB');
    await raw.execute('INSERT INTO ' + table + ' VALUES (?,?,?)', [stamp, label, exact]);
    await api.connectMysql(config);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.sql.saveParameterPreset'));
    assert.ok(commands.includes('rocketbrain.sql.removeParameterPreset'));

    const original = await describe(source);
    assert.equal(original.parameterHints[0].kind, 'integer');
    assert.equal(original.parameterHints[0].column, 'id');
    const before = api.results().length;
    const named = await preset(original, 'Exact Spring fixture ID', { exactId: { kind: 'integer', value: stamp } });
    assert.deepEqual(Object.keys(named).sort(), ['id', 'name']);
    assert.equal(api.results().length, before);

    await api.connectMysql(config);
    const reopened = await describe(source);
    assert.notEqual(reopened.connectionEpoch, original.connectionEpoch);
    assert.deepEqual(sqlScripts.matchingPresets(reopened.id), [named]);
    const plan = await sqlScripts.previewPreset(reopened.id, named.id);
    assert.equal(plan.savedPreset, named.name);
    assert.equal(JSON.stringify(plan).includes(stamp), false);
    await assert.rejects(sqlScripts.run(plan.id), /Approve the reviewed script/);
    assert.equal(api.results().length, before);
    const result = await sqlScripts.run(plan.id, { approvePreset: true });
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.statements[0].result.rows, [[label]]);

    const edited = await describe(source.replace(':exactId', ':anotherId'));
    assert.deepEqual(sqlScripts.matchingPresets(edited.id), []);
    await assert.rejects(sqlScripts.previewPreset(edited.id, named.id), /does not match/);
    const exactTextChanged = await describe(source + ' ');
    assert.deepEqual(sqlScripts.matchingPresets(exactTextChanged.id), []);

    alternateProfile = await api.dbConnections.save({ profile: { name: 'Preset scope ' + marker, host: config.host,
      port: config.port, user: config.user, database: config.database }, verify: false });
    await api.dbConnections.connect({ id: alternateProfile.id, password: config.password });
    const other = await describe(source);
    assert.notEqual(other.parameterScope, original.parameterScope);
    assert.deepEqual(sqlScripts.matchingPresets(other.id), []);
    await api.connectMysql(config);

    const writable = await describe('INSERT INTO ' + table + ' (id,label,amount) VALUES (?,?,?);', true);
    assert.deepEqual(writable.parameterHints.map(hint => hint.kind), ['integer', 'text', 'decimal']);
    const insert = await preset(writable, 'Exact insert fixture', [
      { kind: 'integer', value: '9007199254740994' }, { kind: 'text', value: label }, { kind: 'decimal', value: exact }
    ]);
    const [unwritten] = await raw.query('SELECT COUNT(*) AS n FROM ' + table);
    assert.equal(Number(unwritten[0].n), 1);
    const writePlan = await sqlScripts.previewPreset(writable.id, insert.id);
    await assert.rejects(sqlScripts.run(writePlan.id), /Approve the reviewed script/);
    assert.equal((await sqlScripts.run(writePlan.id, { approvePreset: true })).state, 'completed');
    const [inserted] = await raw.execute('SELECT amount FROM ' + table + ' WHERE id=?', ['9007199254740994']);
    assert.equal(inserted[0].amount, exact);

    const stale = await describe(source);
    const stalePlan = await sqlScripts.previewPreset(stale.id, named.id);
    await raw.query('ALTER TABLE ' + table + ' MODIFY id DECIMAL(22,0) NOT NULL');
    await assert.rejects(sqlScripts.run(stalePlan.id, { approvePreset: true }), /parameter column metadata changed/);
    const changed = await describe(source);
    assert.equal(changed.parameterHints[0].kind, 'decimal');
    assert.deepEqual(sqlScripts.matchingPresets(changed.id), []);
    assert.equal(await sqlScripts.removePreset(named.id), true);
    assert.equal(await sqlScripts.removePreset(named.id), false);
    assert.deepEqual(await probe(), initial);
    checks.parameterPresets = { namedAndPositional: true, persistedAfterReconnect: true, exactSourceAndScope: true,
      typedMetadataValidatedBeforeExecution: true, exactBigIntAndDecimal: true, privateMetadataAndReview: true,
      explicitReviewAndApproval: true, removed: true, spring: initial };
  } finally {
    try {
      for (const id of sessions) await api.closeConsoleSession(id).catch(() => {});
      for (const id of saved) await sqlScripts.removePreset(id).catch(() => {});
      await api.connectMysql(config);
      if (alternateProfile) await api.dbConnections.remove({ id: alternateProfile.id, expectedRevision: alternateProfile.revision });
      await raw.query('DROP TABLE IF EXISTS ' + table);
    } finally { await raw.end(); }
  }
}

module.exports = { runParameterPresetChecks };
