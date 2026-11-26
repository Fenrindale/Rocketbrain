'use strict';

const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { normalizeLocalChatTarget, cancelled } = require('../ai/local-chat');
const { explanationHtml } = require('./explain-plan-view');
const { relationshipOptions, projectGrounding, allowedColumn, prepareGroundedRequest, executeGroundedRequest } = require('./local-sql-grounding');

const section = 'rocketbrain.localSqlAssistant';
const commandId = section + '.grounded';

async function pickGroundedSqlRoute(vscode, catalog) {
  const edges = relationshipOptions(catalog);
  const roots = [...new Set(edges.flatMap(edge => [edge.table, edge.parent]))].sort();
  if (!roots.length) throw Error('No visible in-schema InnoDB foreign-key joins are available.');
  const root = await vscode.window.showQuickPick(roots, { title: 'Start a Grounded SQL Query', placeHolder: 'Choose the first table' });
  if (!root) return;
  const names = new Set([root]);
  const edgeIds = [];
  while (names.size < 4) {
    const options = edges.filter(edge => names.has(edge.table) !== names.has(edge.parent)).map(edge => ({
      label: `${edge.table} → ${edge.parent}`, description: edge.name,
      detail: edge.pairs.map(([from, to]) => `${from} = ${to}`).join(' AND '), edge }));
    if (edgeIds.length) options.unshift({ label: 'Choose Columns', detail: `Use the selected ${names.size} tables` });
    const choice = await vscode.window.showQuickPick(options, { title: 'Choose the Next Foreign-Key Join', ignoreFocusOut: true });
    if (!choice) return;
    if (!choice.edge) break;
    const { id, table, parent } = choice.edge;
    edgeIds.push(id);
    names.add(names.has(table) ? parent : table);
  }
  const selections = [];
  for (const table of names) {
    const columns = catalog.tables.find(item => item.name === table).columns;
    const selected = await vscode.window.showQuickPick(columns.filter(column => allowedColumn({ columns }, column.name))
      .map(column => ({ label: column.name, description: column.type })),
    { title: 'Share Selected Columns from ' + table, canPickMany: true, ignoreFocusOut: true });
    if (!selected?.length) return;
    selections.push({ table, columns: selected.map(column => column.label) });
  }
  return { root, edgeIds, selections };
}

