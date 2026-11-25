'use strict';

const { randomUUID } = require('node:crypto');
const { inspectEmbedded, replacementFor } = require('./embedded-language');

const openCommand = 'rocketbrain.sql.editEmbedded';
const applyCommand = 'rocketbrain.sql.applyEmbedded';
const reviewScheme = 'rocketbrain-embedded-review';
const extensions = { java: 'java', xml: 'xml', sql: 'sql' };

function registerEmbeddedLanguage(vscode, { catalogSnapshot }) {
  const sessions = new Map(), reviews = new Map();
  let disposed = false;

  function guard() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace to edit embedded SQL or JSON.');
  }

  function sqlMode() {
    const catalog = catalogSnapshot();
    return !catalog?.cachedMetadata && catalog?.semanticContextObserved && Array.isArray(catalog.sqlMode)
      ? [...catalog.sqlMode].sort() : undefined;
  }

  function validSource(source) {
    return source?.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(source.uri)?.uri.scheme === 'file';
  }

  function unchanged(session) {
    guard();
    const { source, snippet, position } = session;
    if (!validSource(source) || source.isClosed || source.version !== session.version || source.languageId !== snippet.hostLanguage) {
      throw Error('The original source changed or closed. Open its embedded fragment again.');
    }
    const current = inspectEmbedded(source.languageId, snippet.language, source.getText(), position,
      source.languageId === 'sql' ? sqlMode() : undefined);
    if (current.start !== snippet.start || current.end !== snippet.end || current.original !== snippet.original ||
        JSON.stringify(current.sqlMode) !== JSON.stringify(snippet.sqlMode)) {
      throw Error('The host range or database SQL mode changed. Open the embedded fragment again.');
    }
  }

  async function open(source, position, language) {
    guard();
    if (!validSource(source) || source.isClosed) throw Error('Open a Java, mapper XML, or SQL source file in this workspace.');
    if (sessions.size >= 12) throw Error('Close unused embedded editors before opening a new one.');
    const offset = source.offsetAt(position);
    const snippet = inspectEmbedded(source.languageId, language, source.getText(), offset,
      source.languageId === 'sql' ? sqlMode() : undefined);
    const session = { source, snippet, position: offset, version: source.version };
    const document = await vscode.workspace.openTextDocument({ language, content: snippet.text });
    if (document.getText() !== snippet.text) throw Error('The editor could not preserve the fragment’s original line endings.');
    unchanged(session);
    if (sessions.size >= 12) throw Error('Close unused embedded editors before opening a new one.');
    sessions.set(document.uri.toString(), { ...session, document });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    return document;
  }

  function prepare(document) {
    guard();
    const key = document?.uri.toString();
    const session = sessions.get(key);
    if (!session || session.document !== document || document.isClosed || document.languageId !== session.snippet.language) {
      throw Error('Select the embedded SQL or JSON editor.');
    }
    unchanged(session);
    const after = replacementFor(session.snippet, document.getText());
    const before = session.snippet.original;
    if (before === after) return null;
    if (session.reviewId) reviews.delete(session.reviewId);
    const id = randomUUID();
    session.reviewId = id;
    reviews.set(id, { session, key, before, after, version: document.version });
    return { id, before, after };
  }

  function review(id) {
    const receipt = reviews.get(id);
    if (!receipt || sessions.get(receipt.key) !== receipt.session || receipt.session.document.isClosed ||
        receipt.session.document.version !== receipt.version || receipt.session.document.languageId !== receipt.session.snippet.language) {
      throw Error('The embedded text changed after review. Review the current text before applying.');
    }
    unchanged(receipt.session);
    return receipt;
  }

  async function apply(id) {
    const receipt = review(id);
    const { source, snippet, document } = receipt.session;
    const editor = await vscode.window.showTextDocument(source, { preserveFocus: false, preview: false });
    review(id);
    reviews.delete(id);
    const range = new vscode.Range(source.positionAt(snippet.start), source.positionAt(snippet.end));
    const applied = await editor.edit(builder => builder.replace(range, receipt.after));
    if (!applied) throw Error('The original source changed while applying. Open the fragment again.');
    return { applied, source: source.uri, working: document.uri };
  }

  function isProjection(document) {
    return Boolean(document && sessions.has(document.uri.toString()));
  }

  const disposables = [
    vscode.workspace.registerTextDocumentContentProvider(reviewScheme, {
      provideTextDocumentContent(uri) {
        const result = /^\/([a-f0-9-]+)\/(before|after)\./.exec(uri.path);
        return result && reviews.get(result[1])?.[result[2]] || '';
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString(), session = sessions.get(key);
      if (session?.reviewId) reviews.delete(session.reviewId);
      sessions.delete(key);
    })
  ];

  function command(name, action) {
    disposables.push(vscode.commands.registerCommand(name, async () => {
      try { return await action(); }
      catch (error) { await vscode.window.showErrorMessage(error.message); }
    }));
  }

  command(openCommand, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !extensions[editor.document.languageId]) throw Error('Open a Java, MyBatis XML, or SQL source file.');
    const { document, selection } = editor;
    const language = document.languageId === 'xml' ? 'SQL' : document.languageId === 'sql' ? 'JSON' :
      await vscode.window.showQuickPick(['SQL', 'JSON'], { title: 'Embedded Language' });
    if (language) await open(document, selection.active, language.toLowerCase());
  });

  command(applyCommand, async () => {
    const preview = prepare(vscode.window.activeTextEditor?.document);
    if (!preview) { vscode.window.setStatusBarMessage('The embedded text is unchanged.', 3000); return; }
    const { hostLanguage } = review(preview.id).session.snippet;
    const uri = part => vscode.Uri.from({ scheme: reviewScheme, path: `/${preview.id}/${part}.${extensions[hostLanguage]}` });
    await vscode.commands.executeCommand('vscode.diff', uri('before'), uri('after'), 'Review Embedded Source Edit');
    const answer = await vscode.window.showInformationMessage('Review the diff, then apply the fragment to the original source.', 'Apply Edit');
    if (answer === 'Apply Edit') await apply(preview.id);
  });

  return { open, prepare, apply, isProjection, dispose() {
    disposed = true;
    sessions.clear();
    reviews.clear();
    for (const disposable of disposables) disposable.dispose();
  } };
}

module.exports = { registerEmbeddedLanguage };
