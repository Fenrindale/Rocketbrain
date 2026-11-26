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

async function runSqlFileProfilesChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const descriptor = await fs.realpath(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const fixtureFolder = path.dirname(descriptor);
  const owner = await read(path.join(fixtureFolder, 'owner.json'));
  assert.equal(owner.kind, 'RocketbrainSpringProjectFixture-v1');
  assert.equal(owner.id, path.basename(fixtureFolder));
  const runtime = await read(descriptor);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(runtime.dbEngine, engine);
  const jdbcProbe = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(jdbcProbe.hostname, '127.0.0.1');
  assert.equal(jdbcProbe.port, String(runtime.port));
  const workspace = await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
  assert.ok(workspace.split(path.sep).includes('test-output'));
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspace));
  assert.ok(workspaceFolder, 'Open the disposable SQL test workspace before running this hook.');
  assert.equal(await fs.realpath(workspaceFolder.uri.fsPath), workspace);

  const prefix = randomUUID().replaceAll('-', '').slice(0, 12);
  const table = 'rb_sql_profile_' + prefix;
  const fixtures = [], profiles = [], targets = [], documents = [], files = [];
  const manager = api.dbConnections;
  const spring = async () => {
    const response = await fetch(jdbcProbe, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { people: 2, departments: 1, rolledBackNames: 0 });
  };
  async function open(profile) {
    const opened = await manager.openDedicatedConsole({ id: profile.id, revision: profile.revision });
    const target = { sessionId: opened.sessionId, profileId: profile.id };
    targets.push(target);
    return target;
  }
  async function bind(document, target, profile, index) {
    const approved = await api.changeSqlFileProfile(document, target, review => {
      assert.equal(path.basename(review.path), path.basename(files[index]));
      const { name, database, host, port } = profile.profile;
      assert.equal(database, 'rocketbrain_fixture');
      assert.equal(review.after, `${name} · ${database}`);
      assert.equal(review.endpoint, `${host}:${port}`);
      assert.equal(review.readOnly, true);
      assert.equal(review.inTransaction, false);
      return true;
    });
    assert.deepEqual(approved, { state: 'bound', uri: document.uri.toString(), ...target });
  }
  async function execute(document, index, target) {
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(document.getText().length));
    const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
    const row = api.results().find(item => item.id === id);
    assert.ok(row?.result, row?.error || 'The installed extension should return a result for the selected SQL file.');
    assert.equal(row.sessionId, target.sessionId);
    const { name } = profiles[index].profile;
    assert.ok(row.source.includes(name));
    assert.deepEqual(row.result.rows, [[fixtures[index].version, name]]);
    return id;
  }
  let spawned, folder;
  try {
    await spring();
    const declaredPeer = process.env.ROCKETBRAIN_SECONDARY_DB_CONFIG;
    if (!declaredPeer) spawned = engine === 'mysql' ? await require('../scripts/integration-db-fixture').startFixture() :
      await require('../scripts/integration-mysql').startMysqlFixture();
    for (const [index, configPath] of [runtime.dbConfigPath, declaredPeer || spawned.configPath].entries()) {
      const fixture = await owned(configPath);
      fixtures.push(fixture);
      assert.equal(/mariadb/i.test(fixture.version), index === 0 ? engine === 'mariadb' : engine !== 'mariadb');
      const { host, port, user, database, password } = fixture.config;
      const name = (index === 0 ? 'Primary' : 'Peer') + ' SQL file fixture ' + prefix;
      await fixture.actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, label VARCHAR(80)) ENGINE=InnoDB');
      fixture.createdTable = true;
      await fixture.actor.execute('INSERT INTO ' + table + ' VALUES (1,?)', [name]);
      profiles.push(await manager.save({ profile: { id: randomUUID(), name, host, port, user, database, tls: { mode: 'disabled' } },
        password, rememberPassword: true }));
    }
    assert.notEqual(fixtures[0].config.port, fixtures[1].config.port);
    folder = await fs.mkdtemp(path.join(workspace, 'rb-sql-file-profiles-'));
    const text = 'SELECT VERSION(), label FROM ' + table + ' WHERE id = 1;\n';
    await manager.connect({ id: profiles[0].id });
    await open(profiles[0]);
    await open(profiles[1]);
    for (const [index, profile] of profiles.entries()) {
      const file = path.join(folder, index === 0 ? 'primary.sql' : 'peer.sql');
      await fs.writeFile(file, text, { flag: 'wx' });
      files.push(file);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      documents.push(document);
      await bind(document, targets[index], profile, index);
    }

    const ids = [];
    for (const [index, document] of documents.entries()) ids.push(await execute(document, index, targets[index]));
    for (const [index, id] of ids.entries()) {
      await api.activateResult(id);
      await vscode.commands.executeCommand('rocketbrain.focusQueryEditor');
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), documents[index].uri.toString());
      assert.equal(await fs.readFile(files[index], 'utf8'), text);
    }
    assert.equal(api.activeConnectionProfile()?.id, profiles[0].id);
    const peer = documents[1];
    assert.equal((await api.closeProfileSession(targets[1], risk => risk.editorCount === 2 && !risk.inTransaction)).state, 'closed');
    assert.equal(api.isProfileSql(peer), true);
    const before = api.results().map(item => item.id);
    // This enters the same bindInteractive guard as runQuery without opening an error notification.
    await assert.rejects(api.inspectConsoleIsolation(peer), /profile session is closed/);
    await assert.rejects(api.describeSqlScript('SELECT 1', { document: peer }), /uses the active database/);
    await assert.rejects(api.changeSqlFileProfile(peer, { sessionId: targets[0].sessionId, profileId: profiles[1].id }, () => true),
      /selected profile session is no longer available/);
    assert.deepEqual(api.results().map(item => item.id), before);
    await execute(documents[0], 0, targets[0]);

    const reopened = await open(profiles[1]);
    assert.notEqual(reopened.sessionId, targets[1].sessionId);
    await bind(peer, reopened, profiles[1], 1);
    await execute(peer, 1, reopened);
    await spring();
    checks.push('The installed extension bound two saved SQL files to owned MySQL and MariaDB sessions. The tagged results returned to their originating files.');
    checks.push('Closing the peer route blocked its binding and active-catalog script paths, kept the other SQL file usable, and required explicit reassociation to a new peer session.');
    return { primaryEngine: engine, engines: fixtures.map(fixture => fixture.version), physicalServers: 2, savedFiles: 2,
      separateTaggedResults: true, exactResultEditor: true, preservedFileContents: true, noFallbackAfterClose: true,
      mismatchedProfileRejected: true, independentSurvivingSession: true, reviewedReattach: true, springIsolation: true };
  } finally {
    try {
      for (const [index, document] of documents.entries()) {
        const opened = document.isClosed ? await vscode.workspace.openTextDocument(vscode.Uri.file(files[index])) : document;
        if (api.isProfileSql(opened)) await api.changeSqlFileProfile(opened, undefined, () => true);
      }
      for (const target of targets) {
        if (api.profileSessionList().some(row => row.id === target.sessionId)) await api.closeProfileSession(target, () => true);
      }
      if (profiles.some(profile => profile.id === api.activeConnectionProfile()?.id)) await api.disconnectMysql();
      for (const profile of profiles) await manager.remove({ id: profile.id, expectedRevision: profile.revision });
      const ownedUris = new Set(files.map(file => vscode.Uri.file(file).toString()));
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => ownedUris.has(tab.input?.uri?.toString()));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    } finally {
      try {
        await Promise.all(fixtures.map(async fixture => {
          try { if (fixture.createdTable) await fixture.actor.query('DROP TABLE ' + table); }
          finally { await fixture.actor.end(); }
        }));
      } finally {
        try {
          await Promise.all(files.map(file => fs.unlink(file)));
          if (folder) await fs.rmdir(folder);
        } finally { await spawned?.stop(); }
      }
    }
  }
}

module.exports = { verifySqlFileProfiles, runSqlFileProfilesChecks };