function registerGroundedSqlAssistant(context, vscode, database) {
  const prepared = new Map();
  const proposals = new Map();
  const panels = new Set();
  let generation = 0, busy = false, disposed = false, active;

  function invalidate() {
    generation++;
    active?.abort();
    prepared.clear();
    proposals.clear();
  }

  function capture() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before sending schema context to a local model.');
    const identity = database.liveCatalogIdentity();
    if (!identity) throw Error('Connect to the MySQL or MariaDB schema to review a grounded query.');
    const settings = vscode.workspace.getConfiguration(section);
    return { ...normalizeLocalChatTarget(settings.get('endpoint'), settings.get('model')), connection: JSON.stringify(identity), generation };
  }

  function current(started) {
    if (disposed || !vscode.workspace.isTrusted || started.generation !== generation ||
        started.connection !== JSON.stringify(database.liveCatalogIdentity())) {
      throw Error('The database or local model configuration changed. Prepare the grounded request again.');
    }
  }

  async function liveContext(started, choices) {
    current(started);
    const catalog = await database.databaseCatalog();
    current(started);
    return projectGrounding(catalog, choices);
  }

  function remember(store, value) {
    while (store.size >= 8) store.delete(store.keys().next().value);
    const id = randomUUID();
    store.set(id, { ...value, expiresAt: Date.now() + 10 * 60 * 1000 });
    return id;
  }

  function find(store, id) {
    const value = store.get(id);
    if (!value || value.expiresAt <= Date.now()) {
      store.delete(id);
      throw Error('This grounded request or review expired. Start a new schema exploration.');
    }
    current(value.started);
    return value;
  }

  async function stage({ choices, previousId, input } = {}) {
    const started = capture();
    const previous = previousId === undefined ? undefined : find(proposals, previousId);
    if (previous && (!previous.reviewed || choices !== undefined)) throw Error('Review the current proposal before refining the exact same schema route.');
    const selected = structuredClone(previous?.choices ?? choices);
    const scope = await liveContext(started, selected);
    if (previous && scope.fingerprint !== previous.fingerprint) throw Error('The approved schema metadata changed. Choose the joins and columns again.');
    const request = prepareGroundedRequest({ ...started, context: scope, input, previous: previous?.result });
    const id = remember(prepared, { started, request, choices: selected });
    return { id, model: started.model, endpoint: started.endpoint, input: structuredClone(request.preview) };
  }

  async function draft(id, { confirmed, signal } = {}) {
    if (confirmed !== true) throw Error('Review the exact schema context and request before sending it to the local model.');
    const { started, request, choices } = find(prepared, id);
    prepared.delete(id);
    const scope = await liveContext(started, choices);
    if (scope.fingerprint !== request.context.fingerprint) throw Error('The approved schema metadata changed before the model request.');
    const result = await executeGroundedRequest(request, { signal });
    if (signal?.aborted) throw Error('The grounded model request was cancelled.');
    const after = await liveContext(started, choices);
    if (after.fingerprint !== scope.fingerprint) throw Error('The approved schema metadata changed during model inference.');
    if (signal?.aborted) throw Error('The grounded model request was cancelled.');
    const digest = createHash('sha256').update(result.sql).digest('hex');
    const proposalId = remember(proposals, { started, choices, result, digest, fingerprint: scope.fingerprint });
    return structuredClone({ id: proposalId, digest, ...result });
  }

  function review(id, { confirmed, digest } = {}) {
    const proposal = find(proposals, id);
    if (confirmed !== true || digest !== proposal.digest) throw Error('Review the exact generated SQL to continue this exploration.');
    proposal.reviewed = true;
  }

  async function inspect(id, { confirmed, digest, signal } = {}) {
    const proposal = find(proposals, id);
    if (confirmed !== true || !proposal.reviewed || digest !== proposal.digest) throw Error('Approve one estimated EXPLAIN for the exact reviewed proposal.');
    const { choices, result, fingerprint, started } = proposal;
    const report = await database.explainGroundedQuery(choices, result.plan, fingerprint, { signal,
      current: () => { current(started); return true; } });
    current(started);
    return report;
  }

  async function openDraft(id, digest) {
    const record = find(proposals, id);
    if (!record.reviewed || record.digest !== digest) throw Error('Review the current SQL before opening it in the editor.');
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: record.result.sql + '\n' });
    current(record.started);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  async function openPlan(id, options) {
    if (panels.size >= 8) throw Error('Close an estimated grounded SQL plan before opening another.');
    const report = await inspect(id, options);
    const panel = vscode.window.createWebviewPanel('rocketbrain.groundedPlan', 'Estimated Grounded SQL Plan', vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] });
    panels.add(panel);
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'copy' && vscode.workspace.isTrusted && panels.has(panel)) await vscode.env.clipboard.writeText(report.raw);
    });
    panel.onDidDispose(() => { panels.delete(panel); messages.dispose(); });
    panel.webview.html = explanationHtml(report, { nonce: randomBytes(24).toString('base64'), allowTreeCapture: false });
    return { report, panel };
  }

  async function progress(title, action) {
    const controller = new AbortController();
    active = controller;
    try {
      return await vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try { return await action(controller.signal); }
        finally { subscription.dispose(); }
      });
    } finally { active = undefined; }
  }

  async function interactive() {
    if (busy) throw Error('Finish or cancel the current grounded query exploration.');
    busy = true;
    try {
      const started = capture();
      const catalog = database.liveCatalogSnapshot();
      const choices = await pickGroundedSqlRoute(vscode, catalog);
      if (!choices) return;
      let previousId;
      for (;;) {
        current(started);
        const input = await vscode.window.showInputBox({ title: previousId ? 'Refine the Reviewed SQL Plan' : 'Draft a Grounded SQL Query',
          prompt: 'Select columns, aggregate, group, or sort across the chosen joins', ignoreFocusOut: true,
          validateInput: value => Buffer.byteLength(value) > 1024 ? 'Keep this request within 1 KiB.' : undefined });
        if (!input?.trim()) return;
        const request = await stage({ ...(previousId ? { previousId } : { choices }), input });
        const answer = await vscode.window.showInformationMessage('Send this exact schema context to the configured local model?',
          { modal: true, detail: `${request.model}\n${request.endpoint}\n\n${JSON.stringify(request.input, null, 2)}` }, 'Send to Local Model');
        if (answer !== 'Send to Local Model') return;
        const result = await progress('Drafting a Grounded SQL Query', signal => draft(request.id, { confirmed: true, signal }));
        const approved = await vscode.window.showInformationMessage('Review this SQL draft before inspecting its plan or refining it.',
          { modal: true, detail: `${result.sql}\n\nModel explanation\n${result.plan.explanation}` }, 'Review Draft');
        if (approved !== 'Review Draft') return;
        review(result.id, { confirmed: true, digest: result.digest });
        await openDraft(result.id, result.digest);
        let next = await vscode.window.showQuickPick(['Inspect Estimated Plan', 'Refine with Same Schema'], { title: 'Review Grounded SQL' });
        if (next === 'Inspect Estimated Plan') {
          const confirmed = await vscode.window.showInformationMessage('Ask the database for an estimated plan for this exact SQL?',
            { modal: true, detail: result.sql }, 'Run Estimated EXPLAIN');
          if (confirmed !== 'Run Estimated EXPLAIN') return;
          await progress('Obtaining Estimated SQL Plan', signal => openPlan(result.id, { confirmed: true, digest: result.digest, signal }));
          next = await vscode.window.showQuickPick(['Refine with Same Schema'], { title: 'Continue Grounded SQL Exploration' });
        }
        if (next !== 'Refine with Same Schema') return;
        previousId = result.id;
      }
    } finally { busy = false; }
  }

  context.subscriptions.push(database.onDidChangeDatabase(invalidate),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(section)) invalidate(); }),
    vscode.commands.registerCommand(commandId, async () => {
      try { return await interactive(); }
      catch (error) { if (error.code !== cancelled && !/cancelled/i.test(error.message)) void vscode.window.showErrorMessage(error.message); }
    }), { dispose() { disposed = true; invalidate(); for (const panel of panels) panel.dispose(); } });
  return { stage, draft, review, inspect, openDraft, openPlan };
}

module.exports = { registerGroundedSqlAssistant, pickGroundedSqlRoute };
