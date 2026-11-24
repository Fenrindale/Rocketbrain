'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { statementAt } = require('../sql');
const { explanationHtml, comparisonHtml } = require('./explain-plan-view');
const { comparePlans, validatePlanQuery } = require('./explain-plan');

const VISUAL_EXPLAIN = 'rocketbrain.sql.explainVisual';
const MEASURE_PLAN = 'rocketbrain.sql.measurePlan';
const COMPARE_PLANS = 'rocketbrain.sql.comparePlans';
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
  const panels = new Map(), comparisons = new Set(), reviews = new Map();
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
    if (!record || record.report.engine !== 'mysql' || record.report.measured) throw Error('Open an estimated MySQL visual EXPLAIN plan to capture TREE text.');
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
    return capture({ source: captureSource(document, selection), target: database.savedQueryTarget(), cancellation });
  }

  function prepareMeasurement({ document, selection }) {
    trusted();
    const source = captureSource(document, selection);
    validatePlanQuery(source.sql, undefined, { measured: true });
    const target = database.savedQueryTarget();
    while (reviews.size >= MAX_PANELS) reviews.delete(reviews.keys().next().value);
    const id = randomUUID(), expiresAt = Date.now() + 120000;
    reviews.set(id, { source, target, expiresAt });
    return { id, expiresAt, destination: target.label };
  }

  async function measure(id, { confirmed, cancellation } = {}) {
    trusted(cancellation);
    if (confirmed !== true) throw Error('Approve execution of the selected SQL before measuring it.');
    const review = reviews.get(id);
    reviews.delete(id);
    if (!review || Date.now() >= review.expiresAt) throw Error('The query measurement review expired. Review the current query again.');
    return capture({ ...review, cancellation, measured: true });
  }

  async function capture({ source, target, cancellation, measured = false }) {
    trusted(cancellation);
    if (opening) throw Error('Wait for the current visual EXPLAIN capture.');
    if (panels.size >= MAX_PANELS) throw Error('Close a visual EXPLAIN panel before opening another.');
    const unchanged = () => {
      trusted(cancellation);
      if (source.document.isClosed || source.document.version !== source.version) throw Error('The SQL source changed before capture.');
      const current = database.savedQueryTarget();
      if (target.connectionEpoch !== current.connectionEpoch || target.key !== current.key) {
        throw Error('The database connection changed. Review the query again.');
      }
    };
    opening = true;
    try {
      unchanged();
      const report = measured
        ? await database.measureQueryPlan(source.sql, { confirmed: true, cancellation, beforeDispatch: unchanged })
        : await database.explainQueryPlan(source.sql, { cancellation, beforeDispatch: unchanged });
      unchanged();
      const id = randomUUID();
      const name = report.engine === 'mariadb' ? 'MariaDB' : 'MySQL';
      const panel = vscode.window.createWebviewPanel('rocketbrain.explainPlan', (measured ? 'Measured plan · ' : 'EXPLAIN · ') + name,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
      panels.set(id, { panel, report, source, target, capturedAt: new Date().toISOString() });
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

  function comparison(leftId, rightId) {
    trusted();
    const left = panels.get(leftId), right = panels.get(rightId);
    if (!left || !right || left === right || left.target.key !== right.target.key) {
      throw Error('Choose two open captures from the same database connection.');
    }
    return comparePlans(left.report, right.report);
  }

  async function chooseComparison() {
    trusted();
    const choices = [...panels].map(([id, record]) => ({
      id, label: record.report.measured ? 'Measured plan' : 'Optimizer estimate',
      description: record.capturedAt, detail: record.source.sql.replace(/\s+/g, ' ').slice(0, 180), record
    }));
    const compatible = (a, b) => a.id !== b.id && a.record.target.key === b.record.target.key &&
      a.record.report.engine === b.record.report.engine && a.record.report.version === b.record.report.version &&
      a.record.report.format === b.record.report.format && Boolean(a.record.report.measured) === Boolean(b.record.report.measured);
    const firstChoices = choices.filter(item => choices.some(other => compatible(item, other)));
    if (!firstChoices.length) throw Error('Open two plan captures from the same server and capture mode.');
    const left = await vscode.window.showQuickPick(firstChoices, { title: 'Compare Plans · Baseline' });
    if (!left) return;
    const right = await vscode.window.showQuickPick(choices.filter(item => compatible(left, item)), { title: 'Compare Plans · Candidate' });
    if (!right) return;
    return showComparison(left.id, right.id);
  }

  function showComparison(leftId, rightId) {
    if (comparisons.size >= 4) throw Error('Close a plan comparison before opening another.');
    const result = comparison(leftId, rightId);
    const panel = vscode.window.createWebviewPanel('rocketbrain.comparePlans', 'Compare SQL plans', vscode.ViewColumn.Beside,
      { enableScripts: false, localResourceRoots: [] });
    comparisons.add(panel);
    panel.onDidDispose(() => comparisons.delete(panel));
    panel.webview.html = comparisonHtml(result, randomBytes(24).toString('base64'));
    return result;
  }

  context.subscriptions.push(vscode.commands.registerCommand(VISUAL_EXPLAIN, async () => {
    try {
      const editor = vscode.window.activeTextEditor;
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Capture visual EXPLAIN', cancellable: true },
        (_, cancellation) => open({ document: editor?.document, selection: editor?.selection, cancellation }));
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand(MEASURE_PLAN, async () => {
    let review;
    try {
      const editor = vscode.window.activeTextEditor;
      review = prepareMeasurement({ document: editor?.document, selection: editor?.selection });
      const approval = await vscode.window.showWarningMessage('Run this read-only SQL on ' + review.destination + ' to measure its plan?',
        { modal: true, detail: 'The server executes the selected query in a separate read-only session. Rocketbrain requests a server timeout and closes its measurement connection on cancellation or timeout.' }, 'Measure plan');
      if (approval !== 'Measure plan') return;
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Measure SQL plan', cancellable: true },
        (_, cancellation) => measure(review.id, { confirmed: true, cancellation }));
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
    finally { if (review) reviews.delete(review.id); }
  }), vscode.commands.registerCommand(COMPARE_PLANS, async () => {
    try { return await chooseComparison(); }
    catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  return { open, revealSource, loadTree, prepareMeasurement, measure, comparison, showComparison, close(id) { panels.get(id)?.panel.dispose(); },
    dispose() {
      disposed = true;
      reviews.clear();
      for (const { panel } of panels.values()) panel.dispose();
      for (const panel of comparisons) panel.dispose();
      panels.clear();
      comparisons.clear();
    } };
}

module.exports = { registerExplainPlans, VISUAL_EXPLAIN };
