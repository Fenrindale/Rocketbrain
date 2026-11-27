'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { statementAt } = require('../sql');
const { isProfileConsole } = require('./profile-console-files');
const { sqlEditorForAction } = require('./sql-editor-target');
const { explanationHtml, comparisonHtml, seriesHtml } = require('./explain-plan-view');
const { comparePlans, comparablePlans, validatePlanQuery } = require('./explain-plan');
const { sampleCount, summarizeSeries, compareSeries, serializeSamples } = require('./explain-plan-series');
const { MAX_SAMPLE_FILE_BYTES, readSavedSamples } = require('./explain-plan-archive');
const { captureBinding, reviewKeyStore, serializePlanReview, readPlanReview, readSharedPlanReview,
  planReviewCandidates, applyPlanReview } = require('./explain-plan-review');

const VISUAL_EXPLAIN = 'rocketbrain.sql.explainVisual';
const MEASURE_PLAN = 'rocketbrain.sql.measurePlan';
const COMPARE_PLANS = 'rocketbrain.sql.comparePlans';
const MEASURE_SERIES = 'rocketbrain.sql.measurePlanSeries';
const COMPARE_SERIES = 'rocketbrain.sql.comparePlanSeries';
const EXPORT_SAMPLES = 'rocketbrain.sql.exportPlanSamples';
const OPEN_SAMPLES = 'rocketbrain.sql.openPlanSamples';
const MAX_PANELS = 8;
const hash = text => createHash('sha256').update(text).digest('hex');

