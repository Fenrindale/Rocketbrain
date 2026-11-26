'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { workspacePath, workspaceRoots } = require('../java/workbench-model');
const { requestEditorModel, snapshotLocalEdit, applyLocalEditToText } = require('./editor-model');
const { registerEditorInline } = require('./editor-inline-vscode');
const { registerEditorConversation } = require('./editor-conversation-vscode');

const scheme = 'rocketbrain-local-code-model';

function registerEditorModel(vscode) {
  const reviews = new Map();
  const openRequests = new Set();
  let disposed = false;

  function localFile(document) {
    if (disposed || !vscode.workspace.isTrusted || document?.uri.scheme !== 'file' || document.isClosed) {
      throw Error('Choose a local source file in a trusted workspace.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder?.uri.scheme !== 'file') throw Error('Choose a file inside an open local workspace folder.');
    return workspacePath(document.uri.toString(), workspaceRoots([folder]), { directory: false });
  }

  function capture(document, range) {
    const file = localFile(document);
    const text = document.getText();
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    return { document, version: document.version, file, text, selection: snapshotLocalEdit(text, start, end) };
  }

  function configuration(uri, settings) {
    if (settings) return settings;
    const preferences = vscode.workspace.getConfiguration('rocketbrain.localCodeModel', uri);
    return { endpoint: preferences.get('endpoint'), model: preferences.get('model') };
  }

  const inline = registerEditorInline(vscode, { localFile, configuration });
  const conversation = registerEditorConversation(vscode, { configuration });

  function remember(result) {
    while (reviews.size >= 8) reviews.delete(reviews.keys().next().value);
    const id = randomUUID();
    reviews.set(id, result);
    return id;
  }

  async function generate(document, range, intent, action, settings, signal) {
    const origin = capture(document, range);
    const target = configuration(document.uri, settings);
    const stop = new AbortController();
    openRequests.add(stop);
    let response;
    try {
      response = await requestEditorModel({ ...target, selection: origin.selection.selection,
        language: document.languageId, intent, action }, { signal: signal ? AbortSignal.any([stop.signal, signal]) : stop.signal });
    } finally { openRequests.delete(stop); }
    if (disposed || !vscode.workspace.isTrusted || origin.version !== document.version || document.isClosed) {
      throw Error('The file changed during local model generation. Request a new answer.');
    }
    return { origin, response };
  }

  async function explain(document, range, intent, settings, signal) {
    const { origin, response } = await generate(document, range, intent, 'explain', settings, signal);
    const id = remember({ answer: response });
    const uri = vscode.Uri.from({ scheme, path: `/${id}/answer/${path.basename(origin.file)}.answer.txt` });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    return { uri, response };
  }

  async function prepareEdit(document, range, intent, settings, signal) {
    const { origin, response: replacement } = await generate(document, range, intent, 'edit', settings, signal);
    const candidate = applyLocalEditToText(origin.selection, origin.text, replacement);
    if (candidate === origin.text) throw Error('The local model returned the existing source.');
    const id = remember({ origin, replacement, candidate });
    const name = path.basename(origin.file);
    const before = vscode.Uri.from({ scheme, path: `/${id}/before/${name}` });
    const after = vscode.Uri.from({ scheme, path: `/${id}/after/${name}` });
    await vscode.commands.executeCommand('vscode.diff', before, after, `${name} · Review Local Model Edit`, { preview: false });
    return { id, before, after };
  }

  async function apply(id) {
    const plan = reviews.get(id);
    if (!plan?.origin) throw Error('Open a current local model edit for review.');
    const origin = plan.origin;
    const source = await vscode.workspace.openTextDocument(origin.document.uri);
    const editor = await vscode.window.showTextDocument(source, { preview: false });
    const range = new vscode.Range(source.positionAt(origin.selection.start), source.positionAt(origin.selection.end));
    const current = capture(source, range);
    if (source.version !== origin.version || current.file !== origin.file) {
      throw Error('The file changed after review. Request an updated local model edit.');
    }
    applyLocalEditToText(origin.selection, current.text, plan.replacement);
    if (!await editor.edit(builder => builder.replace(range, plan.replacement))) throw Error('The reviewed edit did not apply.');
    reviews.delete(id);
    return true;
  }

  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) {
      if (disposed || !vscode.workspace.isTrusted) return '';
      const [, id, form] = uri.path.split('/');
      const entry = reviews.get(id);
      if (form === 'answer') return entry?.answer || '';
      if (form === 'before') return entry?.origin?.text || '';
      return form === 'after' ? entry?.candidate || '' : '';
    }
  });

  function ask(action) {
    return async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw Error('Open a local source file.');
      const version = editor.document.version;
      const range = editor.selection.isEmpty && action === 'explain' ? editor.document.lineAt(editor.selection.active.line).range : editor.selection;
      const prompt = await vscode.window.showInputBox({ title: action === 'edit' ? 'Request a Reviewed Local Edit' : 'Ask Local Code Model',
        prompt: 'Send the selected source and this request to the configured local model' });
      if (prompt === undefined) return;
      if (editor.document.version !== version) throw Error('The selected source changed. Select it again.');
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Waiting for Local Code Model', cancellable: true }, async (_, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try {
          return await (action === 'edit' ? prepareEdit : explain)(editor.document, range, prompt, undefined, abort.signal);
        } finally { subscription.dispose(); }
      });
    };
  }

  const registrations = [['explain', ask('explain')], ['edit', ask('edit')], ['apply', async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== scheme || uri.path.split('/')[2] !== 'after') throw Error('Open the proposed side of a local model review.');
    return apply(uri.path.split('/')[1]);
  }]].map(([name, run]) => vscode.commands.registerCommand('rocketbrain.localCodeModel.' + name, async () => {
    try { return await run(); }
    catch (error) { void vscode.window.showErrorMessage(error.message); }
  }));
  return { explain, prepareEdit, apply, inline, conversation, dispose() {
    disposed = true;
    inline.dispose();
    conversation.dispose();
    for (const request of openRequests) request.abort();
    reviews.clear();
    provider.dispose();
    registrations.forEach(item => item.dispose());
  } };
}

module.exports = { registerEditorModel };
