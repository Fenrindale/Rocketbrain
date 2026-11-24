'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function runDbSessionToolsChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const springUrl = new URL(runtime.baseUrl);
  assert.equal(springUrl.hostname, '127.0.0.1');
  const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
  const checkSpring = async () => {
    const response = await fetch(new URL('/probe/testing-state', springUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springIsolation);
  };

  const tools = api.dbSessionTools;
  assert.ok(tools);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['rocketbrain.setTransactionIsolation', 'rocketbrain.sql.saveQuery', 'rocketbrain.sql.savedQueries']) {
    assert.ok(commands.includes(command));
  }
  await api.connectMysql(config);
  await checkSpring();
  const namedQueries = [];
  let draftId;
  const title = 'Spring isolation proof ' + randomUUID().slice(0, 8);
  const source = 'SELECT COUNT(*) AS n FROM rb_spring_person;';
  try {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 7;\n' + source });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), document.positionAt(document.getText().length));
    const first = await tools.inspectConsoleIsolation(document);
    const otherDocument = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT CONNECTION_ID();' });
    const other = await tools.inspectConsoleIsolation(otherDocument);
    assert.notEqual(first.connectionId, other.connectionId);

    const values = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];
    let observed = first;
    for (const level of values) {
      observed = await tools.setConsoleIsolation(document, level, observed);
      assert.equal(observed.transactionIsolation, level);
      assert.equal(observed.connectionId, first.connectionId);
      assert.equal(observed.readOnly, true);
      assert.equal(observed.autocommit, true);
      assert.equal((await tools.inspectConsoleIsolation(otherDocument)).transactionIsolation, other.transactionIsolation);
    }
    const marker = await tools.inspectConsoleIsolation(document);
    await api.controlConsoleSession(first.id, 'begin');
    await assert.rejects(tools.setConsoleIsolation(document, 'READ COMMITTED', marker), /active or uncertain/);
    assert.equal((await tools.inspectConsoleIsolation(document)).inTransaction, true);
    await api.controlConsoleSession(first.id, 'rollback');
    await vscode.commands.executeCommand('rocketbrain.openTable', 'rb_spring_person');
    const table = api.results().at(-1);
    assert.equal(table.state, 'done');
    assert.ok(table.result.edit?.modelId);
    draftId = table.id;
    const flagDraft = (count, draftRevision) => api.tableAction(table.id, { type: 'draftChanged', count, draftRevision, modelId: table.result.edit.modelId });
    await flagDraft(1, 1);
    await assert.rejects(tools.setConsoleIsolation(document, 'READ COMMITTED', marker), /pending table drafts/);
    assert.equal(api.results().find(result => result.id === table.id).hasDraft, true);
    await flagDraft(0, 2);
    draftId = undefined;
    await tools.setConsoleIsolation(document, 'READ COMMITTED', marker);
    await assert.rejects(tools.setConsoleIsolation(document, 'REPEATABLE READ', marker), /changed after the picker/);
    const selectedEditor = await vscode.window.showTextDocument(document);
    selectedEditor.selection = editor.selection;
    const saved = await tools.saveQuery(title, selectedEditor);
    namedQueries.push(saved.id);
    const favorite = await tools.updateSavedQuery(saved.id, saved.revision, { favorite: true, name: title + ' favorite' });
    assert.deepEqual(tools.listSavedQueries().find(query => query.id === saved.id), favorite);
    assert.equal(Object.hasOwn(favorite, 'sql'), false);
    await assert.rejects(tools.deleteSavedQuery(saved.id, saved.revision), /changed/);
    const open = await tools.openSavedQuery(favorite.id, favorite.revision);
    const opened = await vscode.workspace.openTextDocument(vscode.Uri.parse(open.documentUri));
    assert.equal(opened.getText(), source);
    assert.equal(open.resultId, undefined);
    const target = api.savedQueryTarget(), before = api.results().map(result => result.id);
    await assert.rejects(tools.openSavedQuery(favorite.id, favorite.revision, { ...target, connectionEpoch: target.connectionEpoch - 1 }), /active database changed/);
    assert.deepEqual(api.results().map(result => result.id), before);
    const run = await tools.openSavedQuery(favorite.id, favorite.revision, target);
    const result = api.results().find(record => record.id === run.resultId);
    assert.equal(result.state, 'done');
    assert.equal(result.readOnly, true);
    assert.notEqual(result.sessionId, first.id);
    assert.notEqual(result.sessionState.connectionId, first.connectionId);
    assert.deepEqual(result.result.rows, [['2']]);
    const writeDocument = await vscode.workspace.openTextDocument({ language: 'sql', content: 'UPDATE rb_spring_person SET id = id WHERE 1 = 0;' });
    const writeEditor = await vscode.window.showTextDocument(writeDocument);
    const write = await tools.saveQuery(title + ' write', writeEditor);
    namedQueries.push(write.id);
    const refused = await tools.openSavedQuery(write.id, write.revision, target);
    const refusal = api.results().find(record => record.id === refused.resultId);
    assert.equal(refusal.state, 'error');
    assert.match(refusal.error, /read.only/i);
    await checkSpring();
    checks.push('Four server-confirmed isolation levels stayed within one VS Code SQL console. The peer console, active transaction and pending data draft retained their state.');
    checks.push('Saved SQL selected in the editor could be favorited, renamed, opened and rerun in a new read-only console. Both database and query revision changes were refused.');
    checks.push('The saved query read the actual Spring entity table. The read-only rerun refused a saved UPDATE and the Spring JDBC fixture was unchanged.');
    return { levels: values, peerIsolated: true, activeTransactionRefused: true, pendingDraftPreserved: true,
      staleIsolationRefused: true, savedQuery: { favoritePersisted: true, exactSelectionOpened: true,
        staleRevisionRefused: true, staleDestinationRefused: true, freshReadOnlySession: true,
        rerunRows: result.result.rows.length, writeRefused: true }, springIsolation };
  } finally {
    if (draftId !== undefined) {
      const record = api.results().find(result => result.id === draftId);
      if (record?.hasDraft) await api.tableAction(draftId, { type: 'draftChanged', count: 0,
        modelId: record.result.edit.modelId, draftRevision: record.draftRevision + 1 });
    }
    for (const id of namedQueries) {
      const record = tools.listSavedQueries().find(query => query.id === id);
      if (record) await tools.deleteSavedQuery(id, record.revision);
    }
    for (const session of api.sessions()) await api.closeConsoleSession(session.id);
  }
}

module.exports = { runDbSessionToolsChecks };
