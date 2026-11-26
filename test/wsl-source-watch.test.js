'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createWslSourceReader } = require('../src/remote/wsl-source-runtime');
const { registerWslSourceWatch } = require('../src/remote/wsl-source-vscode');

const distribution = 'Ubuntu-24.04';
const root = '\\\\wsl.localhost\\' + distribution + '\\work\\Case Project';
const source = root + '\\src\\Example.java';
const scope = { storage: 'wsl', distribution, linux: '/work/Case Project', directoryIdentity: '10:20' };
const digest = data => createHash('sha256').update(data).digest('hex');
const wire = (data, hash = digest(data)) => Buffer.concat([
  Buffer.from('10:21:' + data.length + ':22:23 ' + hash + '\n'), data
]);

function windowsMirror(text, resolved = source) {
  return { async realpath() { return resolved; }, async open() {
    return { async stat() { return { size: text.length, isFile: () => true }; },
      async read(buffer) { return { bytesRead: text.copy(buffer) }; }, async close() {} };
  } };
}

test('WSL reader binds physical source scope, fixed tool arguments, bounded UTF-8 and Windows mirror', async () => {
  const data = Buffer.from('class 반 { }\n');
  const records = [];
  const sourceReader = createWslSourceReader({ platform: 'win32', fileSystem: windowsMirror(data),
    run: async (...args) => { records.push(args); return { stdout: wire(data) }; } });
  const result = await sourceReader.read(scope, source, { verifyWindows: true });
  assert.deepEqual(result, { text: data.toString(), sha256: digest(data), fingerprint: '10:21:' + data.length + ':22:23:' + digest(data) });
  assert.match(records[0][0], /\\System32\\wsl\.exe$/iu);
  assert.deepEqual(records[0][1].slice(0, 7), ['--distribution', distribution, '--exec', '/usr/bin/python3', '-I', '-S', '-c']);
  assert.deepEqual(records[0][1].slice(-4), [scope.linux, scope.directoryIdentity, 'src/Example.java', '262144']);
  assert.equal(records[0][2].timeout, 7000);
  for (const wrong of [
    source.replace('wsl.localhost', 'smb.localhost'), source.replace(distribution, 'AnotherDistro'),
    source.replace('Case Project', 'case Project'), source.replace('Case Project', 'Case Project Extra'),
    source.replace('src', '.git'), source.replace('src', '..'), source.replace('.java', '.exe')
  ]) await assert.rejects(sourceReader.read(scope, wrong), /WSL project|hidden folders|ambiguous Windows/u);
  assert.equal(records.length, 1);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0]), Buffer.alloc(262145, 0x61)]) {
    const reader = createWslSourceReader({ platform: 'win32', run: async () => ({ stdout: wire(bytes) }) });
    await assert.rejects(reader.read(scope, source), /UTF-8|intact bounded/u);
  }
  const invalid = createWslSourceReader({ platform: 'win32', run: async () => ({ stdout: wire(data, 'a'.repeat(64)) }) });
  await assert.rejects(invalid.read(scope, source), /intact bounded/u);
  const different = createWslSourceReader({ platform: 'win32', fileSystem: windowsMirror(Buffer.from('other')),
    run: async () => ({ stdout: wire(data) }) });
  await assert.rejects(different.read(scope, source, { verifyWindows: true }), /same WSL source bytes/u);
});

function testWindow({ removeEmptyGroup = false } = {}) {
  const file = value => ({ scheme: 'file', fsPath: value, toString: () => 'file://' + value });
  const address = file(source);
  let document = { uri: address, version: 1, isDirty: false, isClosed: false, text: 'before\n',
    getText() { return this.text; } };
  const peer = { uri: file(root + '\\src\\Peer.java'), getText: () => 'peer\n' };
  const editors = new Set([document, peer]), closeListeners = new Set(), folderListeners = new Set();
  class TabInputText { constructor(uri) { this.uri = uri; } }
  const tab = { input: new TabInputText(address), isDirty: false };
  const group = { tabs: [tab], activeTab: tab, isActive: false, viewColumn: 1 };
  const peerTab = { input: new TabInputText(peer.uri), isDirty: false };
  const peerGroup = { tabs: [peerTab], activeTab: peerTab, isActive: true, viewColumn: 2 };
  const bar = { show() {}, hide() {}, dispose() {} };
  const effects = [], commands = new Map();
  let epoch = 0, disk = document.text, pathExists = true, onRead;
  let provider;
  const vscode = {
    Uri: { from: obj => ({ ...obj, toString: () => obj.scheme + ':' + obj.path }) },
    StatusBarAlignment: { Left: 1 }, ViewColumn: { Beside: -2 }, TabInputText, env: {},
    commands: { registerCommand(id, handler) { commands.set(id, handler); return { dispose() {} }; },
      async executeCommand(...args) { effects.push(args); } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: file(root) }],
      get textDocuments() { return [...editors]; },
      registerTextDocumentContentProvider(scheme, value) { provider = value; return { dispose() {} }; },
      onDidCloseTextDocument(callback) { closeListeners.add(callback); return { dispose() {} }; },
      onDidChangeWorkspaceFolders(callback) { folderListeners.add(callback); return { dispose() {} }; }
    },
    window: {
      activeTextEditor: { document: peer },
      createStatusBarItem: () => bar,
      tabGroups: { all: [group, peerGroup],
        async close(target, preserveFocus) {
          assert.equal(target, tab);
          effects.push(['close', target, preserveFocus]);
          assert.equal(document.isDirty, false);
          group.tabs = [];
          if (removeEmptyGroup) {
            vscode.window.tabGroups.all = [peerGroup];
            peerGroup.viewColumn = group.viewColumn;
          }
          editors.delete(document);
          document.isClosed = true;
          for (const callback of closeListeners) callback(document);
          return true;
        }
      },
      async showTextDocument(uri, options) {
        assert.equal(uri, address);
        effects.push(['show', uri, options]);
        document = { ...document, isClosed: false, version: 1, text: disk };
        group.tabs = [tab];
        editors.add(document);
        return { document };
      },
      async showErrorMessage(message) { effects.push(['error', message]); },
      async showWarningMessage() { effects.push(['approval']); }
    }
  };
  const watcher = registerWslSourceWatch(vscode, { interval: 15, mapping: async () => scope, reader: {
    async read(_scope, file, request) {
      assert.equal(file, source);
      if (!pathExists) throw Error('Linux source unavailable');
      if (request.verifyWindows && onRead) onRead();
      return { text: disk, sha256: digest(disk), fingerprint: epoch + ':' + digest(disk) };
    }
  } });
  return { get document() { return document; }, group, peer, watcher, vscode, commands, effects,
    text: uri => provider.provideTextDocumentContent(uri),
    change(value) { disk = value; epoch++; },
    onRead(action) { onRead = action; },
    losePath() { pathExists = false; },
    removeWorkspace() { vscode.workspace.workspaceFolders = []; for (const callback of folderListeners) callback(); }
  };
}

