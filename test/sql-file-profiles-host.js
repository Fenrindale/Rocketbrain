'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { registerDatabaseWorkbench } = require('../src/database-workbench');
const { identifyConnection } = require('../src/db/connection-security');
const { owned } = require('./schema-stored-diff-host');

const discard = { dispose() {} }, noop = () => discard;
class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
class Tree { refresh() {} dispose() {} }

function workstation(folder, values) {
  const routes = new Map(), providers = new Map(), errors = [], warnings = [], editors = [];
  const active = new EventEmitter(), closed = new EventEmitter();
  const state = { get: (key, fallback) => values.get(key) ?? fallback, async update(key, value) { values.set(key, structuredClone(value)); } };
  const uri = address => ({ scheme: address.protocol.slice(0, -1), path: decodeURIComponent(address.pathname),
    fsPath: address.protocol === 'file:' ? fileURLToPath(address) : undefined, toString: () => address.href });
  const vscode = {
    EventEmitter, FileChangeType: { Created: 1, Changed: 2, Deleted: 3 }, FileType: { Directory: 2, File: 1 },
    StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
    Uri: { file: file => uri(pathToFileURL(file)), from: value => uri(new URL(value.scheme + ':' + value.path)) },
    commands: { registerCommand(id, run) { routes.set(id, run); return discard; },
      async executeCommand(id, ...args) { return routes.get(id)?.(...args); } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: uri(pathToFileURL(folder)) }], textDocuments: [],
      getWorkspaceFolder: value => value?.fsPath && path.dirname(value.fsPath) === folder ? {} : undefined,
      asRelativePath: value => path.relative(folder, value.fsPath),
      registerFileSystemProvider(scheme, provider) { providers.set(scheme, provider); return discard; },
      registerTextDocumentContentProvider: noop, onDidCloseTextDocument: closed.event, onDidChangeTextDocument: noop,
      onDidChangeWorkspaceFolders: noop, onDidCreateFiles: noop, onDidDeleteFiles: noop, onDidRenameFiles: noop,
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      async openTextDocument(address) {
        const present = this.textDocuments.find(item => !item.isClosed && item.uri.toString() === address.toString());
        if (present) return present;
        const opening = { uri: address, version: 1, languageId: 'sql', isClosed: false,
          text: address.scheme === 'file' ? await fs.readFile(address.fsPath, 'utf8') : Buffer.from(providers.get(address.scheme).readFile(address)).toString('utf8'),
          getText(selection) { return selection ? this.text.slice(selection.start, selection.end) : this.text; }, offsetAt(position) { return position; } };
        this.textDocuments.push(opening);
        return opening;
      }
    },
    languages: { registerCompletionItemProvider: noop },
    window: {
      visibleTextEditors: editors, onDidChangeActiveTextEditor: active.event, onDidChangeTextEditorSelection: noop,
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }), createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerTreeDataProvider: noop, registerWebviewViewProvider: noop,
      tabGroups: { onDidChangeTabs: noop, get all() { return editors.filter(editor => !editor.document.isClosed)
        .map(editor => ({ viewColumn: editor.viewColumn, tabs: [{ input: { uri: editor.document.uri } }] })); } },
      async showTextDocument(document) {
        let editor = editors.find(item => item.document === document);
        if (!editor) { editor = { document, viewColumn: editors.length + 1, selection: { isEmpty: true, active: 0 } }; editors.push(editor); }
        this.activeTextEditor = editor;
        active.fire(editor);
        return editor;
      },
      async showWarningMessage(message, options, choice) { warnings.push({ message, ...options }); return this.approve === false ? undefined : choice; },
      async showErrorMessage(message) { errors.push(message); },
      async showQuickPick(items) { return items.find(item => item.target?.sessionId === this.targetSession); }
    }
  };
  const context = { workspaceState: state, subscriptions: [] };
  return { vscode, context, errors, warnings, async run(id, ...args) {
    assert.ok(routes.has(id));
    return vscode.commands.executeCommand(id, ...args);
  }, close(document) {
    document.isClosed = true;
    closed.fire(document);
    vscode.workspace.textDocuments = vscode.workspace.textDocuments.filter(candidate => candidate !== document);
  } };
}

