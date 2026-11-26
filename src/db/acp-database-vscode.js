'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { projectGrounding } = require('./local-sql-grounding');
const { pickGroundedSqlRoute } = require('./local-sql-grounding-vscode');
const { prepareDatabaseAgents, prepareDatabaseTasks, createDatabaseTaskReview, executeDatabaseAgent } = require('./acp-database-tasks');
const { proposalReviewHtml } = require('./sql-proposal-review-view');
const { explanationHtml } = require('./explain-plan-view');

const command = 'rocketbrain.acp.reviewDatabase';
const providerSection = 'rocketbrain.localSqlAssistant';
const profileSection = 'rocketbrain.acp.databaseAgents';
const panelType = 'rocketbrain.databaseAcpTasks';

function registerDatabaseAcp(context, vscode, database) {
  let generation = 0, disposed = false, staged, active, panel, preparing = false;
  const planPanels = new Set();

  function capture() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before starting database ACP tasks.');
    const identity = database.liveCatalogIdentity();
    if (!identity) throw Error('Connect to a live MySQL or MariaDB catalog first.');
    return { generation, identity: JSON.stringify(identity) };
  }

  function current(started) {
    const now = capture();
    if (now.generation !== started.generation || now.identity !== started.identity) throw Error('The database or local agent settings changed. Review the current context again.');
    return true;
  }

  const profiles = () => vscode.workspace.getConfiguration('rocketbrain.acp').get('databaseAgents', []).slice(0, 20);
  function publish() { if (panel) void panel.webview.postMessage({ type: 'state', state: active?.review.snapshot(), preparing }); }

  function invalidate() {
    generation++;
    staged = undefined;
    active?.review.invalidate();
    active?.planController?.abort();
    publish();
  }

  async function stage({ choices, tasks } = {}) {
    const started = capture();
    if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 3) throw Error('Prepare two or three database tasks.');
    const configured = profiles();
    const labels = [...new Set(tasks.map(task => task?.profile))];
    const picked = labels.flatMap(label => configured.filter(config => typeof config?.label === 'string' && config.label.trim() === label));
    if (picked.length !== labels.length || labels.some(label => !picked.some(profile => profile.label.trim() === label))) {
      throw Error('Each task must select one uniquely configured database ACP profile.');
    }
    const settings = vscode.workspace.getConfiguration(providerSection);
    const model = { endpoint: settings.get('endpoint'), model: settings.get('model') };
    const [catalog, agents] = await Promise.all([database.databaseCatalog(), prepareDatabaseAgents(picked, model)]);
    current(started);
    const batch = prepareDatabaseTasks({ catalog, agents, choices, tasks });
    staged = { started, batch, id: randomUUID(), expiresAt: Date.now() + 120000 };
    return { id: staged.id, ...structuredClone(batch.preview) };
  }

  async function start(id, { confirmed } = {}) {
    if (confirmed !== true || !staged || staged.id !== id || staged.expiresAt <= Date.now()) {
      throw Error('Review the exact agent executables, arguments, and task context before sending.');
    }
    const { batch, started } = staged;
    staged = undefined;
    current(started);
    const live = await database.databaseCatalog();
    current(started);
    if (projectGrounding(live, batch.choices).fingerprint !== batch.scope.fingerprint) throw Error('The selected schema changed before the ACP tasks started.');
    active?.review.invalidate();
    active?.planController?.abort();
    const review = createDatabaseTaskReview(batch, { onChange: publish, async execute(agent, intent, options) {
      const result = await executeDatabaseAgent(agent, intent, options);
      if (options.signal.aborted) throw Error('The database ACP task was cancelled.');
      const observed = await database.databaseCatalog();
      current(started);
      if (projectGrounding(observed, batch.choices).fingerprint !== batch.scope.fingerprint) {
        throw Error('The selected schema changed while the ACP task was running.');
      }
      return result;
    } });
    const record = { batch, started, review };
    active = record;
    return review.start();
  }

  function owned(reviewId) {
    if (!active || active.review.snapshot().id !== reviewId) throw Error('Open the current database task review first.');
    current(active.started);
    return active;
  }

  function accept({ reviewId, jobId, fingerprint, confirmed } = {}) {
    if (confirmed !== true) throw Error('Review the exact SQL before accepting an ACP task.');
    owned(reviewId).review.accept(jobId, fingerprint);
  }

  async function inspect({ reviewId, jobId, fingerprint, confirmed, signal } = {}) {
    if (confirmed !== true) throw Error('Separately approve the estimated plan for the exact SQL.');
    const record = owned(reviewId);
    const { plan } = record.review.result(jobId, fingerprint, true);
    if (record.planController) throw Error('Wait for the active estimated plan inspection.');
    const controller = new AbortController();
    record.planController = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const valid = () => {
      owned(reviewId).review.result(jobId, fingerprint, true);
      return true;
    };
    try {
      const report = await database.explainGroundedQuery(record.batch.choices, plan, record.batch.scope.fingerprint,
        { signal: controller.signal, current: valid });
      valid();
      return report;
    } finally {
      record.planController = undefined;
      signal?.removeEventListener('abort', cancel);
    }
  }

  async function openDraft({ reviewId, jobId, fingerprint } = {}) {
    const result = owned(reviewId).review.result(jobId, fingerprint, true);
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: result.sql + '\n' });
    owned(reviewId).review.result(jobId, fingerprint, true);
    return vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  async function openEstimatedPlan(approval) {
    if (planPanels.size >= 6) throw Error('Close an estimated plan before opening another.');
    const report = await inspect(approval);
    const view = vscode.window.createWebviewPanel('rocketbrain.databaseAcpPlan', 'Estimated ACP SQL Plan', vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] });
    planPanels.add(view);
    const messaging = view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'copy' && vscode.workspace.isTrusted && planPanels.has(view)) void vscode.env.clipboard.writeText(report.raw);
    });
    view.onDidDispose(() => { planPanels.delete(view); messaging.dispose(); });
    view.webview.html = explanationHtml(report, { nonce: randomBytes(24).toString('base64'), allowTreeCapture: false });
    return { report, view };
  }

  async function choose() {
    if (preparing || active?.review.snapshot().jobs.some(job => job.status === 'running')) return;
    preparing = true;
    publish();
    try {
      const started = capture();
      const configured = profiles().filter(profile => typeof profile?.label === 'string');
      if (!configured.length) throw Error('Configure rocketbrain.acp.databaseAgents before reviewing database tasks.');
      const choices = await pickGroundedSqlRoute(vscode, database.liveCatalogSnapshot());
      if (!choices || !panel) return;
      const tasks = [];
      for (let slot = 1; slot <= 3; slot++) {
        const input = await vscode.window.showInputBox({ title: 'Database ACP Task ' + slot,
          prompt: slot === 3 ? 'Describe another read-only result or leave blank' : 'Describe the result to draft across the selected joins',
          ignoreFocusOut: true, validateInput: value => Buffer.byteLength(value) > 1024 ? 'Keep the task within 1 KiB.' : undefined });
        if (input === undefined || !panel) return;
        if (!input.trim() && slot === 3) break;
        if (!input.trim()) return;
        const profile = await vscode.window.showQuickPick(configured.map(item => item.label.trim()),
          { title: 'Choose the Local ACP Profile for Task ' + slot });
        if (!profile || !panel) return;
        tasks.push({ profile, input });
      }
      current(started);
      const prepared = await stage({ choices, tasks });
      const detail = prepared.tasks.map(task => `${task.agent}\n${task.executable}\n${JSON.stringify(task.args)}\nSHA-256 ${task.sha256}\n` +
        (task.endpoint ? `${task.model} at ${task.endpoint}\n` : '') + task.text).join('\n\n');
      const approval = await vscode.window.showWarningMessage('Start these exact local ACP tasks?', { modal: true,
        detail: 'Run only trusted local programs. Each peer runs as your operating-system account.\n\n' + detail }, 'Start Tasks');
      if (approval === 'Start Tasks' && panel) {
        await start(prepared.id, { confirmed: true });
      }
    } finally { preparing = false; publish(); }
  }

  async function handle(message) {
    if (message?.type === 'ready') return publish();
    if (message?.type === 'start') return choose();
    const { type, reviewId, jobId, fingerprint } = message ?? {};
    const { review } = owned(reviewId);
    if (type === 'cancel') return review.cancel(jobId);
    if (type === 'reject') return review.reject(jobId, fingerprint);
    if (type === 'open') {
      await openDraft({ reviewId, jobId, fingerprint });
      return publish();
    }
    if (type === 'accept' || type === 'inspect') {
      const { sql } = review.result(jobId, fingerprint, type === 'inspect');
      const action = type === 'accept' ? 'Review Exact SQL' : 'Run Estimated EXPLAIN';
      const reply = await vscode.window.showInformationMessage(type === 'accept' ? 'Mark this generated SQL as reviewed?' :
        'Obtain an estimated plan for this reviewed SQL?', { modal: true, detail: sql }, action);
      if (reply !== action || !panel) return publish();
      const approval = { reviewId, jobId, fingerprint, confirmed: true };
      if (type === 'accept') return accept(approval);
      await openEstimatedPlan(approval);
      return publish();
    }
  }

  function open() {
    capture();
    if (panel) return panel.reveal();
    const created = vscode.window.createWebviewPanel(panelType, 'Database ACP Task Review', vscode.ViewColumn.Active,
      { enableScripts: true, enableCommandUris: false, localResourceRoots: [] });
    panel = created;
    const messaging = created.webview.onDidReceiveMessage(message => {
      void handle(message).catch(error => { if (panel === created) { void vscode.window.showErrorMessage(error.message); publish(); } });
    });
    created.onDidDispose(() => { messaging.dispose(); panel = undefined; invalidate(); });
    created.webview.html = proposalReviewHtml(randomBytes(24).toString('base64'), { databaseTasks: true });
    return created;
  }

  context.subscriptions.push(vscode.commands.registerCommand(command, () => {
    try { return open(); }
    catch (error) { void vscode.window.showErrorMessage(error.message); }
  }), database.onDidChangeDatabase(invalidate),
  vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(profileSection) || event.affectsConfiguration(providerSection)) invalidate(); }),
  { dispose() { disposed = true; panel?.dispose(); invalidate(); for (const view of planPanels) view.dispose(); } });
  return { stage, start, accept, inspect, openDraft, openEstimatedPlan,
    cancel(reviewId, jobId) { owned(reviewId).review.cancel(jobId); },
    reject(reviewId, jobId, fingerprint) { owned(reviewId).review.reject(jobId, fingerprint); } };
}

module.exports = { registerDatabaseAcp };
