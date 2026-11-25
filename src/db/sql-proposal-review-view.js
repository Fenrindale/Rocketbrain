'use strict';

function renderClient() {
  const host = acquireVsCodeApi();
  const start = document.getElementById('start');
  const status = document.getElementById('status');
  const cards = document.getElementById('cards');
  const comparison = document.getElementById('comparison');
  const labels = { pending: 'Waiting', running: 'Working', ready: 'Ready to review', reviewed: 'Reviewed',
    cancelled: 'Cancelled', rejected: 'Rejected', failed: 'Review unavailable', stale: 'Scope expired' };

  function add(parent, tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  function button(parent, text, action, state, job) {
    const node = add(parent, 'button', text);
    node.type = 'button';
    node.id = job.id + '-' + action;
    node.addEventListener('click', () => {
      node.disabled = true;
      host.postMessage({ type: action, reviewId: state.id, jobId: job.id, fingerprint: job.result?.fingerprint });
    });
  }

  function show(state, preparing) {
    start.disabled = preparing || Boolean(state?.jobs.some(job => ['pending', 'running'].includes(job.status)));
    const previous = document.activeElement?.id;
    cards.replaceChildren();
    comparison.textContent = '';
    if (!state) {
      status.textContent = preparing ? 'Choosing requests and schema…' : 'Choose two or three requests to compare.';
      return;
    }
    status.textContent = state.invalidated ? 'Connection, catalog, or model settings changed. Start a review with the current scope.' :
      [state.dialect + ' · ' + state.schema, state.tables.join(', '), state.model + ' at ' + state.endpoint].join(' · ');
    const available = state.jobs.filter(job => job.result);
    if (available.length > 1) {
      comparison.textContent = new Set(available.map(job => job.result.fingerprint)).size === 1 ?
        'The ready proposals contain identical SQL.' : 'The ready proposals differ. Compare the statements below.';
    }
    for (const job of state.jobs) {
      const card = add(cards, 'article', '');
      add(card, 'h2', 'Proposal ' + job.slot);
      add(card, 'p', labels[job.status], 'job-status').role = 'status';
      if (job.request) add(card, 'p', job.request, 'request');
      if (job.result) {
        add(card, 'pre', job.result.sql);
        add(card, 'p', 'Tables · ' + job.result.tables.join(', '), 'detail');
        add(card, 'p', job.result.explanation, 'detail');
      }
      if (job.failure) add(card, 'p', job.failure, 'detail');
      const buttons = add(card, 'div', '', 'actions');
      if (job.status === 'running') button(buttons, 'Cancel', 'cancel', state, job);
      if (job.status === 'ready') button(buttons, 'Review SQL', 'accept', state, job);
      if (job.result) button(buttons, 'Reject', 'reject', state, job);
      if (job.status === 'reviewed') button(buttons, 'Open in SQL Editor', 'open', state, job);
    }
    if (previous && previous !== 'start') document.getElementById(previous)?.focus();
  }

  start.addEventListener('click', () => { start.disabled = true; host.postMessage({ type: 'start' }); });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') show(data.state, data.preparing);
  });
  host.postMessage({ type: 'ready' });
}

function proposalReviewHtml(nonce) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SQL Proposal Review</title>
<style nonce="${nonce}">
body { color:var(--vscode-foreground); background:var(--vscode-editor-background); padding:24px; }
header { display:flex; align-items:center; flex-wrap:wrap; gap:13px; }
h1 { font-size:1.35rem; margin:0; }
h2 { font-size:1rem; margin:0; }
#cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr)); gap:14px; }
article { padding:14px; min-width:0; border:1px solid var(--vscode-panel-border); border-radius:4px; }
.job-status,.detail,#status { color:var(--vscode-descriptionForeground); overflow-wrap:anywhere; }
.request { white-space:pre-wrap; overflow-wrap:anywhere; }
pre { font:var(--vscode-editor-font-size) var(--vscode-editor-font-family); overflow:auto; max-height:260px;
 background:var(--vscode-textCodeBlock-background); padding:10px; }
.actions { display:flex; flex-wrap:wrap; gap:9px; }
button { border:1px solid transparent; border-radius:2px; padding:6px 10px; color:var(--vscode-button-foreground);
 background:var(--vscode-button-background); font:inherit; cursor:pointer; }
button:not(:disabled):hover { background:var(--vscode-button-hoverBackground); }
button:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:2px; }
button:disabled { opacity:.55; cursor:default; }
</style></head><body>
<header><h1>SQL Proposal Review</h1><button id="start" type="button" disabled>New Review</button></header>
<p id="status" role="status">Loading review…</p><p id="comparison" aria-live="polite"></p><main id="cards"></main>
<script nonce="${nonce}">(${renderClient.toString()})();</script>
</body></html>`;
}

module.exports = { proposalReviewHtml };
