'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { statementAt } = require('../sql');
const { explanationHtml } = require('./explain-plan-view');

const VISUAL_EXPLAIN = 'rocketbrain.sql.explainVisual';
const MAX_PANELS = 8;
const hash = text => createHash('sha256').update(text).digest('hex');

function captureSource(document, selection) {
  if (!document || document.isClosed || document.languageId !== 'sql' || !selection) {
    throw Error('Open a SQL editor and select a query or place the cursor in one.');
  }
  const text = document.getText();
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('Open a SQL document smaller than 8 MiB to explain a query.');
  const active = document.offsetAt(selection.active);
  const start = document.offsetAt(selection.start), end = document.offsetAt(selection.end);
  const sql = selection.isEmpty ? statementAt(text, active) : text.slice(start, end);
  return { document, uri: document.uri, version: document.version, active, start, end, digest: hash(text), sql };
}

function registerExplainPlans(context, vscode, { database }) {
  const panels = new Map();
  let disposed = false, opening = false;

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace and connect to MySQL or MariaDB first.');
    if (cancellation?.isCancellationRequested) throw Error('Visual EXPLAIN was cancelled.');
  }

  async function revealSource(id) {
    trusted();
    const source = panels.get(id)?.source;
    if (!source) throw Error('Open an existing visual EXPLAIN plan with a source query.');
    if (source.document.isClosed && source.uri.scheme === 'untitled') throw Error('The unsaved source editor has closed.');
    const document = source.document.isClosed ? await vscode.workspace.openTextDocument(source.uri) : source.document;
    if (hash(document.getText()) !== source.digest) throw Error('The SQL source changed after capture. Explain the current query again.');
    trusted();
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const from = document.positionAt(source.active === source.start ? source.end : source.start);
    const to = document.positionAt(source.active);
    editor.selection = new vscode.Selection(from, to);
    editor.revealRange(editor.selection);
    return document.uri.toString();
  }

  async function loadTree(id, cancellation) {
    trusted(cancellation);
    const record = panels.get(id);
    if (!record || record.report.engine !== 'mysql') throw Error('Open a MySQL visual EXPLAIN plan to capture TREE text.');
    if (record.tree) return structuredClone(record.tree);
    if (record.loadingTree) throw Error('Wait for the current MySQL TREE capture.');
    const { source, target } = record;
    const current = () => {
      trusted(cancellation);
      const connection = database.savedQueryTarget();
      if (!panels.has(id) || connection.key !== target.key || connection.connectionEpoch !== target.connectionEpoch) {
        throw Error('The plan or its database connection changed. Capture a new visual EXPLAIN plan.');
      }
      if (source.document.isClosed || hash(source.document.getText()) !== source.digest) {
        throw Error('The SQL source changed after capture. Explain the current query again.');
      }
    };
    current();
    record.loadingTree = true;
    try {
      const result = await database.explainQueryPlan(source.sql, { format: 'tree', cancellation, beforeDispatch: current });
      current();
      record.tree = result;
      return structuredClone(result);
    } finally { record.loadingTree = false; }
  }

  async function open({ document, selection, cancellation } = {}) {
    trusted(cancellation);
    if (opening) throw Error('Wait for the current visual EXPLAIN capture.');
    if (panels.size >= MAX_PANELS) throw Error('Close a visual EXPLAIN panel before opening another.');
    const source = captureSource(document, selection);
    const unchanged = () => {
      trusted(cancellation);
      if (document.isClosed || document.version !== source.version) throw Error('The SQL source changed before capture.');
    };
    opening = true;
    try {
      const target = database.savedQueryTarget();
      const report = await database.explainQueryPlan(source.sql, { cancellation, beforeDispatch: unchanged });
      unchanged();
      const id = randomUUID();
      const name = report.engine === 'mariadb' ? 'MariaDB' : 'MySQL';
      const panel = vscode.window.createWebviewPanel('rocketbrain.explainPlan', 'EXPLAIN · ' + name,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
      panels.set(id, { panel, report, source, target });
      panel.onDidDispose(() => panels.delete(id));
      panel.webview.onDidReceiveMessage(async message => {
        try {
          if (message?.type === 'source') await revealSource(id);
          if (message?.type === 'copy') {
            trusted();
            const saved = panels.get(id)?.report;
            if (saved) await vscode.env.clipboard.writeText(saved.raw);
          }
          if (message?.type === 'tree') {
            const tree = await loadTree(id);
            await panel.webview.postMessage({ type: 'tree', text: tree.raw });
          }
          if (message?.type === 'copy-tree') {
            trusted();
            const tree = panels.get(id)?.tree;
            if (tree) await vscode.env.clipboard.writeText(tree.raw);
          }
        } catch (error) {
          if (message?.type === 'tree') await panel.webview.postMessage({ type: 'tree-error', text: error.message });
          else await vscode.window.showErrorMessage(error.message);
        }
      });
      panel.webview.html = explanationHtml(report, { nonce: randomBytes(24).toString('base64'), source: true });
      return { id, ...structuredClone(report) };
    } finally { opening = false; }
  }

  context.subscriptions.push(vscode.commands.registerCommand(VISUAL_EXPLAIN, async () => {
    try {
      const editor = vscode.window.activeTextEditor;
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Capture visual EXPLAIN', cancellable: true },
        (_, cancellation) => open({ document: editor?.document, selection: editor?.selection, cancellation }));
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  return { open, revealSource, loadTree, close(id) { panels.get(id)?.panel.dispose(); },
    dispose() { disposed = true; for (const { panel } of panels.values()) panel.dispose(); panels.clear(); } };
}

module.exports = { registerExplainPlans, VISUAL_EXPLAIN };