async function verifySqlFileProfiles(mysqlSpring, mariaSpring) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const runtime = await Promise.all([read(mysqlSpring.configPath), read(mariaSpring.configPath)]);
  assert.deepEqual(runtime.map(item => item.dbEngine), ['mysql', 'mariadb']);
  const original = 'SELECT VERSION(),label FROM rb_profile_file WHERE id=1 AND SLEEP(0.25)=0;\n';
  const context = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-sql-file-fixture-'));
  const files = ['mysql.sql', 'mariadb.sql'].map(name => path.join(context, name));
  const values = new Map(), databases = [], instances = [];
  const profiles = ['MySQL fixture', 'MariaDB fixture'].map(name => ({ id: randomUUID(), name }));
  async function host() {
    const shell = workstation(context, values);
    const api = await registerDatabaseWorkbench(shell.context, shell.vscode, Tree, Tree);
    instances.push({ api, ...shell });
    const documents = await Promise.all(files.map(file => shell.vscode.workspace.openTextDocument(shell.vscode.Uri.file(file))));
    return { ...shell, api, documents };
  }
  async function execute(shell, document, sql = original) {
    document.text = sql;
    document.version++;
    await shell.vscode.window.showTextDocument(document);
    return shell.run('rocketbrain.runQuery');
  }
  const response = (api, id) => {
    const row = api.results().find(result => result.id === id);
    assert.ok(row?.result, row?.error || 'No result for the requested SQL file.');
    return row;
  };
  const assertSpring = async () => Promise.all(runtime.map(async item => {
    const url = new URL('/probe/testing-state', item.baseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { people: 2, departments: 1, rolledBackNames: 0 });
  }));
  try {
    for (const [index, item] of runtime.entries()) {
      const fixture = await owned(item.dbConfigPath);
      databases.push(fixture);
      await fixture.actor.query('CREATE TABLE rb_profile_file (id INT PRIMARY KEY,label VARCHAR(40)) ENGINE=InnoDB');
      await fixture.actor.execute('INSERT INTO rb_profile_file VALUES (1,?)', [profiles[index].name]);
      await fs.writeFile(files[index], original, { flag: 'wx' });
    }
    assert.notEqual(databases[0].config.port, databases[1].config.port);
    await assertSpring();
    const first = await host(), { api, vscode, documents } = first;
    const configured = databases.map(({ config }, index) => identifyConnection(config, { ...config, password: undefined, ...profiles[index] }));
    await api.connectMysql(configured[0]);
    const opened = await Promise.all(configured.map(config => api.openProfileConsole(config)));
    const targets = opened.map((row, index) => ({ sessionId: row.sessionId, profileId: profiles[index].id }));
    for (const [index, document] of documents.entries()) {
      await vscode.window.showTextDocument(document);
      vscode.window.targetSession = targets[index].sessionId;
      assert.equal((await first.run('rocketbrain.connections.bindSqlFile')).sessionId, targets[index].sessionId);
      assert.equal(api.isProfileSql(document), true);
    }
    assert.equal(api.activeConnectionProfile().id, profiles[0].id);
    const leftRun = execute(first, documents[0]);
    await delay(10);
    const rightRun = execute(first, documents[1]);
    let concurrent = false;
    for (let attempt = 0; attempt < 10 && !concurrent; attempt++) {
      concurrent = api.profileSessionList().filter(row => row.busy).length === 2;
      if (!concurrent) await delay(5);
    }
    const results = await Promise.all([leftRun, rightRun]);
    assert.equal(concurrent, true, 'Both live sessions should have a running query.');
    for (const [index, id] of results.entries()) {
      const row = response(api, id);
      assert.equal(row.sessionId, targets[index].sessionId);
      assert.ok(row.source.includes(profiles[index].name));
      assert.deepEqual(row.result.rows, [[databases[index].version, profiles[index].name]]);
      await api.activateResult(id);
      await first.run('rocketbrain.focusQueryEditor');
      assert.equal(vscode.window.activeTextEditor.document, documents[index]);
    }
    assert.equal(first.errors.length, 0);
    assert.deepEqual(await fs.readFile(files[0], 'utf8'), original);
    assert.deepEqual(await fs.readFile(files[1], 'utf8'), original);

    await assert.rejects(api.changeSqlFileProfile(documents[0], targets[1], async () => {
      await api.configureConsoleSession(targets[1].sessionId, { readOnly: false, autocommit: false });
      return true;
    }), /selected database session changed/);
    await api.controlConsoleSession(targets[1].sessionId, 'begin');
    response(api, await execute(first, documents[1], "UPDATE rb_profile_file SET label='pending' WHERE id=1;"));
    assert.deepEqual(response(api, await execute(first, documents[1])).result.rows, [[databases[1].version, 'pending']]);
    assert.deepEqual(response(api, await execute(first, documents[0])).result.rows, [[databases[0].version, profiles[0].name]]);
    await api.controlConsoleSession(targets[1].sessionId, 'rollback');
    assert.deepEqual(await databases[1].actor.query('SELECT label FROM rb_profile_file').then(([rows]) => rows), [{ label: profiles[1].name }]);

    first.close(documents[1]);
    const peerDocument = await vscode.workspace.openTextDocument(documents[1].uri);
    assert.equal(response(api, await execute(first, peerDocument)).sessionId, targets[1].sessionId);
    await api.closeProfileSession(targets[1], () => true);
    assert.equal(await execute(first, peerDocument), undefined);
    assert.match(first.errors.pop(), /profile session is closed/);
    await assert.rejects(api.describeSqlScript('SELECT 1', { document: peerDocument }), /uses the active database/);
    await api.activateResult(results[1]);
    await first.run('rocketbrain.focusQueryEditor');
    assert.match(first.errors.pop(), /no longer uses this result/);
    await api.dispose();

    const reopened = await host();
    await reopened.api.connectMysql(configured[0]);
    assert.equal(reopened.api.isProfileSql(reopened.documents[1]), true);
    assert.equal(await execute(reopened, reopened.documents[1]), undefined);
    assert.match(reopened.errors.pop(), /profile session is closed/);
    const peer = await reopened.api.openProfileConsole(configured[1]);
    await reopened.vscode.window.showTextDocument(reopened.documents[1]);
    reopened.vscode.window.targetSession = peer.sessionId;
    assert.equal((await reopened.run('rocketbrain.connections.bindSqlFile')).sessionId, peer.sessionId);
    assert.deepEqual(response(reopened.api, await execute(reopened, reopened.documents[1])).result.rows,
      [[databases[1].version, profiles[1].name]]);
    reopened.vscode.window.approve = false;
    assert.equal((await reopened.run('rocketbrain.connections.forgetSqlFile')).state, 'retained');
    assert.equal(reopened.api.isProfileSql(reopened.documents[1]), true);
    reopened.vscode.window.approve = true;
    assert.equal((await reopened.run('rocketbrain.connections.forgetSqlFile')).state, 'forgotten');
    assert.deepEqual(response(reopened.api, await execute(reopened, reopened.documents[1])).result.rows,
      [[databases[0].version, profiles[0].name]]);
    await assertSpring();
    return { engines: databases.map(item => item.version), simultaneous: true, savedFiles: 2, exactResultEditor: true,
      fileTextUnchanged: true, peerTransactionAndRollback: true, dedicatedScriptGuard: true, oldResultEditorRefused: true,
      persistedGuardAcrossWorkbenchReload: true, reviewedReattach: true, modeDriftDuringReviewRefused: true,
      explicitRemovalRequiredForActiveFallback: true, actualSpringOnBoth: true };
  } finally {
    for (const instance of instances) await instance.api.dispose();
    for (const fixture of databases) {
      try { await fixture.actor.query('DROP TABLE IF EXISTS rb_profile_file'); }
      finally { await fixture.actor.end(); }
    }
    for (const file of files) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(context);
  }
}

module.exports = { verifySqlFileProfiles };
