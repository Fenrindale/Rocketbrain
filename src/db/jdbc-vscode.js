'use strict';

const { randomUUID } = require('node:crypto');
const { createJdbcProfiles } = require('./jdbc-profiles');
const { maxLibraries } = require('./jdbc');
const { postgresqlRoute } = require('./postgresql-jdbc');

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

  async function driverDraft(title, postgres) {
    const [jar] = await vscode.window.showOpenDialog({ title: 'Select an Installed JDBC Driver JAR', filters: { JDBC: ['jar'] } }) || [];
    if (jar?.scheme !== 'file' || jar.authority) return;
    const name = await vscode.window.showInputBox({ title });
    if (name === undefined) return;
    const driverClass = postgres ? 'org.postgresql.Driver' : await vscode.window.showInputBox({ title: 'Fully Qualified JDBC Driver Class',
      placeHolder: 'org.mariadb.jdbc.Driver' });
    if (driverClass === undefined) return;
    const kind = await vscode.window.showQuickPick(['No additional JARs', 'Select additional libraries'], { title: 'Optional JDBC Libraries' });
    if (!kind) return;
    let libraries = [];
    if (kind === 'Select additional libraries') {
      const files = await vscode.window.showOpenDialog({ title: 'Select up to ' + maxLibraries + ' Local Library JARs',
        canSelectMany: true, filters: { JAR: ['jar'] } });
      if (!files?.length || files.some(item => item.scheme !== 'file' || item.authority)) return;
      libraries = files.map(item => item.fsPath);
    }
    return { name, jar: jar.fsPath, driverClass, libraries };
  }

  async function choosePostgreSqlRoute() {
    const host = await vscode.window.showInputBox({ title: 'PostgreSQL Host', value: '127.0.0.1' });
    if (host === undefined) return;
    const port = await vscode.window.showInputBox({ title: 'PostgreSQL Port', value: '5432' });
    if (port === undefined) return;
    const database = await vscode.window.showInputBox({ title: 'PostgreSQL Database', value: 'postgres' });
    if (database === undefined) return;
    const schema = await vscode.window.showInputBox({ title: 'PostgreSQL Schema', value: 'public' });
    if (schema === undefined) return;
    const loopback = 'Loopback TCP without TLS';
    const verify = 'Verify TLS certificate and hostname';
    const choice = await vscode.window.showQuickPick(['127.0.0.1', '::1'].includes(host.trim()) ? [verify, loopback] : [verify],
      { title: 'PostgreSQL Transport' });
    if (!choice) return;
    let ca;
    if (choice === verify) {
      const [file] = await vscode.window.showOpenDialog({ title: 'Select PostgreSQL Root CA Certificate', filters: { PEM: ['pem', 'crt'] } }) || [];
      if (file?.scheme !== 'file' || file.authority) return;
      ca = file.fsPath;
    }
    return postgresqlRoute({ host: host.trim(), port: Number(port), database: database.trim(), schema: schema.trim(),
      tls: choice === loopback ? 'loopback' : 'verify-full', ca });
  }

  async function approve(plan) {
    const action = 'Approve Exact JARs';
    const identity = [plan, ...plan.libraries].map((item, index) =>
      (index ? 'Library ' + index : 'Driver') + ' · ' + item.jar + '\nSHA-256 ' + item.sha256);
    return await vscode.window.showWarningMessage('Allow these JDBC artifacts to execute under your account?',
      { modal: true, detail: [plan.driverClass, 'Classpath SHA-256 ' + plan.classpathFingerprint,
        ...identity, 'Use artifacts you trust. The JVM uses your account permissions and the credentials you supply.'].join('\n\n') }, action) === action;
  }

  async function manageVersions(profile) {
    const picked = await vscode.window.showQuickPick([{ label: 'Add Driver Version', add: true }, ...profile.versions.map(item => ({
      item, label: item.name, description: (item.id === profile.selectedVersion ? 'Selected · ' : '') + item.libraries.length + ' libraries · ' + item.classpathFingerprint.slice(0, 12),
      detail: item.jar
    }))], { title: profile.name + ' · Driver Versions' });
    if (!picked) return;
    if (picked.add) {
      const draft = await driverDraft('Driver Version Name', Boolean(profile.postgresql));
      if (!draft) return;
      const plan = await progress('Reviewing JDBC Version and Libraries', signal => api.prepareVersion(profile.id, draft, { signal }));
      if (await approve(plan)) return api.saveVersion(plan.id, true);
      return;
    }
    if (picked.item.id === profile.selectedVersion) return;
    const action = await vscode.window.showQuickPick(['Select version', 'Remove version approval'], { title: picked.label });
    if (action === 'Select version') return api.selectVersion(profile.id, picked.item.id);
    if (action === 'Remove version approval' && await vscode.window.showWarningMessage('Remove approval for ' + picked.label + '?',
      { modal: true }, 'Remove Version') === 'Remove Version') return api.removeVersion(profile.id, picked.item.id);
  }

  command('addDriver', async () => {
    api.list();
    const kind = await vscode.window.showQuickPick(['PostgreSQL', 'Other JDBC driver'], { title: 'Database Driver Kind' });
    if (!kind) return;
    const draft = await driverDraft('JDBC Profile Name', kind === 'PostgreSQL');
    if (!draft) return;
    if (kind === 'PostgreSQL') {
      draft.postgresql = await choosePostgreSqlRoute();
      if (!draft.postgresql) return;
    }
    const plan = await progress('Reviewing JDBC Driver JARs', signal => api.prepare(draft, { signal }));
    if (await approve(plan)) return api.save(plan.id, true);
  });
  command('profiles', async () => {
    const items = api.list();
    if (!items.length) throw Error('Add and approve a JDBC driver first.');
    const picked = await vscode.window.showQuickPick(items.map(item => ({ item, label: item.name,
      description: item.versions.find(entry => entry.id === item.selectedVersion).name + ' · ' + item.driverClass })), { title: 'Approved JDBC Profiles' });
    if (!picked) return;
    const choice = await vscode.window.showQuickPick(['Open connection', 'Manage driver versions', 'Remove approval'], { title: picked.label });
    if (choice === 'Manage driver versions') return manageVersions(picked.item);
    if (choice === 'Remove approval') {
      if (await vscode.window.showWarningMessage('Remove JDBC approval for ' + picked.label + '?', { modal: true }, 'Remove Approval') === 'Remove Approval') {
        await api.remove(picked.item.id);
      }
      return;
    }
    if (choice !== 'Open connection') return;
    const url = picked.item.postgresql ? '' : await vscode.window.showInputBox({ title: 'JDBC Connection URL', password: true });
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
