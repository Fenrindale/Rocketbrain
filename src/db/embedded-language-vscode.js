'use strict';

const { randomUUID } = require('node:crypto');
const { inspectEmbedded, replacementFor, projectionRange } = require('./embedded-language');
const { checkJavaRegex } = require('../java/regex-check');

const openCommand = 'rocketbrain.sql.editEmbedded';
const applyCommand = 'rocketbrain.sql.applyEmbedded';
const revealCommand = 'rocketbrain.java.revealEmbeddedSource';
const reviewScheme = 'rocketbrain-embedded-review';
const extensions = { java: 'java', xml: 'xml', sql: 'sql' };
const regexMode = 'rocketbrain-java-regex';
const projectionMode = language => language === 'regex' ? regexMode : language;

function registerEmbeddedLanguage(vscode, { catalogSnapshot }) {
  const sessions = new Map(), reviews = new Map();
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-java-regex');
  let disposed = false;

  function guard() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace to edit embedded text.');
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
    const document = await vscode.workspace.openTextDocument({ language: projectionMode(language), content: snippet.text });
    if (document.getText() !== snippet.text) throw Error('The editor could not preserve the fragment’s original line endings.');
    unchanged(session);
    if (sessions.size >= 12) throw Error('Close unused embedded editors before opening a new one.');
    sessions.set(document.uri.toString(), { ...session, document });
    const index = source.languageId === 'java' ? snippet.ends.findIndex(end => end > offset) : -1;
    const cursor = document.positionAt(index >= 0 ? index : 0);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false,
      selection: new vscode.Range(cursor, cursor) });
    return document;
  }

  function findSession(document) {
    guard();
    const session = sessions.get(document?.uri.toString());
    if (!session || session.document !== document || document.isClosed || document.languageId !== projectionMode(session.snippet.language)) {
      throw Error('Select an embedded fragment editor.');
    }
    unchanged(session);
    return session;
  }

  function prepare(document) {
    const session = findSession(document), key = document.uri.toString();
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
        receipt.session.document.version !== receipt.version || receipt.session.document.languageId !== projectionMode(receipt.session.snippet.language)) {
      throw Error('The embedded text changed after review. Review the current text before applying.');
    }
    unchanged(receipt.session);
    return receipt;
  }

  async function verifyRegex(session) {
    const { document, source } = session;
    if (session.check) throw Error('Java regular expression validation is already running in this editor.');
    const controller = new AbortController(), version = document.version, value = document.getText();
    const config = () => vscode.workspace.getConfiguration('rocketbrain.java', source.uri).get('javaHome');
    const javaHome = config();
    session.check = controller;
    try {
      const result = await checkJavaRegex(javaHome, value, controller.signal);
      if (findSession(document) !== session || version !== document.version || javaHome !== config()) {
        throw Error('The regex or configured JDK changed during validation. Review it again.');
      }
      if (result.valid) { diagnostics.delete(document.uri); return; }
      const indexed = result.index >= 0 && !/[\u{10000}-\u{10ffff}]/u.test(value);
      const first = indexed ? Math.min(result.index, Math.max(0, value.length - 1)) : 0;
      const last = indexed ? Math.min(first + 1, value.length) : value.length;
      const issue = new vscode.Diagnostic(new vscode.Range(document.positionAt(first), document.positionAt(last)),
        result.description, vscode.DiagnosticSeverity.Error);
      issue.source = 'Java Pattern';
      diagnostics.set(document.uri, [issue]);
      throw Error('Java Pattern rejected the regular expression. Check the editor diagnostic.');
    } finally { delete session.check; }
  }

  async function prepareVerified(document) {
    const session = findSession(document);
    if (session.snippet.language === 'regex') await verifyRegex(session);
    return prepare(document);
  }

  async function apply(id) {
    const receipt = review(id);
    const { source, snippet, document } = receipt.session;
    if (snippet.language === 'regex') await verifyRegex(receipt.session);
    const editor = await vscode.window.showTextDocument(source, { preserveFocus: false, preview: false });
    review(id);
    reviews.delete(id);
    const range = new vscode.Range(source.positionAt(snippet.start), source.positionAt(snippet.end));
    const applied = await editor.edit(builder => builder.replace(range, receipt.after));
    if (!applied) throw Error('The original source changed while applying. Open the fragment again.');
    return { applied, source: source.uri, working: document.uri };
  }

  async function reveal(document, range) {
    const session = findSession(document), { source, snippet } = session;
    if (snippet.hostLanguage !== 'java') throw Error('Select a fragment opened from Java source.');
    const version = document.version;
    const exact = document.getText() === snippet.text && !!range;
    const offsets = exact ? projectionRange(snippet, document.offsetAt(range.start), document.offsetAt(range.end)) : snippet;
    const target = new vscode.Range(source.positionAt(offsets.start), source.positionAt(offsets.end));
    const editor = await vscode.window.showTextDocument(source, { preview: false });
    if (findSession(document) !== session || version !== document.version) throw Error('The embedded fragment changed before it could be revealed.');
    editor.selection = new vscode.Selection(target.start, target.end);
    editor.revealRange(target);
    return { source: source.uri, range: target, exact };
  }

  function isProjection(document) {
    return Boolean(document && sessions.has(document.uri.toString()));
  }

  const disposables = [
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(reviewScheme, {
      provideTextDocumentContent(uri) {
        const result = /^\/([a-f0-9-]+)\/(before|after)\./.exec(uri.path);
        return result && reviews.get(result[1])?.[result[2]] || '';
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString(), session = sessions.get(key);
      if (session?.reviewId) reviews.delete(session.reviewId);
      session?.check?.abort();
      diagnostics.delete(document.uri);
      sessions.delete(key);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (!contentChanges.length) return;
      const session = sessions.get(document.uri.toString());
      if (session?.snippet.language === 'regex') diagnostics.delete(document.uri);
    })
  ];

  function command(name, action) {
    disposables.push(vscode.commands.registerCommand(name, async () => {
      try { return await action(); }
      catch (error) { if (!disposed) void vscode.window.showErrorMessage(error.message); }
    }));
  }

  command(openCommand, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !extensions[editor.document.languageId]) throw Error('Open a Java, MyBatis XML, or SQL source file.');
    const { document, selection } = editor;
    const choices = [{ label: 'SQL', language: 'sql' }, { label: 'JSON', language: 'json' },
      { label: 'Java Regular Expression', language: 'regex' }, { label: 'HTML', language: 'html' }];
    const language = document.languageId === 'xml' ? 'sql' : document.languageId === 'sql' ? 'json' :
      (await vscode.window.showQuickPick(choices, { title: 'Embedded Language' }))?.language;
    if (language) await open(document, selection.active, language);
  });

  command(applyCommand, async () => {
    const preview = await prepareVerified(vscode.window.activeTextEditor?.document);
    if (!preview) { vscode.window.setStatusBarMessage('The embedded text is unchanged.', 3000); return; }
    const { hostLanguage } = review(preview.id).session.snippet;
    const uri = part => vscode.Uri.from({ scheme: reviewScheme, path: `/${preview.id}/${part}.${extensions[hostLanguage]}` });
    await vscode.commands.executeCommand('vscode.diff', uri('before'), uri('after'), 'Review Embedded Source Edit');
    const answer = await vscode.window.showInformationMessage('Review the diff, then apply the fragment to the original source.', 'Apply Edit');
    if (answer === 'Apply Edit') await apply(preview.id);
  });

  command(revealCommand, async () => {
    const editor = vscode.window.activeTextEditor;
    return reveal(editor?.document, editor?.selection);
  });

  return { open, prepare, prepareVerified, apply, reveal, isProjection, dispose() {
    disposed = true;
    for (const session of sessions.values()) session.check?.abort();
    sessions.clear();
    reviews.clear();
    for (const disposable of disposables) disposable.dispose();
  } };
}

module.exports = { registerEmbeddedLanguage };
