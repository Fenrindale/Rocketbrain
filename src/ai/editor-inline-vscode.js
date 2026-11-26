'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { normalizeLocalChatTarget } = require('./local-chat');
const { inlineBounds, inlineContext, requestInlineModel } = require('./editor-model');

const section = 'rocketbrain.localCodeModel';
const languages = new Set(['java', 'kotlin', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'python', 'sql']);

function registerEditorInline(vscode, { localFile, configuration }) {
  let approved, pending, disposed = false, approvalSequence = 0;
  const editor = () => vscode.window.activeTextEditor;
  const cancel = () => { pending?.abort(); pending = undefined; };
  const clear = () => { approvalSequence++; approved = undefined; cancel(); };
  const target = document => {
    const configured = configuration(document.uri);
    return normalizeLocalChatTarget(configured.endpoint, configured.model);
  };
  const sameTarget = (left, right) => left.endpoint === right.endpoint && left.model === right.model;

  async function approve(document, confirm) {
    if (disposed || editor()?.document !== document || !languages.has(document?.languageId)) {
      throw Error('Open a supported local source file for inline completions.');
    }
    const file = localFile(document), version = document.version, proposed = target(document);
    const review = ++approvalSequence;
    const consent = { document, file, target: proposed };
    if (await confirm?.({ file: vscode.workspace.asRelativePath(document.uri), endpoint: proposed.endpoint,
      model: proposed.model, ...inlineBounds }) !== true) return false;
    if (disposed || review !== approvalSequence || editor()?.document !== document || document.version !== version ||
        localFile(document) !== file || !sameTarget(target(document), proposed)) {
      throw Error('The source or local model changed. Review the inline completion scope again.');
    }
    cancel();
    approved = consent;
    return true;
  }

  function isCurrent(consent, document, position, version) {
    const active = editor();
    if (!consent || disposed || !vscode.workspace.isTrusted || approved !== consent || active?.document !== document ||
        consent.document !== document || document.isClosed || document.version !== version || !languages.has(document.languageId) ||
        !active.selection.isEmpty || !active.selection.active.isEqual(position)) return false;
    try { return localFile(document) === consent.file && sameTarget(target(document), consent.target); }
    catch { return false; }
  }

  async function provideInlineCompletionItems(document, position, context, token) {
    const consent = approved, version = document.version;
    if (context.selectedCompletionInfo || token.isCancellationRequested || !isCurrent(consent, document, position, version)) return [];
    cancel();
    const stop = new AbortController();
    pending = stop;
    const cancelled = token.onCancellationRequested(() => stop.abort());
    if (token.isCancellationRequested) stop.abort();
    try {
      if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) await delay(250, undefined, { signal: stop.signal });
      if (!isCurrent(consent, document, position, version) || stop.signal.aborted) return [];
      const snippet = inlineContext(document.getText(), document.offsetAt(position), document.languageId);
      if (!snippet.prefix.trim()) return [];
      const insertion = await requestInlineModel(consent.target, snippet, { signal: stop.signal });
      if (!insertion || stop.signal.aborted || !isCurrent(consent, document, position, version)) return [];
      return [new vscode.InlineCompletionItem(insertion, new vscode.Range(position, position))];
    } catch {
      return [];
    } finally {
      cancelled.dispose();
      if (pending === stop) pending = undefined;
    }
  }

  const events = [
    vscode.languages.registerInlineCompletionItemProvider([...languages].map(language => ({ language, scheme: 'file' })),
      { provideInlineCompletionItems }),
    vscode.workspace.onDidCloseTextDocument(document => { if (document === approved?.document) clear(); }),
    vscode.workspace.onDidChangeTextDocument(event => { if (event.document === approved?.document) cancel(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (approved && event.affectsConfiguration(section, approved.document.uri)) clear();
    }),
    vscode.window.onDidChangeActiveTextEditor(active => { if (active?.document !== approved?.document) cancel(); }),
    vscode.window.onDidChangeTextEditorSelection(event => { if (event.textEditor.document === approved?.document) cancel(); }),
    vscode.commands.registerCommand(section + '.enableInline', async () => {
      try {
        return await approve(editor()?.document, async scope =>
          await vscode.window.showWarningMessage('Allow local inline completions for this source file?', { modal: true,
            detail: `${scope.file}\n${scope.model}\n${scope.endpoint}\n\n` +
              `While this file is open, the local model can receive up to ${scope.prefix} characters before and ${scope.suffix} after the cursor.` },
          'Allow Cursor Context') === 'Allow Cursor Context');
      } catch (error) { void vscode.window.showErrorMessage(error.message); }
    }),
    vscode.commands.registerCommand(section + '.disableInline', clear)
  ];
  return { approve, clear, provideInlineCompletionItems, dispose() {
    disposed = true;
    clear();
    events.forEach(event => event.dispose());
  } };
}

module.exports = { registerEditorInline };
