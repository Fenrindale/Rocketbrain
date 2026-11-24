'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function runQueryHistoryChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const springUrl = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(springUrl.hostname, '127.0.0.1');
  const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
  async function verifySpring() {
    const response = await fetch(springUrl, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springIsolation);
  }

  const tools = api.dbSessionTools, profiles = api.dbConnections;
  assert.ok(tools && profiles);
  const suffix = randomBytes(5).toString('hex');
  const source = 'SELECT COUNT(*) AS entity_count FROM rb_spring_person;';
  let profile, saved;
  const editorFor = async sql => {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    return vscode.window.showTextDocument(document, { preview: false });
  };
  const runEditor = async sql => {
    await editorFor(sql);
    const result = await vscode.commands.executeCommand('rocketbrain.runQuery');
    await tools.flushQueryHistory();
    return api.results().find(record => record.id === result);
  };
  try {
    await verifySpring();
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sql.queryHistory'));
    profile = await profiles.save({ profile: { name: 'Query History ' + suffix, group: 'Native Query Fixture', color: 'blue',
      host: config.host, port: config.port, user: config.user, database: config.database,
      tls: { mode: 'disabled' }, ssh: null }, password: config.password, rememberPassword: false });
    await profiles.connect({ id: profile.id, password: config.password });
    const target = api.savedQueryTarget();
    assert.match(target.key, /^[0-9a-f]{64}$/);
    assert.equal(target.profile.id, profile.id);
    await vscode.commands.executeCommand('rocketbrain.openTable','rb_spring_person');
    const personGrid=api.results().at(-1);
    assert.equal(personGrid.result.edit.table,'rb_spring_person');
    const preferred=personGrid.result.columns.map((name,index)=>({name,hidden:false,pinned:index===0,
      ...(index===0?{width:240}:{})}));
    await api.saveResultLayout(personGrid.id,personGrid.result.edit.modelId,preferred);
    assert.deepEqual(api.savedResultLayout(personGrid.id),preferred);
    assert.equal(tools.queryHistoryEnabled(), false);
    assert.deepEqual((await runEditor(source)).result.rows, [['2']]);
    assert.deepEqual(tools.listQueryHistory(), []);
    await tools.setQueryHistoryEnabled(true);
    assert.deepEqual((await runEditor(source)).result.rows, [['2']]);
    const [entry] = tools.listQueryHistory({ search: 'entity_count', target: target.key, since: Date.now() - 60000 });
    assert.ok(entry);
    assert.equal(tools.listQueryHistory().length, 1);
    const opened = await tools.openQueryHistory(entry.id, entry.revision);
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.parse(opened.documentUri))).getText(), source);

    await vscode.commands.executeCommand('rocketbrain.openTable', 'rb_spring_person');
    assert.equal(api.results().at(-1).state, 'done');
    const parameterDocument = (await editorFor('SELECT :proof AS value;')).document;
    const prepared = await api.sqlScripts.describe(parameterDocument);
    const fixtureValue = 'parameter-only-' + suffix;
    const bound = await api.sqlScripts.preview(prepared.id, { proof: { kind: 'text', value: fixtureValue } });
    assert.equal((await api.sqlScripts.run(bound.id)).state, 'completed');
    const failed = await runEditor('SELECT id FROM rb_missing_history_' + suffix + ';');
    assert.equal(failed.state, 'error');
    await tools.flushQueryHistory();
    assert.deepEqual(tools.listQueryHistory(), [entry]);
    assert.equal(JSON.stringify(tools.listQueryHistory()).includes(config.password), false);
    assert.equal(JSON.stringify(tools.listQueryHistory()).includes(fixtureValue), false);
    const rerun = await tools.openQueryHistory(entry.id, entry.revision, target);
    const result = api.results().find(record => record.id === rerun.resultId);
    assert.equal(result.readOnly, true);
    assert.deepEqual(result.result.rows, [['2']]);
    assert.deepEqual(tools.listQueryHistory(), [entry]);
    saved = await tools.saveQuery('Spring Entities ' + suffix, await editorFor(source), { tags: ['Spring', 'Read'] });
    saved = await tools.bindSavedQuery(saved.id, saved.revision, target);
    assert.deepEqual(saved.binding, { ...target.profile, key: target.key });
    assert.deepEqual(tools.listSavedQueries({ tag: 'spring' }), [saved]);

    await api.disconnectMysql();
    const demo = api.savedQueryTarget();
    assert.notEqual(demo.key, target.key);
    await assert.rejects(tools.openSavedQuery(saved.id, saved.revision, demo), /bound profile and schema/);
    await assert.rejects(tools.openQueryHistory(entry.id, entry.revision, demo), /where this query was recorded/);
    await profiles.connect({ id: profile.id, password: config.password });
    const reconnected = api.savedQueryTarget();
    assert.equal(reconnected.key, target.key);
    assert.notEqual(reconnected.connectionEpoch, target.connectionEpoch);
    await vscode.commands.executeCommand('rocketbrain.openTable','rb_spring_person');
    const restoredGrid=api.results().at(-1);
    assert.deepEqual(api.savedResultLayout(restoredGrid.id),preferred);
    await api.saveResultLayout(restoredGrid.id,restoredGrid.result.edit.modelId,[]);
    await assert.rejects(tools.openQueryHistory(entry.id, entry.revision, target), /active database changed/);
    const namedRun = await tools.openSavedQuery(saved.id, saved.revision, reconnected);
    const namedResult = api.results().find(record => record.id === namedRun.resultId);
    assert.equal(namedResult.readOnly, true);
    assert.deepEqual(namedResult.result.rows, [['2']]);
    await tools.deleteQueryHistory(entry.id, entry.revision);
    await assert.rejects(tools.openQueryHistory(entry.id, entry.revision, reconnected), /removed, expired or changed/);
    await runEditor(source);
    assert.equal(tools.listQueryHistory().length, 1);
    await tools.clearQueryHistory();
    assert.deepEqual(tools.listQueryHistory(), []);
    await verifySpring();
    checks.push('Only successful explicit read-only editor SQL entered the opted-in native workspace history. Preview SQL, bound script inputs, errors, and reruns did not create entries.');
    checks.push('The real Spring table query was found verbatim, reran on a new read-only console, and blocked wrong database, stale connection and deleted history entry requests.');
    checks.push('Saved SQL tags and saved-profile binding worked across verified reconnection. A mismatched profile was refused and the Spring JDBC fixture remained unchanged.');
    return { optInVerified: true, originalSqlPreserved: true, parameterProvenanceExcluded: true, historyRerunReadOnly: true,
      destinationMismatchRefused: true, staleSessionRefused: true, deletedRevisionRefused: true, tagFilter: true,
      savedProfileMismatchRefused:true, savedProfileLayoutRestored:true, deleteAndClear:true, springIsolation };
  } finally {
    try {
      if (saved) {
        const current = tools.listSavedQueries().find(query => query.id === saved.id);
        if (current) await tools.deleteSavedQuery(current.id, current.revision);
      }
      await tools.setQueryHistoryEnabled(false);
      await tools.clearQueryHistory();
    } finally {
      await api.disconnectMysql();
      if (profile) await profiles.remove({ id: profile.id, expectedRevision: profile.revision });
    }
  }
}

module.exports = { runQueryHistoryChecks };
