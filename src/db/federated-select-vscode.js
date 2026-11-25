'use strict';

const { randomUUID } = require('node:crypto');
const { parseFederatedSelect, isFederatedDocument, templateHeader } = require('./federated-select');

const { promptProfileCredentials } = require('./connection-profiles-vscode');

const scheme = 'rocketbrain-federated-result';
const newQuery = 'rocketbrain.db.newFederatedSelect';
const runQuery = 'rocketbrain.db.runFederatedSelect';

function registerFederatedSelect(vscode, connections) {
  const documents = new Map();
  let disposed = false;

  function guard() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace to query saved database profiles.');
  }

  async function choose(source, excluded) {
    guard();
    const candidates = connections.list().filter(item => item.id !== excluded);
    if (!candidates.length) throw Error('Save two connection profiles before running a federated SELECT.');
    const chosen = await vscode.window.showQuickPick(candidates.map(record => ({ label: record.profile.name,
      description: record.profile.database, record })), { title: 'Choose database profile for ' + source, ignoreFocusOut: true });
    if (!chosen) return null;
    const { id, revision } = chosen.record;
    const credentials = await promptProfileCredentials(vscode,chosen.record);
    return credentials ? { id, revision, ...credentials } : null;
  }

  async function run(request) {
    guard();
    return connections.federatedSelect(request);
  }

  async function show(result) {
    guard();
    const tag = randomUUID();
    while (documents.size >= 4) documents.delete(documents.keys().next().value);
    documents.set(tag, JSON.stringify(result, null, 2));
    const uri = vscode.Uri.from({ scheme, path: `/${tag}/Federated Result.json` });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    return uri;
  }

  const subscriptions = [vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) { return disposed || !vscode.workspace.isTrusted ? '' : documents.get(uri.path.split('/')[1]) || ''; }
  })];
  const command = (name, action) => subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { guard(); return await action(); }
    catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));

  command(newQuery, async () => {
    const content = templateHeader + '\n' +
      'SELECT a.id AS source_id, b.name AS matched_name\n' +
      'FROM source1.table_a AS a\n' +
      'LEFT JOIN source2.table_b AS b ON a.id = b.id\n' +
      'LIMIT 100;\n';
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(document, { preview: false });
    return document.uri;
  });

  command(runQuery, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') throw Error('Open the SQL source or create a federated SELECT.');
    const { document, selection } = editor;
    const sql = document.getText(selection.isEmpty ? undefined : selection);
    parseFederatedSelect(sql);
    const version = document.version;
    const first = await choose('source1');
    if (!first) return;
    const second = await choose('source2', first.id);
    if (!second) return;
    if (document.isClosed || document.version !== version) throw Error('The federated SQL changed while selecting profiles. Run the current query again.');
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Reading the two database sources' }, () => run({ sql, sources: [first, second] }));
    await show(result);
    return result;
  });

  return { run, show, isFederatedDocument, dispose() {
    disposed = true;
    documents.clear();
    for (const item of subscriptions) item.dispose();
  } };
}

module.exports = { registerFederatedSelect };
