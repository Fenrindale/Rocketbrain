'use strict';

const { randomBytes } = require('node:crypto');
const { DEBUG_BUILD, COROUTINE_BUILD, WATCH_BUILD } = require('./debug-runtime');

const command = 'rocketbrain/readJavaValues';
const pageSize = 100;
const maxString = 256 * 1024;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const validLength = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;

function createLocalValueInspection(vscode, { getState, ensureTrusted }) {
  const reviews = new WeakMap();
  let panel;

  function paused(session) {
    ensureTrusted();
    if (!session || session.type !== 'rocketbrain-java' || session.id !== vscode.debug.activeDebugSession?.id) {
      throw Error('Focus a paused Rocketbrain Java session to inspect its local values.');
    }
    const state = getState(session.id);
    if (state?.state !== 'stopped' || state.resuming !== undefined || !positiveId(state.threadId)) {
      throw Error('Pause the Java session before reading local values.');
    }
    if (![DEBUG_BUILD, COROUTINE_BUILD, WATCH_BUILD].includes(state.debugBuild)) throw Error('Update the Rocketbrain Java engine to read local values without expression evaluation.');
    const focused = vscode.debug.activeStackItem;
    if (focused?.session?.id === session.id && focused.threadId !== state.threadId) {
      throw Error('Select a frame on the Java thread that reported the current stop.');
    }
    return { generation: state.stopVersion, threadId: state.threadId,
      focusedFrame: focused?.session?.id === session.id && positiveId(focused?.frameId) ? focused.frameId : undefined };
  }

  function verify(session, previous) {
    const current = paused(session);
    if (current.generation !== previous.generation || current.threadId !== previous.threadId) {
      throw Error('The Java debugger stopped at a different position. Inspect local values again.');
    }
  }

  async function inspect(session = vscode.debug.activeDebugSession) {
    const stop = paused(session);
    const result = await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: stop.focusedFrame ? 32 : 1 });
    verify(session, stop);
    const stack = result?.stackFrames;
    if (!Array.isArray(stack) || stack.length > 32) throw Error('The Java adapter returned an invalid call stack.');
    const frame = stop.focusedFrame ? stack.find(item => item.id === stop.focusedFrame) : stack[0];
    if (!positiveId(frame?.id)) throw Error('Select a readable Java frame within the top 32 calls.');
    const data = await session.customRequest(command, { action: 'list', frameId: frame.id });
    verify(session, stop);
    if (!Array.isArray(data?.values) || data.values.length > 128) throw Error('The Java adapter returned an invalid local-values list.');
    const values = data.values.filter(entry => entry && typeof entry.name === 'string' && entry.name.length > 0 &&
      entry.name.length <= 256 && ['array', 'arrayList', 'string'].includes(entry.kind) && validLength(entry.length))
      .map(({ name, kind, length, complete }) => Object.freeze({ name, kind, length,
        complete: kind !== 'string' || complete === true && length <= maxString }));
    const report = Object.freeze({ frame: String(frame.name || '').slice(0, 512), values: Object.freeze(values), limited: data.limited === true });
    reviews.set(report, { session, stop, frameId: frame.id });
    return report;
  }

  async function read(report, name, { start = 0, count = pageSize } = {}) {
    const review = reviews.get(report);
    const entry = review && report.values.find(value => value.name === name);
    if (!entry) throw Error('Choose a local value from the current Java inspection.');
    const { session, stop, frameId } = review;
    verify(session, stop);
    if (!entry.complete) throw Error('The full Java string is unavailable within the 256 Ki UTF-16 unit limit.');
    const args = { frameId, name };
    if (entry.kind === 'string') args.action = 'string';
    else {
      if (!validLength(start) || start > entry.length || !positiveId(count) || count > pageSize) {
        throw Error('Choose an in-range Java collection page of up to 100 elements.');
      }
      Object.assign(args, { action: 'page', start, count });
    }
    const value = await session.customRequest(command, args);
    verify(session, stop);
    if (value?.kind !== entry.kind || value.length !== entry.length) throw Error('The Java local value changed. Inspect it again.');
    if (entry.kind === 'string') {
      if (typeof value.text !== 'string' || value.text.length !== value.length) throw Error('The Java adapter returned an incomplete string.');
      return { kind: value.kind, length: value.length, text: value.text };
    }
    if (value.start !== start || !Array.isArray(value.rows) || value.rows.length !== Math.min(count, entry.length - start) ||
      value.rows.some((row, index) => row?.index !== start + index || typeof row.type !== 'string' || row.type.length > 512 ||
        row.display !== undefined && (typeof row.display !== 'string' || row.display.length > 256))) {
      throw Error('The Java adapter returned an invalid collection page.');
    }
    return { kind: value.kind, length: value.length, start, rows: value.rows.map(({ index, type, display }) => ({ index, type, display })) };
  }

  async function show(report, name) {
    let result = await read(report, name);
    panel?.dispose();
    const opened = vscode.window.createWebviewPanel('rocketbrain.java.localValues', 'Java Value · ' + name,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
    panel = opened;
    let busy = false;
    const messages = opened.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready') {
        await opened.webview.postMessage({ type: 'value', result });
      } else if (message?.type === 'page' && result.kind !== 'string' && validLength(message.start) && !busy) {
        busy = true;
        try {
          result = await read(report, name, { start: message.start });
          await opened.webview.postMessage({ type: 'value', result });
        } catch (error) {
          await opened.webview.postMessage({ type: 'error', message: String(error.message || error).slice(0, 400) });
        } finally { busy = false; }
      }
    });
    opened.onDidDispose(() => { messages.dispose(); if (panel === opened) panel = undefined; });
    opened.webview.html = localValuePage(randomBytes(20).toString('base64'));
    return opened;
  }

  async function choose() {
    const report = await inspect();
    if (!report.values.length) throw Error('The paused Java frame has no supported local arrays, ArrayList values or strings.');
    const picked = await vscode.window.showQuickPick(report.values.map(entry => ({ label: entry.name,
      description: entry.complete ? entry.kind + ' · ' + entry.length : 'String beyond viewer limit' })),
    { title: 'Inspect Java Local Value', placeHolder: report.frame + (report.limited ? ' · First 128 locals' : '') });
    if (picked) return show(report, picked.label);
  }

  return { inspect, read, show, choose, dispose() { panel?.dispose(); } };
}

