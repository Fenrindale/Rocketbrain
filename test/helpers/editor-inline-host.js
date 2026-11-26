'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { registerEditorModel } = require('../../src/ai/editor-model-vscode');

const disposable = { dispose() {} };
function inlineWorkstation(root, file, text, settings) {
  const handlers = new Map(), commands = new Map(), prompts = [];
  const uri = name => ({ scheme: 'file', fsPath: name, toString: () => pathToFileURL(name).href });
  const document = { uri: uri(file), languageId: 'java', version: 1, isClosed: false, text,
    getText() { return this.text; }, offsetAt: position => position.offset };
  const position = offset => ({ offset, isEqual: other => other.offset === offset });
  const event = label => callback => {
    if (!handlers.has(label)) handlers.set(label, []);
    handlers.get(label).push(callback);
    return disposable;
  };
  let provider;
  const vscode = {
    EventEmitter: class { event() { return disposable; } fire() {} dispose() {} },
    InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
    Range: class { constructor(start, end) { Object.assign(this, { start, end, isEmpty: start.isEqual(end) }); } },
    InlineCompletionItem: class { constructor(insertText, range) { Object.assign(this, { insertText, range }); } },
    commands: { registerCommand(name, invoke) { commands.set(name, invoke); return disposable; } },
    languages: {
      registerInlineCompletionItemProvider(selectors, registered) { provider = registered; return disposable; }
    },
    workspace: {
      isTrusted: true, getWorkspaceFolder: () => ({ uri: uri(root) }), asRelativePath: source => path.relative(root, source.fsPath),
      getConfiguration: () => ({ get: name => settings[name] }), registerTextDocumentContentProvider: () => disposable,
      onDidCloseTextDocument: event('close'), onDidChangeTextDocument: event('text'), onDidChangeConfiguration: event('settings'),
      onDidChangeWorkspaceFolders: event('folders')
    },
    window: {
      activeTextEditor: { document, selection: { isEmpty: true, active: position(text.indexOf(';')) } },
      approve: true,
      async showWarningMessage(message, options, action) { prompts.push({ message, ...options }); return this.approve ? action : undefined; },
      async showErrorMessage(message) { throw Error(message); },
      onDidChangeActiveTextEditor: event('active'), onDidChangeTextEditorSelection: event('selection')
    }
  };
  const codeModel = registerEditorModel(vscode);
  return {
    vscode, codeModel, document, prompts,
    invoke: suffix => commands.get('rocketbrain.localCodeModel.' + suffix)(),
    setCursor: offset => { vscode.window.activeTextEditor.selection.active = position(offset); },
    emit: (name, payload) => handlers.get(name).forEach(handler => handler(payload)),
    complete: (kind = vscode.InlineCompletionTriggerKind.Invoke, token = {
      isCancellationRequested: false, onCancellationRequested: () => disposable
    }) => provider.provideInlineCompletionItems(document, vscode.window.activeTextEditor.selection.active, { triggerKind: kind }, token)
  };
}

module.exports = { inlineWorkstation };
