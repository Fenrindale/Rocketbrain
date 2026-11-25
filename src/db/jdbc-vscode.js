'use strict';

const { randomUUID } = require('node:crypto');
const { createJdbcProfiles } = require('./jdbc-profiles');

const language = 'rocketbrain-jdbc';
const scheme = 'rocketbrain-jdbc-output';

function registerJdbc(vscode, context) {
  const api = createJdbcProfiles({ state: context.workspaceState, isTrusted: () => vscode.workspace.isTrusted,
    getJavaHome: () => vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome') });
  const output = new Map();
  const command = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand('rocketbrain.jdbc.' + name, async () => {
    try { return await fn(); }
    catch (cause) {
      if (cause.code !== 'ROCKETBRAIN_JDBC_CANCELLED') await vscode.window.showErrorMessage('Rocketbrain JDBC: ' + cause.message);
    } finally { void vscode.commands.executeCommand('setContext', 'rocketbrain.jdbcConnected', Boolean(api.active())); }
  }));
  context.subscriptions.push(api, vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) { return output.get(uri.path.split('/')[1]) || 'This JDBC result has expired.'; }
  }));

  async function show(title, value) {
    const id = randomUUID();
    while (output.size >= 8) output.delete(output.keys().next().value);
    output.set(id, JSON.stringify(value, null, 2));
    const uri = vscode.Uri.from({ scheme, path: '/' + id + '/' + title + '.json' });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    return value;
  }

  function progress(title, action) {
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true }, async (_, cancellation) => {
      const controller = new AbortController(), stop = cancellation.onCancellationRequested(() => controller.abort());
      if (cancellation.isCancellationRequested) controller.abort();
      try { return await action(controller.signal); }
      finally { stop.dispose(); }
    });
  }

  command('addDriver', async () => {
    api.list();
    const [jar] = await vscode.window.showOpenDialog({ title: 'Select an Installed JDBC Driver JAR', filters: { JDBC: ['jar'] } }) || [];
    if (jar?.scheme !== 'file' || jar.authority) return;
    const name = await vscode.window.showInputBox({ title: 'JDBC Profile Name' });
    if (name === undefined) return;
    const driverClass = await vscode.window.showInputBox({ title: 'Fully Qualified JDBC Driver Class',
      placeHolder: 'org.mariadb.jdbc.Driver' });
    if (driverClass === undefined) return;
    const plan = await progress('Reviewing JDBC Driver JAR', signal => api.prepare({ name, jar: jar.fsPath, driverClass }, { signal }));
    const approve = 'Approve Driver';
    if (await vscode.window.showWarningMessage('Allow this JDBC driver to execute under your user account?',
      { modal: true, detail: [plan.jar, plan.driverClass, 'SHA-256 ' + plan.sha256,
        'Only use a driver you trust. The driver runs in a separate JVM with your account permissions and the supplied connection credentials.'].join('\n') }, approve) !== approve) return;
    return api.save(plan.id, true);
  });
  command('profiles', async () => {
    const items = api.list();
    if (!items.length) throw Error('Add and approve a JDBC driver first.');
    const picked = await vscode.window.showQuickPick(items.map(item => ({ item, label: item.name, description: item.driverClass })), { title: 'Approved JDBC Profiles' });
    if (!picked) return;
    const choice = await vscode.window.showQuickPick(['Open connection', 'Remove approval'], { title: picked.label });
    if (choice === 'Remove approval') {
      if (await vscode.window.showWarningMessage('Remove JDBC approval for ' + picked.label + '?', { modal: true }, 'Remove Approval') === 'Remove Approval') {
        await api.remove(picked.item.id);
      }
      return;
    }
    if (choice !== 'Open connection') return;
    const url = await vscode.window.showInputBox({ title: 'JDBC Connection URL', password: true });
    if (url === undefined) return;
    const user = await vscode.window.showInputBox({ title: 'JDBC User Name' });
    if (user === undefined) return;
    const password = await vscode.window.showInputBox({ title: 'JDBC Password', password: true });
    if (password === undefined) return;
    const catalog = await progress('Opening JDBC Connection', signal => api.open(picked.item.id, { url, user, password }, { signal }));
    await vscode.window.showInformationMessage('Opened ' + picked.label + ' · ' + catalog.connection.product + '.');
    return catalog;
  });
  command('newQuery', async () => {
    if (!api.active()) throw Error('Open a saved JDBC connection first.');
    const document = await vscode.workspace.openTextDocument({ language, content: 'SELECT 1;\n' });
    await vscode.window.showTextDocument(document);
    return document.uri.toString();
  });
  command('run', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== language) throw Error('Open a JDBC query editor first.');
    const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    return show('query-results', await progress('Running JDBC Query', signal => api.query(sql, { signal })));
  });
  command('browse', async () => {
    const catalog = api.catalog();
    const rows = catalog.objects.map((item, index) => ({ index, label: [item.catalog, item.schema, item.name].filter(Boolean).join('.'), description: item.kind }));
    const selected = await vscode.window.showQuickPick(rows, { title: 'Browse JDBC Tables and Views',
      placeHolder: catalog.truncated ? 'First 500 objects from the driver' : undefined });
    if (!selected) return;
    return show('table-columns', await progress('Inspecting JDBC Columns', signal => api.describe(selected.index, { signal })));
  });
  command('close', () => { api.close(); output.clear(); });
  return api;
}

module.exports = { registerJdbc };