function localValuePage(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Java local value</title><style nonce="${nonce}">
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 1rem; }
form { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin: .8rem 0; }
button, input { border: 1px solid var(--vscode-input-border, transparent); padding: .3rem .7rem; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
button:not(:disabled) { color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
table { width: 100%; text-align: left; border-collapse: collapse; }
th, td { padding: .35rem .5rem; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
pre, td:last-child { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
#error { color: var(--vscode-errorForeground); }
[hidden] { display: none !important; }
</style></head><body>
<p id="summary" role="status"></p><p id="error" role="alert"></p>
<form id="paging" hidden><button id="previous" type="button">Previous</button><button id="next" type="button">Next</button>
<label for="index">Start index</label><input id="index" type="number" required min="0" step="1"><button type="submit">Go</button></form>
<table id="collection" hidden><thead><tr><th scope="col">Index</th><th scope="col">Type</th><th scope="col">Value</th></tr></thead><tbody></tbody></table>
<pre id="string" hidden></pre>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const find = id => document.getElementById(id);
const paging = find('paging'), table = find('collection'), input = find('index'), previous = find('previous'), next = find('next');
const pageSize = 100;
let start = 0, nextIndex = 0;
const read = index => vscode.postMessage({ type: 'page', start: index });
previous.addEventListener('click', () => read(Math.max(0, start - pageSize)));
next.addEventListener('click', () => read(nextIndex));
paging.addEventListener('submit', event => { event.preventDefault(); read(input.valueAsNumber); });
window.addEventListener('message', event => {
  if (event.data?.type === 'error') { find('error').textContent = event.data.message; return; }
  if (event.data?.type !== 'value') return;
  find('error').textContent = '';
  const result = event.data.result;
  const isString = result.kind === 'string';
  find('string').hidden = !isString;
  table.hidden = isString;
  paging.hidden = isString || result.length === 0;
  if (isString) {
    find('summary').textContent = result.length + ' UTF-16 units';
    find('string').textContent = result.text;
    return;
  }
  start = result.start;
  nextIndex = start + result.rows.length;
  input.value = start;
  input.max = Math.max(0, result.length - 1);
  previous.disabled = start === 0;
  next.disabled = nextIndex >= result.length;
  find('summary').textContent = result.rows.length ? 'Indices ' + start + '–' + (nextIndex - 1) + ' of ' + result.length : '0 rows';
  const fragment = document.createDocumentFragment();
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (const value of [row.index, row.type, row.display ?? '—']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.appendChild(cell);
    }
    fragment.appendChild(tr);
  }
  table.tBodies[0].replaceChildren(fragment);
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

module.exports = { createLocalValueInspection };
