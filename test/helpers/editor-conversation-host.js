'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerEditorConversation } = require('../../src/ai/editor-conversation-vscode');

const disposable = { dispose() {} };
const file = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => pathToFileURL(fsPath).href });

function conversationHost(root, settings) {
  const commands = new Map();
  const listeners = new Map();
  const inputs = { approve: true, files: [], question: undefined };
  let provider;
  const workspace = {
    isTrusted: true, textDocuments: [],
    getWorkspaceFolder(uri) {
      if (uri?.scheme !== 'file') return undefined;
      const relative = path.relative(root, uri.fsPath);
      if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return undefined;
      return { uri: file(root) };
    },
    async openTextDocument(uri) { return { uri, getText: () => provider.provideTextDocumentContent(uri) }; },
    registerTextDocumentContentProvider(value, registered) { provider = registered; return disposable; },
    onDidChangeWorkspaceFolders(handler) { listeners.set('folders', handler); return disposable; },
    onDidChangeConfiguration(handler) { listeners.set('settings', handler); return disposable; }
  };
  const window = {
    async showOpenDialog() { return inputs.files; },
    async showInputBox() { return inputs.question; },
    async showQuickPick(items) { return inputs.choose === false ? undefined : items[0]; },
    async showWarningMessage(message, options, action) { return inputs.approve ? action : undefined; },
    async showTextDocument(document) { this.activeTextEditor = { document }; return this.activeTextEditor; },
    async withProgress(options, callback) {
      return callback(undefined, {
        isCancellationRequested: inputs.signal?.aborted,
        onCancellationRequested(listener) {
          const signal = inputs.signal;
          signal?.addEventListener('abort', listener, { once: true });
          return { dispose: () => signal?.removeEventListener('abort', listener) };
        }
      });
    },
    showErrorMessage(message) { throw Error(message); }
  };
  const vscode = {
    EventEmitter: class { event() { return disposable; } fire() {} dispose() {} },
    Uri: { file, from: value => value },
    ProgressLocation: { Notification: 15 },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable; } },
    workspace, window
  };
  const conversation = registerEditorConversation(vscode, { configuration: () => settings });
  return {
    vscode, conversation, inputs,
    invoke: command => commands.get('rocketbrain.localCodeModel.' + command)(),
    emit: (event, payload) => listeners.get(event)(payload),
    review: uri => JSON.parse(provider.provideTextDocumentContent(uri)),
    transcript: uri => provider.provideTextDocumentContent(uri),
    openFile: uri => { window.activeTextEditor = { document: { uri } }; }
  };
}

module.exports = { conversationHost };
