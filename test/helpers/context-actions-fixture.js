'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const manifest = require('../../package.json');

function uri(file, scheme = 'file') {
  const url = pathToFileURL(file);
  if (scheme !== 'file') return { scheme, path: url.pathname, fsPath: file, toString: () => scheme + ':' + url.pathname };
  return { scheme, path: url.pathname, fsPath: file, toString: () => url.href };
}

class TabInputText {
  constructor(uri) { this.uri = uri; }
}
class Range {
  constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
}

function point(line = 0, character = 0) { return { anchor: { line, character }, active: { line, character } }; }
function document(file, languageId, text = '') {
  return { uri: file, languageId, version: 1, isClosed: false, isDirty: false, getText: () => text };
}

function createContextHarness(root) {
  const commands = new Map(), invoked = [], errors = [], clipboard = [], pickers = [];
  const local = { uri: uri(root) };
  let respond = () => undefined;
  const handlers = {
    async getCommands() { return [...commands.keys()]; },
    registerCommand(id, run) { commands.set(id, run); return { dispose() { commands.delete(id); } }; },
    async executeCommand(id, ...args) {
      invoked.push({ id, args });
      if (!commands.has(id)) throw Error('No fixture command ' + id);
      return commands.get(id)(...args);
    }
  };
  const window = {
    tabGroups: { activeTabGroup: {} },
    async showQuickPick(items, options) {
      pickers.push({ items, options });
      return respond(items, options);
    },
    async showTextDocument(doc, { selection } = {}) {
      const here = selection ? point(selection.start.line, selection.start.character) : point();
      return show(doc, here);
    },
    async withProgress(_options, fn) { return fn({}, { isCancellationRequested: false }); },
    showErrorMessage(message) { errors.push(message); },
    showInformationMessage() {}
  };
  function show(document, selection = point()) {
    const editor = { document, selection, selections: [selection], viewColumn: 1 };
    window.activeTextEditor = editor;
    window.tabGroups.activeTabGroup.activeTab = { input: new TabInputText(document.uri) };
    return editor;
  }
  function otherTab() { window.tabGroups.activeTabGroup.activeTab = { input: { viewType: 'diagram' } }; }
  const vscode = {
    window, commands: handlers, TabInputText, Range, ProgressLocation: { Notification: 1 }, QuickPickItemKind: { Separator: -1 },
    CancellationTokenSource: class {
      constructor() { this.token = { isCancellationRequested: false }; }
      cancel() { this.token.isCancellationRequested = true; }
      dispose() {}
    },
    debug: { activeDebugSession: undefined },
    Uri: { parse: value => uri(require('node:url').fileURLToPath(value)) },
    workspace: {
      isTrusted: true, workspaceFolders: [local],
      getWorkspaceFolder(file) {
        const relative = path.relative(root, file.fsPath);
        return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? local : undefined;
      }
    },
    env: { clipboard: { async writeText(value) { clipboard.push(value); } } }
  };
  const map = new Map();
  const context = { extension: { id: 'rocketbrain-local.rocketbrain', isActive: true, packageJSON: manifest },
    workspaceState: { get: (key, fallback) => map.get(key) ?? fallback, async update(key, value) { map.set(key, value); } } };
  const available = [
    'rocketbrain.java.fileStructure', 'rocketbrain.java.findUsages', 'rocketbrain.java.workbench.sourceTarget', 'rocketbrain.spring.beans',
    'rocketbrain.runQuery', 'rocketbrain.sql.format', 'rocketbrain.sql.explainVisual', 'rocketbrain.focusQueryResults',
    'rocketbrain.results.returnToQuery', 'rocketbrain.results.copyTsv', 'rocketbrain.java.smartStepInto', 'rocketbrain.java.showAsyncTaskStack',
    'rocketbrain.java.workbench.tasks', 'rocketbrain.java.testing.discover', 'rocketbrain.openConsole', 'rocketbrain.connectMysql',
    'rocketbrain.searchEverywhere', 'rocketbrain.recentFiles', 'workbench.action.openGlobalKeybindings', 'workbench.action.selectTheme'
  ];
  for (const command of available) handlers.registerCommand(command, () => undefined);
  return { vscode, context, invoked, errors, clipboard, pickers, commands, show, otherTab,
    answer: resolver => { respond = resolver; } };
}

module.exports = { createContextHarness, document, uri, point };