function captureSource(document, selection, profileScoped = isProfileConsole) {
  if (profileScoped(document)) throw Error('Use an active database console for execution plan review. This SQL editor has a dedicated profile.');
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

async function writeNewFile(filePath, contents) {
  let file;
  try {
    file = await fs.open(filePath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('Choose a new file name to preserve the existing export.');
    throw error;
  }
  try {
    await file.writeFile(contents, 'utf8');
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    throw error;
  }
}

function registerExplainPlans(context, vscode, { database }) {
  const panels = new Map(), comparisons = new Map(), reviews = new Map();
  const seriesPanels = new Map(), seriesReviews = new Map();
  const signingKeys = reviewKeyStore(context.secrets);
  const profileScoped = database.isProfileSql ?? isProfileConsole;
  let disposed = false, opening = false;

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Use a trusted workspace to open and compare SQL plans.');
    if (cancellation?.isCancellationRequested) throw Error('Visual EXPLAIN was cancelled.');
  }

  async function revealSource(id) {
    trusted();
    const source = panels.get(id)?.source;
    if (!source) throw Error('Open an existing visual EXPLAIN plan with a source query.');
    if (source.document.isClosed && source.uri.scheme === 'untitled') throw Error('The unsaved source editor has closed.');
    const document = source.document.isClosed ? await vscode.workspace.openTextDocument(source.uri) : source.document;
    if (profileScoped(document)) throw Error('The SQL editor now uses a dedicated database profile.');
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
      if (profileScoped(source.document) || source.document.isClosed || hash(source.document.getText()) !== source.digest) {
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
    return capture({ source: captureSource(document, selection, profileScoped), target: database.savedQueryTarget(), cancellation });
  }

  function prepareMeasurement({ document, selection }) {
    trusted();
    const source = captureSource(document, selection, profileScoped);
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
    const unchanged = () => checkCapture(source, target, cancellation);
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

  function checkCapture(source, target, cancellation) {
    trusted(cancellation);
    if (profileScoped(source.document) || source.document.isClosed || source.document.version !== source.version) {
      throw Error('The SQL source or its connection changed before capture.');
    }
    const current = database.savedQueryTarget();
    if (target.connectionEpoch !== current.connectionEpoch || target.key !== current.key) {
      throw Error('The database connection changed. Review the query again.');
    }
  }

  function prepareSeries({ document, selection, samples }) {
    trusted();
    sampleCount(samples);
    const source = captureSource(document, selection, profileScoped);
    validatePlanQuery(source.sql, undefined, { measured: true });
    const target = database.savedQueryTarget();
    while (seriesReviews.size >= 4) seriesReviews.delete(seriesReviews.keys().next().value);
    const id = randomUUID(), expiresAt = Date.now() + 120000;
    seriesReviews.set(id, { source, target, expiresAt, samples });
    return { id, expiresAt, samples, destination: target.label, queryPreview:source.sql.trim().slice(0, 180) };
  }

  async function measureSeries(id, { confirmed, cancellation, onProgress } = {}) {
    trusted(cancellation);
    if (confirmed !== true) throw Error('Approve the repeated executions before measuring the series.');
    const review = seriesReviews.get(id);
    seriesReviews.delete(id);
    if (!review || Date.now() >= review.expiresAt) throw Error('The measurement series review expired.');
    if (opening) throw Error('Wait for the current plan capture.');
    if (seriesPanels.size >= 4) throw Error('Close a measurement series before capturing another.');
    const unchanged = () => checkCapture(review.source, review.target, cancellation);
    const plans = [];
    opening = true;
    try {
      for (let index = 0; index < review.samples; index++) {
        unchanged();
        const plan = await database.measureQueryPlan(review.source.sql, { confirmed: true, cancellation, beforeDispatch: unchanged });
        unchanged();
        plans.push(plan);
        await onProgress?.({ completed: plans.length, total: review.samples });
      }
      unchanged();
      return showSeries({ series:summarizeSeries(plans), plans, target:review.target, source:review.source, capturedAt:new Date().toISOString() });
    } finally { opening = false; }
  }

  function showSeries(record) {
    const { series, plans, fileName } = record, id = randomUUID();
    const title = fileName ? 'Saved SQL plan samples · ' + fileName : 'SQL measurement series · ' + series.engine;
    const panel = vscode.window.createWebviewPanel('rocketbrain.planSeries', title, vscode.ViewColumn.Beside,
      { enableScripts:false, localResourceRoots:[] });
    seriesPanels.set(id, { ...record, panel });
    panel.onDidDispose(() => seriesPanels.delete(id));
    panel.webview.html = seriesHtml({ ...series, saved:Boolean(fileName) }, plans, randomBytes(24).toString('base64'));
    return { id, saved:Boolean(fileName), ...structuredClone(series) };
  }

  function getSample(id, index) {
    trusted();
    const plan = Number.isInteger(index) && seriesPanels.get(id)?.plans[index];
    if (!plan) throw Error('Choose an available sample from an open series.');
    return structuredClone(plan);
  }

  async function exportSamples(id, uri) {
    trusted();
    const record = seriesPanels.get(id);
    if (!record) throw Error('Choose an open measurement series.');
    if (uri?.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.json') {
      throw Error('Choose a local JSON file for the measurement samples.');
    }
    const contents = serializeSamples(record.series, record.plans, record.capturedAt);
    if (Buffer.byteLength(contents) > MAX_SAMPLE_FILE_BYTES) throw Error('SQL plan sample files must be at most 32 MiB.');
    await writeNewFile(uri.fsPath, contents);
    return { uri:uri.toString(), samples:record.plans.length };
  }

  async function openSavedSamples(uri) {
    trusted();
    if (uri?.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.json') {
      throw Error('Choose a local JSON file containing saved SQL plan samples.');
    }
    if (opening) throw Error('Wait for the current SQL plan capture or file.');
    if (seriesPanels.size >= 4) throw Error('Close a measurement series before opening another.');
    opening = true;
    try {
      const record = await readSavedSamples(uri.fsPath);
      trusted();
      return showSeries({ ...record, fileName:path.basename(uri.fsPath) });
    } finally { opening = false; }
  }

  function seriesCompatible(left, right) {
    return left && right && left !== right && comparablePlans(left.series, right.series) &&
      Boolean(left.fileName || right.fileName || left.target.key === right.target.key);
  }

  function comparableSeries(leftId, rightId) {
    trusted();
    const left = seriesPanels.get(leftId), right = seriesPanels.get(rightId);
    if (!seriesCompatible(left, right)) {
      throw Error('Choose compatible SQL plan series. Live captures require the same connection.');
    }
    return [left, right];
  }

  function seriesComparison(leftId, rightId) {
    const [left, right] = comparableSeries(leftId, rightId);
    return { ...compareSeries(left.series, right.series), saved:Boolean(left.fileName || right.fileName) };
  }

  function showSeriesComparison(leftId, rightId) {
    const [left, right] = comparableSeries(leftId, rightId);
    const binding = captureBinding('series', left, right);
    return openComparison('rocketbrain.comparePlanSeries', 'Compare SQL measurement series', binding,
      decisions => ({ ...compareSeries(left.series, right.series, decisions), saved:Boolean(left.fileName || right.fileName) }),
      (report, nonce) => seriesHtml(report, null, nonce));
  }

  function seriesChoices() {
    return [...seriesPanels].map(([id, record]) => ({
      id, record, label: record.series.totalSamples + ' samples · ' + record.series.database, description: record.capturedAt,
      detail:record.fileName ? 'Saved file · ' + record.fileName : record.source.sql.replace(/\s+/g, ' ').slice(0, 150)
    }));
  }

  async function chooseSeriesComparison() {
    trusted();
    const choices = seriesChoices();
    const compatible = (a, b) => seriesCompatible(a.record, b.record);
    const possible = choices.filter(item => choices.some(other => compatible(item, other)));
    if (!possible.length) throw Error('Open two comparable SQL measurement series.');
    const left = await vscode.window.showQuickPick(possible, { title:'Compare Measurement Series · Baseline' });
    if (!left) return;
    const right = await vscode.window.showQuickPick(possible.filter(item => compatible(left, item)), { title:'Compare Measurement Series · Candidate' });
    if (right) return showSeriesComparison(left.id, right.id);
  }

  function comparableCaptures(leftId, rightId) {
    trusted();
    const left = panels.get(leftId), right = panels.get(rightId);
    if (!left || !right || left === right || left.target.key !== right.target.key) {
      throw Error('Choose two open captures from the same database connection.');
    }
    return [left, right];
  }

  function comparison(leftId, rightId) {
    const [left, right] = comparableCaptures(leftId, rightId);
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
    const [left, right] = comparableCaptures(leftId, rightId);
    return openComparison('rocketbrain.comparePlans', 'Compare SQL plans', captureBinding('plan', left, right),
      decisions => comparePlans(left.report, right.report, decisions), comparisonHtml);
  }

  function openComparison(viewType, title, binding, compare, render) {
    if (comparisons.size >= 4) throw Error('Close a plan comparison before opening another.');
    const reviewId = randomUUID(), decisions = new Map(), report = compare(decisions);
    const enableScripts = report.candidateReview.pairs.length > 0;
    const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Beside,
      { enableScripts, localResourceRoots:[] });
    const record = { panel, binding, compare, render, decisions, report, sharedReview:undefined };
    comparisons.set(reviewId, record);
    panel.onDidDispose(() => comparisons.delete(reviewId));
    if (enableScripts) panel.webview.onDidReceiveMessage(async message => {
      if (message?.type !== 'review-plan-candidate') return;
      try {
        switch (message.action) {
          case 'save': case 'load': case 'share-open': await selectReviewFile(reviewId, message.action); break;
          case 'share-approve': setSharedReviewChoice(reviewId, message.draftId, message.candidateId, 'approve'); break;
          case 'share-skip': setSharedReviewChoice(reviewId, message.draftId, message.candidateId, 'skip'); break;
          case 'share-apply':
            applySharedComparisonReview(reviewId, message.draftId);
            void vscode.window.showInformationMessage('Approved SQL plan review decisions applied.');
            break;
          case 'share-cancel': cancelSharedComparisonReview(reviewId, message.draftId); break;
          default: updateReview(reviewId, message);
        }
      }
      catch (error) { void vscode.window.showErrorMessage(error.message); }
    });
    renderReview(reviewId, record, report);
    return structuredClone({ ...report, reviewId });
  }

  function openReview(reviewId) {
    trusted();
    const record = comparisons.get(reviewId);
    if (!record) throw Error('The SQL plan comparison is closed.');
    return record;
  }

  function renderReview(reviewId, record, report, sharedReview) {
    record.panel.webview.html = record.render({ ...report, reviewId, sharedReview }, randomBytes(24).toString('base64'));
  }

  function publishReview(reviewId, record, decisions, report) {
    renderReview(reviewId, record, report);
    record.decisions = decisions;
    record.report = report;
    record.sharedReview = undefined;
    return report;
  }

  function updateReview(reviewId, { action, candidateId } = {}) {
    const record = openReview(reviewId);
    const decisions = new Map(record.decisions);
    if (action === 'reset') decisions.clear();
    else if (action === 'accept' || action === 'ignore') {
      const pair = record.report.candidateReview.pairs.find(item => item.id === candidateId);
      if (pair?.status !== 'pending') throw Error('Choose an available pair in this SQL plan comparison.');
      decisions.set(candidateId, action === 'accept' ? 'accepted' : 'ignored');
    } else throw Error('Choose a SQL plan review action.');
    return publishReview(reviewId, record, decisions, record.compare(decisions));
  }

  function reviewComparison(reviewId, action) {
    return structuredClone({ ...updateReview(reviewId, action), reviewId });
  }

  function checkReviewFile(uri) {
    if (uri?.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.json') {
      throw Error('Choose a local JSON file for the SQL plan review.');
    }
  }

  function unchangedReview(reviewId, decisions) {
    if (openReview(reviewId).decisions !== decisions) throw Error('The SQL plan review changed while opening the file. Try again.');
  }

  async function saveComparisonReview(reviewId, uri) {
    const record = openReview(reviewId), decisions = record.decisions;
    checkReviewFile(uri);
    const contents = await serializePlanReview(record.binding, record.report.candidateReview.pairs, decisions, signingKeys);
    unchangedReview(reviewId, decisions);
    await writeNewFile(uri.fsPath, contents);
    return { uri:uri.toString(), decisions:decisions.size };
  }

  async function loadComparisonReview(reviewId, uri) {
    const record = openReview(reviewId), current = record.decisions;
    checkReviewFile(uri);
    const saved = await readPlanReview(uri.fsPath, signingKeys);
    unchangedReview(reviewId, current);
    const { report, decisions } = applyPlanReview(saved, record.binding, record.report.candidateReview.pairs, current, record.compare);
    publishReview(reviewId, record, decisions, report);
    return structuredClone({ ...report, reviewId });
  }

  function showSharedReview(reviewId, record, draft) {
    const candidates = draft.candidates.map(({ pair, suggested }) => ({
      ...pair, suggested, choice:draft.choices.get(pair.id) ?? 'pending'
    }));
    const view = {
      id:draft.id, signerVerified:false, candidates,
      ready:candidates.length === draft.choices.size && [...draft.choices.values()].includes('approve')
    };
    renderReview(reviewId, record, record.report, view);
    record.sharedReview = draft;
    return structuredClone(view);
  }

  async function prepareSharedComparisonReview(reviewId, uri) {
    const record = openReview(reviewId), { decisions, sharedReview } = record;
    checkReviewFile(uri);
    const payload = await readSharedPlanReview(uri.fsPath, signingKeys);
    unchangedReview(reviewId, decisions);
    if (record.sharedReview !== sharedReview) throw Error('The shared SQL plan review changed while opening the file. Try again.');
    const candidates = planReviewCandidates(payload, record.binding, record.report.candidateReview.pairs);
    return showSharedReview(reviewId, record, { id:randomUUID(), payload, candidates, choices:new Map() });
  }

  function openSharedReview(reviewId, draftId) {
    const record = openReview(reviewId);
    const draft = record.sharedReview;
    if (!draft || draft.id !== draftId) throw Error('Open the shared SQL plan review again.');
    return { record, draft };
  }

  function setSharedReviewChoice(reviewId, draftId, candidateId, choice) {
    const { record, draft } = openSharedReview(reviewId, draftId);
    if (!draft.candidates.some(({ pair }) => pair.id === candidateId) || !['approve', 'skip'].includes(choice)) {
      throw Error('Choose Approve or Skip for a candidate in this shared SQL plan review.');
    }
    const choices = new Map(draft.choices).set(candidateId, choice);
    return showSharedReview(reviewId, record, { ...draft, choices });
  }

  function applySharedComparisonReview(reviewId, draftId) {
    const { record, draft } = openSharedReview(reviewId, draftId);
    if (draft.choices.size !== draft.candidates.length) {
      throw Error('Approve or skip every candidate in this shared SQL plan review before applying.');
    }
    const { binding, decisions:current, report:original, compare } = record;
    const pairs = original.candidateReview.pairs;
    planReviewCandidates(draft.payload, binding, pairs);
    const approved = draft.payload.decisions.filter(([id]) => draft.choices.get(id) === 'approve');
    if (!approved.length) throw Error('Approve at least one candidate or cancel the shared SQL plan review.');
    const { report, decisions } = applyPlanReview({ ...draft.payload, decisions:approved }, binding, pairs, current, compare);
    publishReview(reviewId, record, decisions, report);
    return structuredClone({ ...report, reviewId });
  }

  function cancelSharedComparisonReview(reviewId, draftId) {
    const { record } = openSharedReview(reviewId, draftId);
    renderReview(reviewId, record, record.report);
    record.sharedReview = undefined;
  }

  async function selectReviewFile(reviewId, action) {
    const record = openReview(reviewId), { decisions:current, sharedReview } = record;
    const filters = { 'SQL plan review': ['json'] };
    if (action === 'save') {
      const file = await vscode.window.showSaveDialog({ title:'Save SQL Plan Review', filters });
      if (!file) return;
      unchangedReview(reviewId, current);
      await saveComparisonReview(reviewId, file);
      void vscode.window.showInformationMessage('SQL plan review saved.');
    } else {
      const sharing = action === 'share-open';
      const [file] = await vscode.window.showOpenDialog({
        title:sharing ? 'Review Shared SQL Plan File' : 'Load SQL Plan Review', filters, canSelectMany:false
      }) ?? [];
      if (!file) return;
      unchangedReview(reviewId, current);
      if (sharing) {
        if (record.sharedReview !== sharedReview) throw Error('The shared SQL plan review changed while choosing the file. Try again.');
        return prepareSharedComparisonReview(reviewId, file);
      }
      await loadComparisonReview(reviewId, file);
      void vscode.window.showInformationMessage('SQL plan review applied.');
    }
  }

  context.subscriptions.push(vscode.commands.registerCommand(VISUAL_EXPLAIN, async resource => {
    try {
      const editor = sqlEditorForAction(vscode, resource);
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
  }), vscode.commands.registerCommand(MEASURE_SERIES, async () => {
    let review;
    try {
      const editor = vscode.window.activeTextEditor, document = editor?.document, selection = editor?.selection;
      const version = document?.version;
      const count = await vscode.window.showQuickPick(['2', '3', '4', '5'], { title:'Number of read-only executions' });
      if (!count) return;
      if (document?.version !== version || vscode.window.activeTextEditor !== editor) throw Error('The SQL editor changed. Review the query again.');
      review = prepareSeries({ document, selection, samples:Number(count) });
      const action = 'Run ' + count + ' measurements';
      const approved = await vscode.window.showWarningMessage(action + ' on ' + review.destination + '?',
        { modal:true, detail:review.queryPreview + '\n\nRuns the selected SQL sequentially in separate read-only sessions.' }, action);
      if (approved !== action) return;
      return await vscode.window.withProgress({ location:vscode.ProgressLocation.Notification, title:'Measure SQL plan series', cancellable:true },
        (progress, cancellation) => measureSeries(review.id, { confirmed:true, cancellation,
          onProgress:({ completed,total })=>progress.report({ increment:100/total, message:completed+' / '+total }) }));
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
    finally { if (review) seriesReviews.delete(review.id); }
  }), vscode.commands.registerCommand(COMPARE_SERIES, async () => {
    try { return await chooseSeriesComparison(); }
    catch (error) { await vscode.window.showErrorMessage(error.message); }
  }), vscode.commands.registerCommand(EXPORT_SAMPLES, async () => {
    try {
      trusted();
      const choices = seriesChoices();
      if (!choices.length) throw Error('Open a SQL measurement series before exporting samples.');
      const series = await vscode.window.showQuickPick(choices, { title:'Choose a SQL measurement series' });
      if (!series) return;
      const uri = await vscode.window.showSaveDialog({
        title:'Export SQL Plan Samples (includes raw server plans)', filters:{ 'Plan samples JSON':['json'] }
      });
      if (!uri) return;
      const result = await exportSamples(series.id, uri);
      void vscode.window.showInformationMessage('Exported ' + result.samples + ' SQL plan samples.');
      return result;
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  }), vscode.commands.registerCommand(OPEN_SAMPLES, async () => {
    try {
      trusted();
      const [uri] = await vscode.window.showOpenDialog({
        title:'Open Saved SQL Plan Samples', canSelectMany:false, filters:{ 'Plan samples JSON':['json'] }
      }) || [];
      if (uri) return await openSavedSamples(uri);
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  return { open, revealSource, loadTree, prepareMeasurement, measure, comparison, showComparison, close(id) { panels.get(id)?.panel.dispose(); },
    prepareSeries, measureSeries, getSample, exportSamples, openSavedSamples, seriesComparison, showSeriesComparison,
    reviewComparison, saveComparisonReview, loadComparisonReview, prepareSharedComparisonReview, setSharedReviewChoice,
    applySharedComparisonReview, cancelSharedComparisonReview, closeComparison(id) { comparisons.get(id)?.panel.dispose(); },
    closeSeries(id) { seriesPanels.get(id)?.panel.dispose(); },
    dispose() {
      disposed = true;
      reviews.clear();
      seriesReviews.clear();
      for (const { panel } of panels.values()) panel.dispose();
      for (const { panel } of seriesPanels.values()) panel.dispose();
      for (const { panel } of comparisons.values()) panel.dispose();
      panels.clear();
      seriesPanels.clear();
      comparisons.clear();
    } };
}

module.exports = { registerExplainPlans, VISUAL_EXPLAIN };
