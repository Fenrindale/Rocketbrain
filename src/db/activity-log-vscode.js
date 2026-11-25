'use strict';

const { randomBytes } = require('node:crypto');
const { createActivityLog, categories, statuses } = require('./activity-log');

const OPEN_LOG = 'rocketbrain.sql.activityLog';
const PREFERENCE = 'rocketbrain.sql.activityLog.enabled.v1';
const HISTORY = 'rocketbrain.sql.activityLog.workspaceHistory.v1';

function logHtml(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>SQL Activity</title><style nonce="${nonce}">
*{box-sizing:border-box}[hidden]{display:none!important}body{padding:.95rem 1.15rem;margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:var(--vscode-font-size) var(--vscode-font-family,sans-serif)}
h1{font-size:1.2rem;margin:0}header{display:flex;align-items:center;justify-content:space-between;gap:.65rem;flex-wrap:wrap}.controls{display:flex;align-items:center;gap:.38rem;flex-wrap:wrap}
p{margin:.48rem 0;line-height:1.45;color:var(--vscode-descriptionForeground)}button,select{font:inherit;padding:.32rem .5rem;border:1px solid var(--vscode-widget-border,transparent);border-radius:3px}
button{cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{cursor:default;opacity:.6}#toggle.enable{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
select{color:var(--vscode-input-foreground);background:var(--vscode-input-background)}:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.filters{margin:.76rem 0 .38rem;display:flex;align-items:center;flex-wrap:wrap;gap:.6rem 1rem}.filters label{display:flex;align-items:center;gap:.3rem}.table{overflow:auto;border-top:1px solid var(--vscode-panel-border)}
table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:.4rem .55rem;border-bottom:1px solid var(--vscode-panel-border);white-space:nowrap}thead{background:var(--vscode-editorWidget-background)}tbody tr:hover{background:var(--vscode-list-hoverBackground)}code{font-family:var(--vscode-editor-font-family,monospace)}
[data-status="failed"],[data-status="timeout"]{color:var(--vscode-errorForeground)}[data-status="cancelled"],[data-status="limited"]{color:var(--vscode-editorWarning-foreground)}.duration{text-align:right;font-variant-numeric:tabular-nums}.message{color:var(--vscode-errorForeground)}
</style></head><body>
<header><h1>SQL Activity</h1><div class="controls"><label><input id="persist" type="checkbox" disabled> Keep history in this workspace</label><button id="toggle" type="button" disabled>Enable for workspace</button><button id="clear" type="button" disabled>Clear log</button></div></header>
<p>Records MySQL and MariaDB console, driver, metadata, session and administration requests. SQL text, values and server errors are omitted.</p>
<p id="state" role="status">Loading activity…</p><p id="message" class="message" role="alert" hidden></p>
<div id="filters" class="filters" hidden>
<label>Category <select id="category"><option value="">All categories</option></select></label>
<label>Status <select id="status"><option value="">All statuses</option></select></label>
<label>Connection <select id="connection"><option value="">All connections</option></select></label>
</div>
<div id="table" class="table" hidden><table><thead><tr><th scope="col">Started</th><th scope="col">Category</th><th scope="col">SQL verb</th><th scope="col">Status</th><th scope="col" class="duration">Duration</th><th scope="col">Connection</th><th scope="col">Session</th><th scope="col">Request ID</th></tr></thead><tbody></tbody></table></div>
<script nonce="${nonce}">
const host = acquireVsCodeApi();
const categoryNames = ${JSON.stringify(categories)}, statusNames = ${JSON.stringify(statuses)};
const state = document.getElementById('state'), message = document.getElementById('message');
const toggle = document.getElementById('toggle'), clear = document.getElementById('clear'), persist = document.getElementById('persist');
const category = document.getElementById('category'), status = document.getElementById('status'), connection = document.getElementById('connection');
const filters = document.getElementById('filters'), table = document.getElementById('table'), body = document.querySelector('tbody');
let snapshot;
const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });
const duration = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
function options(select, names) {
  const current = select.value;
  while (select.options.length > 1) select.remove(1);
  for (const [value, name] of Object.entries(names)) select.add(new Option(name, value));
  if (Object.hasOwn(names, current)) select.value = current;
}
options(category, categoryNames);
options(status, statusNames);
function shortId(id) { return id.slice(0, 8); }
function render() {
  if (!snapshot) return;
  const { enabled, available, entries, limit, dropped } = snapshot;
  toggle.textContent = enabled ? 'Disable and clear' : 'Enable for workspace';
  toggle.classList.toggle('enable', !enabled);
  toggle.disabled = !available;
  persist.checked = snapshot.retention === 'workspace';
  persist.disabled = !available || !enabled;
  clear.disabled = !entries.length;
  filters.hidden = table.hidden = !enabled;
  const names = Object.fromEntries(entries.map(row => [row.connection, shortId(row.connection)]));
  options(connection, names);
  const shown = entries.filter(row => (!category.value || row.category === category.value)
    && (!status.value || row.status === status.value) && (!connection.value || row.connection === connection.value));
  state.textContent = !available ? 'Open a trusted workspace to record SQL activity.' : !enabled ? 'Logging is off.' :
    shown.length + ' of ' + entries.length + ' requests shown · ' + limit + ' entries maximum ' +
    (snapshot.retention === 'workspace' ? 'in workspace history' : 'in memory') +
    (dropped ? ' · ' + dropped + ' older requests removed' : '') +
    (snapshot.persistenceFailure ? ' · Workspace history could not be saved' : '');
  const rows = document.createDocumentFragment();
  for (const row of shown) {
    const item = document.createElement('tr');
    const fields = [time.format(new Date(row.startedAt)), categoryNames[row.category], row.operation, statusNames[row.status],
      row.durationMs === null ? '—' : duration.format(row.durationMs) + ' ms', shortId(row.connection), shortId(row.session), row.id];
    for (const [index, text] of fields.entries()) {
      const cell = item.insertCell();
      if (index === 3) cell.dataset.status = row.status;
      if (index === 4) cell.className = 'duration';
      if (index === 5) cell.title = row.connection;
      if (index === 6) cell.title = row.session;
      if (index > 4) { const code = document.createElement('code'); code.textContent = text; cell.append(code); }
      else cell.textContent = text;
    }
    rows.append(item);
  }
  body.replaceChildren(rows);
}
for (const control of [category, status, connection]) control.addEventListener('change', render);
toggle.addEventListener('click', () => { toggle.disabled = true; host.postMessage({ type: snapshot.enabled ? 'disable' : 'enable' }); });
clear.addEventListener('click', () => host.postMessage({ type: 'clear' }));
persist.addEventListener('change', () => { persist.disabled = true; host.postMessage({ type: 'retention', value: persist.checked ? 'workspace' : 'temporary' }); });
window.addEventListener('message', event => {
  if (event.data?.type === 'snapshot') { snapshot = event.data.value; message.hidden = true; render(); }
  if (event.data?.type === 'error') { message.textContent = event.data.value; message.hidden = false; render(); }
});
host.postMessage({ type: 'ready' });
</script></body></html>`;
}

function registerSqlActivity(context, vscode) {
  const stored = context.workspaceState.get(HISTORY);
  let keepHistory = stored?.version === 1;
  let panel, timer, saveTimer, disposePromise, changing = false, disposed = false, persistenceFailure = false;
  let writes = Promise.resolve();
  const allowed = () => vscode.workspace.isTrusted && Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  const snapshot = () => ({ ...log.snapshot(), retention: keepHistory ? 'workspace' : 'temporary', persistenceFailure });
  const publish = () => panel?.webview.postMessage({ type: 'snapshot', value: snapshot() });
  const log = createActivityLog({ enabled: context.workspaceState.get(PREFERENCE) === true, canRecord: allowed, history: stored,
    onChange() {
      if (panel && !timer) timer = setTimeout(() => { timer = undefined; void publish(); }, 80);
      if (keepHistory && allowed() && !saveTimer) {
        saveTimer = setTimeout(() => { void flush().catch(() => {}); }, 150);
        saveTimer.unref?.();
      }
    } });

  function flush(remove = false) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!allowed() || (!keepHistory && !remove)) return writes;
    const { entries, dropped } = log.snapshot();
    const value = remove ? undefined : { version: 1, entries, dropped };
    const saving = writes.then(() => context.workspaceState.update(HISTORY, value));
    writes = saving.then(() => { persistenceFailure = false; }, () => { persistenceFailure = true; });
    void writes.then(() => publish()).catch(() => {});
    return saving;
  }

  async function setEnabled(value) {
    if (disposed || !allowed()) throw Error('Open a trusted workspace to manage SQL activity.');
    if (typeof value !== 'boolean' || changing) throw Error('Finish updating the workspace SQL activity preference.');
    changing = true;
    try {
      if (!value) log.setEnabled(false);
      await context.workspaceState.update(PREFERENCE, value);
      if (!disposed && allowed()) log.setEnabled(value);
      await flush();
      return snapshot();
    } finally { changing = false; }
  }

  async function setRetention(value) {
    if (disposed || !allowed() || !log.snapshot().enabled || changing || !['temporary', 'workspace'].includes(value)) {
      throw Error('Enable SQL Activity in a trusted workspace before changing its retention.');
    }
    const before = keepHistory;
    keepHistory = value === 'workspace';
    changing = true;
    try { await flush(!keepHistory); return snapshot(); }
    catch (error) { keepHistory = before; throw error; }
    finally { changing = false; }
  }

  async function clear() {
    if (disposed || !allowed()) throw Error('Open a trusted workspace to clear SQL activity.');
    log.clear();
    await flush();
    return snapshot();
  }

  function open() {
    if (disposed) throw Error('The SQL Activity view has closed.');
    if (panel) { panel.reveal(); return snapshot(); }
    const next = vscode.window.createWebviewPanel('rocketbrain.sqlActivity', 'SQL Activity', vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] });
    panel = next;
    next.onDidDispose(() => { panel = undefined; });
    next.webview.onDidReceiveMessage(async message => {
      try {
        if (message?.type === 'enable') await setEnabled(true);
        else if (message?.type === 'disable') await setEnabled(false);
        else if (message?.type === 'clear') await clear();
        else if (message?.type === 'retention') await setRetention(message.value);
        else if (message?.type !== 'ready') return;
        await publish();
      } catch { await next.webview.postMessage({ type: 'error', value: 'Could not update the workspace activity preference.' }); }
    });
    next.webview.html = logHtml(randomBytes(24).toString('base64'));
    return snapshot();
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    clearTimeout(timer);
    panel?.dispose();
    disposePromise = flush().catch(() => {});
    log.dispose();
    return disposePromise;
  }
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_LOG, open), { dispose });
  return { setEnabled, setRetention, snapshot, clear, flush: () => flush(), createReporter: log.createReporter,
    close() { panel?.dispose(); }, dispose };
}

module.exports = { registerSqlActivity, logHtml, OPEN_LOG, HISTORY };
