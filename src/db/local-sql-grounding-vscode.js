'use strict';

const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { normalizeLocalChatTarget, cancelled } = require('../ai/local-chat');
const { explanationHtml } = require('./explain-plan-view');
const { relationshipOptions, projectGrounding, allowedColumn, prepareGroundedRequest, executeGroundedRequest } = require('./local-sql-grounding');

const section = 'rocketbrain.localSqlAssistant';
const commandId = section + '.grounded';
const continueId = section + '.continueGrounded';
const transcriptId = section + '.groundedTranscript';
const transcriptScheme = 'rocketbrain-sql-exploration';
const lifetime = 10 * 60 * 1000;
const maxExplorations = 4;
const maxTurns = 4;
const maxRequests = 6;

function planChanges(previous, plan) {
  return Object.fromEntries(['columns', 'measures', 'sort', 'limit'].flatMap(key =>
    JSON.stringify(previous[key]) === JSON.stringify(plan[key]) ? [] : [[key, { before: previous[key], after: plan[key] }]]));
}

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
  const explorations = new Map();
  const prepared = new Map();
  const proposals = new Map();
  const panels = new Set();
  let generation = 0, busy = false, disposed = false, active;

  function forget(session) {
    clearTimeout(session.timer);
    session.controller?.abort();
    prepared.delete(session.pending);
    proposals.delete(session.pending);
    for (const id of session.turns) proposals.delete(id);
    explorations.delete(session.id);
  }

  function invalidate() {
    generation++;
    active?.abort();
    for (const session of explorations.values()) forget(session);
  }

  function capture() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before sending schema context to a local model.');
    const identity = database.liveCatalogIdentity();
    if (!identity) throw Error('Connect to the MySQL or MariaDB schema to review a grounded query.');
    const settings = vscode.workspace.getConfiguration(section);
    return { ...normalizeLocalChatTarget(settings.get('endpoint'), settings.get('model')), connection: JSON.stringify(identity), generation };
  }

  function current(started) {
    const settings = vscode.workspace.getConfiguration(section);
    if (disposed || !vscode.workspace.isTrusted || started.generation !== generation ||
        started.endpoint !== settings.get('endpoint') || started.model !== settings.get('model') ||
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

  function retain(started, choices, fingerprint) {
    while (explorations.size >= maxExplorations) {
      const oldest = [...explorations.values()].find(session => !session.pending);
      if (!oldest) throw Error('Finish a pending grounded request before starting another exploration.');
      forget(oldest);
    }
    const session = { id: randomUUID(), started, choices, fingerprint, turns: [], requests: 0, expiresAt: Date.now() + lifetime };
    session.timer = setTimeout(() => forget(session), lifetime);
    session.timer.unref();
    explorations.set(session.id, session);
    return session;
  }

  function available(session) {
    if (!session || !explorations.has(session.id) || session.expiresAt <= Date.now()) {
      if (session) forget(session);
      throw Error('This grounded request or review expired. Start a new schema exploration.');
    }
    current(session.started);
    return session;
  }

  function find(store, id) {
    const value = store.get(id);
    available(value?.session);
    return value;
  }

  function source(record, { allowClosed = false } = {}) {
    const binding = record?.source;
    if (!binding || (binding.document.isClosed && allowClosed)) return;
    if (binding.document.isClosed || binding.uri !== binding.document.uri.toString() ||
        binding.version !== binding.document.version || binding.document.getText() !== record.result.sql + '\n') {
      throw Error('The reviewed SQL editor changed or closed. Close a changed draft and use Continue Grounded SQL Exploration to reopen the exact reviewed SQL.');
    }
  }

  function refinable(session, previousId) {
    available(session);
    if (session.turns.at(-1) !== previousId) throw Error('Continue from the latest reviewed turn to keep one exploration history.');
    if (session.pending) throw Error('Review or discard the pending request before continuing this exploration.');
    if (session.turns.length >= maxTurns || session.requests >= maxRequests) throw Error('This exploration reached its reviewed turn or model request limit.');
    source(proposals.get(previousId));
  }

  async function stage({ choices, previousId, input } = {}) {
    const previous = previousId === undefined ? undefined : find(proposals, previousId);
    if (previous && (!previous.reviewed || choices !== undefined)) throw Error('Review the current proposal before refining the exact same schema route.');
    let session = previous?.session;
    const started = session?.started ?? capture();
    if (session) refinable(session, previousId);
    const selected = session?.choices ?? structuredClone(choices);
    const scope = await liveContext(started, selected);
    if (session) {
      refinable(session, previousId);
      if (scope.fingerprint !== session.fingerprint) throw Error('The approved schema metadata changed. Choose the joins and columns again.');
    }
    const request = prepareGroundedRequest({ ...started, context: scope, input, previous: previous?.result });
    session ??= retain(started, selected, scope.fingerprint);
    const id = randomUUID();
    session.pending = id;
    prepared.set(id, { session, request, previous });
    return { id, explorationId: session.id, model: started.model, endpoint: started.endpoint, input: structuredClone(request.preview) };
  }

  function discard(id) {
    const record = prepared.get(id) ?? proposals.get(id);
    if (!record || record.reviewed || record.session.pending !== id || record.session.controller) return;
    prepared.delete(id);
    proposals.delete(id);
    record.session.pending = undefined;
    if (!record.session.turns.length) forget(record.session);
  }

  async function draft(id, { confirmed, signal } = {}) {
    if (confirmed !== true) throw Error('Review the exact schema context and request before sending it to the local model.');
    const { session, request, previous } = find(prepared, id);
    const { started, choices, fingerprint } = session;
    prepared.delete(id);
    const controller = new AbortController();
    session.controller = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      source(previous);
      const scope = await liveContext(started, choices);
      available(session);
      if (scope.fingerprint !== fingerprint) throw Error('The approved schema metadata changed before the model request.');
      source(previous);
      session.requests++;
      const result = await executeGroundedRequest(request, { signal: combined });
      const after = await liveContext(started, choices);
      available(session);
      if (after.fingerprint !== fingerprint) throw Error('The approved schema metadata changed during model inference.');
      if (combined.aborted) throw Error('The grounded model request was cancelled.');
      source(previous);
      const digest = createHash('sha256').update(result.sql).digest('hex');
      const proposalId = randomUUID();
      proposals.set(proposalId, { session, result, digest });
      session.pending = proposalId;
      return structuredClone({ id: proposalId, explorationId: session.id, digest, ...result });
    } finally {
      session.controller = undefined;
      if (session.pending === id) {
        session.pending = undefined;
        if (!session.turns.length) forget(session);
      }
    }
  }

  function review(id, { confirmed, digest } = {}) {
    const proposal = find(proposals, id);
    if (confirmed !== true || digest !== proposal.digest) throw Error('Review the exact generated SQL to continue this exploration.');
    if (proposal.reviewed) return;
    const { session } = proposal;
    source(proposals.get(session.turns.at(-1)));
    proposal.reviewed = true;
    session.turns.push(id);
    session.pending = undefined;
  }

  async function inspect(id, { confirmed, digest, signal } = {}) {
    const proposal = find(proposals, id);
    if (confirmed !== true || !proposal.reviewed || digest !== proposal.digest) throw Error('Approve one estimated EXPLAIN for the exact reviewed proposal.');
    const { result, session } = proposal;
    const { choices, fingerprint } = session;
    const valid = () => { available(session); source(proposal); return true; };
    valid();
    const report = await database.explainGroundedQuery(choices, result.plan, fingerprint, { signal,
      current: valid });
    valid();
    return report;
  }

  async function openDraft(id, digest, { reopen = false } = {}) {
    const record = find(proposals, id);
    if (!record.reviewed || record.digest !== digest) throw Error('Review the current SQL before opening it in the editor.');
    source(record, { allowClosed: reopen });
    const binding = record.source;
    const document = binding && !binding.document.isClosed ? binding.document
      : await vscode.workspace.openTextDocument({ language: 'sql', content: record.result.sql + '\n' });
    available(record.session);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    available(record.session);
    if (!binding || (binding.document.isClosed && reopen)) record.source = { document, uri: document.uri.toString(), version: document.version };
    source(record);
    return editor;
  }

  function sessions() {
    capture();
    return [...explorations.values()].reverse().filter(session => session.turns.length)
      .map(session => ({ id: session.id, root: session.choices.root, turns: session.turns.length, expiresAt: session.expiresAt }));
  }

  async function resume(id) {
    const session = available(explorations.get(id));
    const latest = session.turns.at(-1);
    const record = find(proposals, latest);
    if (session.pending) throw Error('Review or discard the pending request before continuing this exploration.');
    source(record, { allowClosed: true });
    const scope = await liveContext(session.started, session.choices);
    available(session);
    if (session.pending || session.turns.at(-1) !== latest) throw Error('The exploration advanced. Select its latest reviewed draft.');
    if (scope.fingerprint !== session.fingerprint) throw Error('The approved schema metadata changed. Choose the joins and columns again.');
    await openDraft(latest, record.digest, { reopen: true });
    return latest;
  }

  function transcript(id, through) {
    const session = available(explorations.get(id));
    const turns = session.turns.slice(0, through).map((turn, index) => {
      const { result, digest } = find(proposals, turn);
      const previous = proposals.get(session.turns[index - 1])?.result.plan;
      return { number: index + 1, id: turn, sql: result.sql, digest,
        changes: previous ? planChanges(previous, result.plan) : undefined };
    });
    return structuredClone({ id, model: session.started.model, endpoint: session.started.endpoint,
      scope: session.choices, fingerprint: session.fingerprint, expiresAt: session.expiresAt, turns });
  }

  function transcriptText(uri) {
    try {
      const [id, through] = uri.query.split('/');
      const report = transcript(id, Number(through));
      return ['Grounded SQL Exploration', 'Model ' + report.model, 'Endpoint ' + report.endpoint,
        'Metadata fingerprint ' + report.fingerprint, 'Available until ' + new Date(report.expiresAt).toISOString(),
        'Approved scope', JSON.stringify(report.scope, null, 2), ...report.turns.flatMap(turn => [
          '', 'Reviewed turn ' + turn.number, 'SQL SHA-256 ' + turn.digest, turn.sql,
          ...(turn.changes ? ['Plan changes', JSON.stringify(turn.changes, null, 2)] : [])
        ])].join('\n');
    } catch { return 'This grounded SQL exploration is no longer available.'; }
  }

  async function openTranscript(id) {
    const { turns } = transcript(id);
    const uri = vscode.Uri.parse(transcriptScheme + ':/Reviewed%20SQL%20Exploration.txt?' + id + '/' + turns.length);
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  async function chooseExploration() {
    const options = sessions().map(session => ({
      id: session.id, label: session.root, description: String(session.turns) + ' reviewed turns',
      detail: 'Expires at ' + new Date(session.expiresAt).toLocaleTimeString()
    }));
    if (!options.length) throw Error('Start and review a grounded SQL draft before continuing an exploration.');
    return (await vscode.window.showQuickPick(options, { title: 'Choose a Reviewed Grounded SQL Exploration' }))?.id;
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

  async function interactive(continueExisting = false) {
    if (busy) throw Error('Finish or cancel the current grounded query exploration.');
    busy = true;
    let pending;
    try {
      const started = capture();
      let choices;
      let previousId;
      if (continueExisting) {
        const selected = await chooseExploration();
        if (!selected) return;
        previousId = await resume(selected);
      } else {
        choices = await pickGroundedSqlRoute(vscode, database.liveCatalogSnapshot());
        if (!choices) return;
      }
      for (;;) {
        current(started);
        const input = await vscode.window.showInputBox({ title: previousId ? 'Refine the Reviewed SQL Plan' : 'Draft a Grounded SQL Query',
          prompt: 'Select columns, aggregate, group, or sort across the chosen joins', ignoreFocusOut: true,
          validateInput: value => Buffer.byteLength(value) > 1024 ? 'Keep this request within 1 KiB.' : undefined });
        if (!input?.trim()) return;
        const request = await stage({ ...(previousId ? { previousId } : { choices }), input });
        pending = request.id;
        const answer = await vscode.window.showInformationMessage('Send this exact schema context to the configured local model?',
          { modal: true, detail: `${request.model}\n${request.endpoint}\n\n${JSON.stringify(request.input, null, 2)}` }, 'Send to Local Model');
        if (answer !== 'Send to Local Model') return;
        const result = await progress('Drafting a Grounded SQL Query', signal => draft(request.id, { confirmed: true, signal }));
        pending = result.id;
        const approved = await vscode.window.showInformationMessage('Review this SQL draft before inspecting its plan or refining it.',
          { modal: true, detail: `${result.sql}\n\nModel explanation\n${result.plan.explanation}` }, 'Review Draft');
        if (approved !== 'Review Draft') return;
        review(result.id, { confirmed: true, digest: result.digest });
        pending = undefined;
        await openDraft(result.id, result.digest);
        let next = await vscode.window.showQuickPick(['Inspect Estimated Plan', 'Refine with Same Schema', 'Show Exploration Transcript'], { title: 'Review Grounded SQL' });
        if (next === 'Inspect Estimated Plan') {
          const confirmed = await vscode.window.showInformationMessage('Ask the database for an estimated plan for this exact SQL?',
            { modal: true, detail: result.sql }, 'Run Estimated EXPLAIN');
          if (confirmed !== 'Run Estimated EXPLAIN') return;
          await progress('Obtaining Estimated SQL Plan', signal => openPlan(result.id, { confirmed: true, digest: result.digest, signal }));
          next = await vscode.window.showQuickPick(['Refine with Same Schema', 'Show Exploration Transcript'], { title: 'Continue Grounded SQL Exploration' });
        }
        if (next === 'Show Exploration Transcript') return openTranscript(result.explorationId);
        if (next !== 'Refine with Same Schema') return;
        previousId = result.id;
      }
    } finally { discard(pending); busy = false; }
  }

  function register(id, run) {
    return vscode.commands.registerCommand(id, async () => {
      try { return await run(); }
      catch (error) { if (error.code !== cancelled && !/cancelled/i.test(error.message)) void vscode.window.showErrorMessage(error.message); }
    });
  }

  context.subscriptions.push(database.onDidChangeDatabase(invalidate),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(section)) invalidate(); }),
    vscode.workspace.registerTextDocumentContentProvider(transcriptScheme, { provideTextDocumentContent: transcriptText }),
    register(commandId, interactive), register(continueId, () => interactive(true)),
    register(transcriptId, async () => {
      const selected = await chooseExploration();
      if (selected) return openTranscript(selected);
    }), { dispose() { disposed = true; invalidate(); for (const panel of panels) panel.dispose(); } });
  return { stage, draft, review, inspect, openDraft, openPlan, discard, sessions, resume, transcript };
}

module.exports = { registerGroundedSqlAssistant, pickGroundedSqlRoute };