test('observed Linux edits create a linked read-only diff and reload only the approved clean tab', async t => {
  const host = testWindow();
  t.after(() => host.watcher.dispose());
  const { watcher, commands, effects, vscode, peer } = host;
  assert.equal((await watcher.start(host.document)).state, 'watching');
  host.change('Linux new\n');
  for (let attempt = 0; attempt < 20 && watcher.state().state !== 'changed'; attempt++) await delay(10);
  assert.equal(watcher.state().state, 'changed');
  let plan = await watcher.showComparison();
  assert.equal(host.text(plan.editorUri), 'before\n');
  assert.equal(host.text(plan.linuxUri), 'Linux new\n');
  assert.equal(effects.at(-1)[0], 'vscode.diff');
  assert.equal(effects.at(-1).at(-1).preserveFocus, true);
  await assert.rejects(watcher.reload(plan.token), /explicitly approve/u);
  await commands.get('rocketbrain.wsl.reloadSource')();
  assert.equal(effects.at(-1)[0], 'approval');
  host.change('Linux second\n');
  await assert.rejects(watcher.reload(plan.token, { approved: true }), /Linux source changed/u);
  plan = await watcher.compare();
  host.onRead(() => { host.document.version++; host.document.isDirty = true; });
  await assert.rejects(watcher.reload(plan.token, { approved: true }), /dirty or changed/u);
  assert.equal(effects.some(item => item[0] === 'close'), false);
  host.onRead(undefined);
  const dirty = await watcher.compare();
  assert.equal(dirty.reloadAvailable, false);
  host.document.isDirty = false;
  plan = await watcher.compare();
  assert.deepEqual(await watcher.reload(plan.token, { approved: true }),
    { state: 'reloaded', sourceUri: host.document.uri.toString(), sha256: digest('Linux second\n') });
  assert.equal(host.document.getText(), 'Linux second\n');
  assert.equal(host.document.isDirty, false);
  assert.equal(vscode.window.activeTextEditor.document, peer);
  assert.equal(effects.find(item => item[0] === 'close').at(-1), true);
  assert.equal(effects.find(item => item[0] === 'show').at(-1).preserveFocus, true);
  await assert.rejects(watcher.reload(plan.token, { approved: true }), /explicitly approve/u);
  host.removeWorkspace();
  assert.equal(watcher.state().state, 'stopped');
});

test('WSL watch refuses another active tab in the same group and unverified source reads', async t => {
  const host = testWindow();
  t.after(() => host.watcher.dispose());
  await host.watcher.start(host.document);
  host.change('Linux\n');
  const plan = await host.watcher.compare();
  host.group.isActive = true;
  host.group.activeTab = { input: new host.vscode.TabInputText(host.peer.uri) };
  await assert.rejects(host.watcher.reload(plan.token, { approved: true }), /Return to the watched source/u);
  host.losePath();
  await assert.rejects(host.watcher.reload(plan.token, { approved: true }), /unavailable/u);
  assert.equal(host.effects.some(item => item[0] === 'close'), false);
});

test('a removed source group reopens beside the focused peer when columns shift', async t => {
  const host = testWindow({ removeEmptyGroup: true });
  t.after(() => host.watcher.dispose());
  await host.watcher.start(host.document);
  host.change('Linux\n');
  const plan = await host.watcher.compare();
  assert.equal((await host.watcher.reload(plan.token, { approved: true })).state, 'reloaded');
  const reopen = host.effects.find(item => item[0] === 'show').at(-1);
  assert.equal(reopen.viewColumn, host.vscode.ViewColumn.Beside);
  assert.equal(reopen.preserveFocus, true);
  assert.equal(host.vscode.window.activeTextEditor.document, host.peer);
});
