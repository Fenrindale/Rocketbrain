'use strict';

const escape = input => String(input ?? '').replace(/[&<>"']/g, item => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[item]);

const moveLabels = { 'candidate-move':'Candidate move', moved:'Moved', reviewed:'Reviewed pair' };
const reviewStyles = `
  .candidate-review{margin:1rem 0;padding:.65rem;background:var(--vscode-editorWidget-background)}
  .candidate-review summary{cursor:pointer;font-weight:600}
  .candidate-review td div{margin:.2rem 0}
  .candidate-review button{margin:.25rem .35rem .25rem 0;padding:.25rem .55rem;cursor:pointer;border:1px solid transparent;
    color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);font:inherit}
  .candidate-review button:not(:disabled):hover{background:var(--vscode-button-secondaryHoverBackground)}
  .candidate-review button:focus-visible{outline:2px solid var(--vscode-focusBorder)}
  .candidate-review button:disabled{cursor:default;opacity:.65}
`;

function candidateReviewHtml(result, nonce) {
  const review = result.candidateReview;
  if (!review?.pairs.length) return '';
  const states = { pending:'Pending', accepted:'Paired', ignored:'Ignored', unavailable:'An operator is paired elsewhere' };
  const editable = Boolean(result.reviewId);
  const cell = side => '<strong>' + escape(side.position) + ' · ' + escape(side.name) + '</strong>' +
    [['Access',side.method], ['Index',side.index], ['Predicate',side.predicate]].filter(([, value]) => value)
      .map(([label, value]) => '<div>' + label + ' <code>' + escape(value) + '</code></div>').join('');
  const button = (action, label, pair, disabled = false) => '<button type="button" data-review-action="' + action + '"' +
    (disabled ? ' disabled' : '') +
    (pair ? ' data-candidate-id="' + escape(pair.id) + '" aria-label="' + escape(label + ' ' +
      pair.baseline.position + ' with ' + pair.candidate.position) + '"' : '') + '>' + label + '</button>';
  const rows = review.pairs.map(pair => '<tr><td>' + cell(pair.baseline) + '</td><td>' + cell(pair.candidate) +
    '</td><td>' + (pair.matching === 'details' ? 'Same decoded operator details' : 'Same table or alias and access method') +
    '</td><td>' + states[pair.status] + (editable && pair.status === 'pending' ?
      '<div>' + button('accept', 'Pair', pair) + button('ignore', 'Ignore', pair) + '</div>' : '') + '</td></tr>').join('');
  const hasDecisions = review.pairs.some(pair => pair.status === 'accepted' || pair.status === 'ignored');
  const fileControls = editable ? '<div>' + button('load', 'Load review') + button('share-open', 'Review shared file') +
    (hasDecisions ? button('save', 'Save review') + button('reset', 'Reset review') : '') + '</div>' +
    '<p>Open the original baseline and candidate in order. Load a review from the same VS Code secret store, ' +
    'or review suggestions from another VS Code profile.</p>' : '';
  const draft = result.sharedReview;
  const reviewTable = '<p>Choose one pairing per operator. Decisions apply to this comparison.</p>' +
    (review.limited ? '<p>The display is limited to 60 pairs and eight alternatives per baseline operator.</p>' : '') +
    fileControls + '<table><thead><tr><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Evidence</th>' +
    '<th scope="col">Review</th></tr></thead><tbody>' + rows + '</tbody></table>';
  const sharedTable = draft ? '<section data-shared-review="' + escape(draft.id) + '"><h2>Review shared suggestions</h2>' +
    '<p>This VS Code profile could not verify the file’s signer. Check each suggestion against the original captures. ' +
    'Approve or skip every row, then apply the approved decisions together.</p>' +
    '<table><thead><tr><th scope="col">Baseline</th><th scope="col">Candidate</th>' +
    '<th scope="col">Suggestion</th><th scope="col">Your choice</th></tr></thead><tbody>' +
    draft.candidates.map(pair => '<tr><td>' + cell(pair.baseline) + '</td><td>' + cell(pair.candidate) + '</td><td>' +
      (pair.suggested === 'accepted' ? 'Pair these operators' : 'Ignore this alternative') +
      '<div>Current decision: ' + states[pair.status] + '</div></td><td>' +
      ({ approve:'Approved', skip:'Skipped', pending:'Pending' })[pair.choice] + '<div>' +
      button('share-approve', pair.suggested === 'accepted' ? 'Approve pairing' : 'Approve ignore', pair, pair.choice === 'approve') +
      button('share-skip', 'Skip', pair, pair.choice === 'skip') + '</div></td></tr>').join('') +
    '</tbody></table><div>' + button('share-apply', 'Apply approved decisions', undefined, !draft.ready) +
    button('share-cancel', 'Cancel shared review') + '</div></section>' : '';
  const script = editable ? `<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('candidate-review').addEventListener('click', event => {
    const button = event.target.closest('button[data-review-action]');
    if (!button) return;
    const message = {type:'review-plan-candidate', action:button.dataset.reviewAction, candidateId:button.dataset.candidateId};
    const shared = button.closest('[data-shared-review]');
    if (shared) message.draftId = shared.dataset.sharedReview;
    vscode.postMessage(message);
  });
  </script>` : '';
  return '<details id="candidate-review" class="candidate-review" open><summary>Review alternative operator pairs (' +
    review.pairs.length + ')</summary>' + (draft ? sharedTable : reviewTable) + '</details>' + script;
}

function fields(source, extra = '') {
  return source.map(item => '<span class="field' + extra + '">' + escape(item.label) + ' <strong>' + escape(item.value) + '</strong></span>').join('');
}

function costMeter(group, maxima) {
  const value = group.find(metric => ['prefix_cost', 'estimated_total_cost', 'cost'].includes(metric.key));
  if (!value) return '';
  const max = maxima.get(value.key);
  if (!max || !Number.isFinite(Number(value.value)) || Number(value.value) < 0) return '';
  return '<meter aria-label="' + escape(value.label + ' · relative to the maximum for this metric') + '" min="0" max="' + max +
    '" value="' + Number(value.value) + '"></meter>';
}

function explanationHtml(plan, { nonce, source = false, allowTreeCapture = true }) {
  const rawLabel = plan.format === 'tree' ? 'TREE text' : 'JSON';
  const captureTreeSeparately = allowTreeCapture && plan.engine === 'mysql' && !plan.measured;
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const children = new Map(), maxima = new Map();
  for (const node of plan.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
    for (const { key, value } of node.costs) {
      const numeric = Number(value);
      if (numeric > (maxima.get(key) ?? 0) && Number.isFinite(numeric)) maxima.set(key, numeric);
    }
  }
  function branch(id) {
    const node = byId.get(id), nested = children.get(id) ?? [];
    const content = '<span class="node-name">' + escape(node.name) + '</span><span class="metrics">' +
      fields(node.costs, ' cost') + fields(node.rows, ' rows') + fields(node.actual || [], ' actual') +
      '</span>' + costMeter(node.costs, maxima);
    const detail = '<div class="node-detail">' + fields(node.tags) + node.expressions.map(item =>
      '<p><span>' + escape(item.label) + '</span> <code>' + escape(item.value) + '</code></p>').join('') + '</div>';
    const element = nested.length ? '<details' + (node.depth < 2 ? ' open' : '') + '><summary>' + content +
      '</summary>' + detail + '<ul>' + nested.map(branch).join('') + '</ul></details>' :
      '<div class="leaf"><div class="leaf-summary">' + content + '</div>' + detail + '</div>';
    const terms = [node.name, ...node.costs.concat(node.rows, node.actual || [], node.tags, node.expressions)
      .map(item => item.label + ' ' + item.value)].join(' ');
    return '<li class="branch" data-id="' + id + '" data-terms="' + escape(terms) + '">' + element + '</li>';
  }
  const title = plan.engine === 'mariadb' ? 'MariaDB' : 'MySQL';
  const tableRows = plan.nodes.map(node => '<tr data-id="' + node.id + '"><th scope="row">' + escape(node.name) + '</th><td>' +
    escape(byId.get(node.parentId)?.name ?? 'Root') + '</td><td>' + fields(node.tags) + '</td><td>' + fields(node.rows, ' rows') +
    '</td><td>' + fields(node.costs, ' cost') + '</td>' + (plan.measured ? '<td>' + fields(node.actual || [], ' actual') + '</td>' : '') +
    '<td>' + node.expressions.map(item => '<p>' + escape(item.label) + ' <code>' +
      escape(item.value) + '</code></p>').join('') + '</td></tr>').join('');
  const warnings = plan.warnings.map(value => '<p class="notice">' + escape(value) + '</p>').join('');
  const empty = plan.nodes.length ? '' : '<p class="notice">Inspect the original server ' + rawLabel + ' output.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Visual EXPLAIN</title>
<style nonce="${nonce}">
  *{box-sizing:border-box} body{margin:0;padding:.9rem 1.1rem;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family,sans-serif)}
  [hidden]{display:none!important} header{display:flex;align-items:baseline;flex-wrap:wrap;gap:.35rem .9rem;margin-bottom:.75rem} h1{font-size:1.2rem;margin:0} header span,.hint,.notice{color:var(--vscode-descriptionForeground)}
  .bar{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:.55rem;margin-bottom:.55rem} .views{display:flex;gap:.22rem;margin-right:.55rem}
  button,input{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border,transparent);border-radius:3px;padding:.33rem .55rem}
  button{cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)} button:hover{background:var(--vscode-button-secondaryHoverBackground)} button[aria-pressed="true"]{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
  :focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px} .find{display:flex;align-items:center;gap:.35rem} input{width:min(15rem,40vw)} .tools{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}
  .notice,.hint{margin:.65rem 0;line-height:1.4}.notice{border-left:2px solid var(--vscode-editorInfo-foreground);padding-left:.65rem} .tree,.tree ul{list-style:none;margin:0;padding:0}
  .tree ul{margin-left:.82rem;border-left:1px solid var(--vscode-panel-border);padding-left:.85rem}.branch{position:relative;margin:.35rem 0;min-width:0}.tree ul>.branch:before{content:"";position:absolute;left:-.85rem;top:.95rem;width:.8rem;border-top:1px solid var(--vscode-panel-border)}
  summary,.leaf-summary{padding:.45rem .52rem;background:var(--vscode-editorWidget-background);border-radius:3px;overflow-wrap:anywhere} summary{cursor:pointer} .node-name{font-weight:600;margin-right:.5rem}.metrics{display:inline-flex;gap:.3rem;flex-wrap:wrap;vertical-align:middle}
  .field{display:inline-flex;gap:.28rem;align-items:baseline;font-size:.92em;padding:.08rem .25rem;border-radius:2px;margin:.09rem .15rem .09rem 0;color:var(--vscode-descriptionForeground)} .field strong{color:var(--vscode-editor-foreground);font-weight:500}.cost{color:var(--vscode-charts-orange);background:var(--vscode-textBlockQuote-background)} .rows{color:var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background)}
  .actual{color:var(--vscode-charts-green);background:var(--vscode-textBlockQuote-background)}
  .node-detail{padding:.24rem .55rem .24rem .85rem}.node-detail:empty{display:none}.node-detail p,td p{margin:.2rem 0;overflow-wrap:anywhere}.node-detail p>span{color:var(--vscode-descriptionForeground);margin-right:.35rem} code,pre{font-family:var(--vscode-editor-font-family,monospace)}
  meter{display:inline-block;width:min(7rem,22vw);height:.55rem;margin-left:.42rem;vertical-align:middle}.table-scroll{overflow:auto} table{border-collapse:collapse;width:100%;text-align:left} th,td{vertical-align:top;border-bottom:1px solid var(--vscode-panel-border);padding:.38rem .52rem;min-width:6.5rem} thead{background:var(--vscode-editorWidget-background)}
  pre{tab-size:2;white-space:pre-wrap;word-break:break-word;border:1px solid var(--vscode-panel-border);padding:.75rem}.action{margin-left:auto}
</style></head><body>
<header><h1>${plan.measured ? 'Measured SQL plan' : 'Visual EXPLAIN'}</h1><span>${escape(title)} ${escape(plan.version)} · ${escape(plan.database)}</span></header>
<div class="bar" aria-label="Plan controls">
  <div class="views" role="group" aria-label="Plan view"><button type="button" data-view="tree" aria-pressed="true">Tree</button><button type="button" data-view="table" aria-pressed="false">Table</button><button type="button" data-view="raw" aria-pressed="false">${rawLabel}</button>${captureTreeSeparately ? '<button type="button" data-view="raw-tree" aria-pressed="false">MySQL TREE text</button>' : ''}</div>
  <div class="tools"><label class="find">Filter <input type="search" id="filter" placeholder="Operator, index or condition"></label>
  <button type="button" id="expand">Expand all</button><button type="button" id="collapse">Collapse all</button></div>
  ${source ? '<button type="button" class="action" id="source">Open SQL</button>' : ''}
</div>
<p class="hint">${plan.nodes.length} plan node${plan.nodes.length === 1 ? '' : 's'} · ${plan.measured ? 'Server estimates and observed execution · Separate read-only session' : 'Optimizer estimates · Read-only metadata session'}</p>
${warnings}<p id="no-results" class="notice" role="status" hidden>No matching plan nodes.</p>
<section id="tree" aria-label="Plan tree">${empty}<ul class="tree">${plan.rootIds.map(branch).join('')}</ul></section>
<section id="table" aria-label="Plan table" hidden>${empty}<div class="table-scroll"><table><thead><tr><th scope="col">Operator</th><th scope="col">Parent</th><th scope="col">Details</th><th scope="col">Rows</th><th scope="col">Cost</th>${plan.measured ? '<th scope="col">Observed</th>' : ''}<th scope="col">Conditions</th></tr></thead><tbody>${tableRows}</tbody></table></div></section>
<section id="raw" aria-label="Original plan ${rawLabel}" hidden><button type="button" id="copy">Copy ${rawLabel}</button><pre id="original">${escape(plan.raw)}</pre></section>
${captureTreeSeparately ? `<section id="raw-tree" aria-label="Original MySQL TREE text" hidden>
  <p class="hint">MySQL TREE uses a separate optimizer request and may observe newer statistics.</p>
  <button type="button" id="capture-tree">Capture TREE text</button><button type="button" id="copy-tree" hidden>Copy TREE text</button>
  <p id="tree-status" class="notice" role="status" hidden></p><pre id="original-tree" hidden></pre>
</section>` : ''}
<script nonce="${nonce}">
const host = acquireVsCodeApi();
const branches = Array.from(document.querySelectorAll('li.branch'));
const details = Array.from(document.querySelectorAll('.tree details'));
const rows = document.querySelectorAll('tbody tr');
let active = 'tree';
function filter() {
  const value = document.getElementById('filter').value.trim().toLowerCase();
  const matches = new Set(branches.filter(branch => branch.dataset.terms.toLowerCase().includes(value)).map(branch => branch.dataset.id));
  const visible = new Set(matches);
  for (const branch of branches) {
    if (!matches.has(branch.dataset.id) || !value) continue;
    let parent = branch.parentElement.closest('li.branch');
    while (parent) {
      visible.add(parent.dataset.id);
      parent.querySelector(':scope > details').open = true;
      parent = parent.parentElement.closest('li.branch');
    }
  }
  for (const branch of branches) branch.hidden = !visible.has(branch.dataset.id);
  for (const row of rows) row.hidden = !matches.has(row.dataset.id);
  document.getElementById('no-results').hidden = !value || matches.size > 0 || active.startsWith('raw');
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  active = button.dataset.view;
  for (const other of document.querySelectorAll('[data-view]')) {
    other.setAttribute('aria-pressed', String(other === button));
    document.getElementById(other.dataset.view).hidden = other !== button;
  }
  document.querySelector('.find').hidden = active.startsWith('raw');
  document.getElementById('expand').hidden = active !== 'tree';
  document.getElementById('collapse').hidden = active !== 'tree';
  filter();
});
document.getElementById('filter').addEventListener('input', filter);
document.getElementById('expand').addEventListener('click', () => { for (const detail of details) detail.open = true; });
document.getElementById('collapse').addEventListener('click', () => { for (const detail of details) detail.open = false; });
document.getElementById('source')?.addEventListener('click', () => host.postMessage({ type: 'source' }));
document.getElementById('copy').addEventListener('click', () => host.postMessage({ type: 'copy' }));
const captureTree = document.getElementById('capture-tree');
const treeText = document.getElementById('original-tree');
const treeStatus = document.getElementById('tree-status');
const copyTree = document.getElementById('copy-tree');
captureTree?.addEventListener('click', () => {
  captureTree.disabled = true;
  treeStatus.textContent = 'Capturing MySQL TREE text…';
  treeStatus.hidden = false;
  host.postMessage({ type: 'tree' });
});
copyTree?.addEventListener('click', () => host.postMessage({ type: 'copy-tree' }));
if (captureTree) window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'tree') {
    treeText.textContent = message.text;
    treeText.hidden = copyTree.hidden = false;
    treeStatus.hidden = captureTree.hidden = true;
  } else if (message?.type === 'tree-error') {
    treeStatus.textContent = message.text;
    captureTree.disabled = false;
  }
});
</script></body></html>`;
}

function comparisonHtml(result, nonce) {
  const status = { same: 'Unchanged', changed: 'Changed', removed: 'Baseline only', added: 'Candidate only' };
  function cell(node, position, changes, side) {
    if (!node) return '—';
    const fields = [['Position', position], ...node.values.map(item => [item.label, item.value]),
      ...changes.map(change => ['Changed ' + change.label.toLowerCase(), change[side] || '—']), ...node.detail];
    return fields.map(([label, value]) => '<div>' + escape(label) + ' <strong>' + escape(value) + '</strong></div>').join('') || '—';
  }
  const rows = result.rows.map(({ state, before, after, alignment, changes = [], baselinePosition, candidatePosition }) => {
    const node = before || after;
    const moveLabel = moveLabels[alignment];
    const label = moveLabel ? moveLabel + (state === 'changed' ? ' · Changed' : '') : status[state];
    return '<tr><th scope="row">' + escape(node.name) + ' <small>Level ' + escape(node.depth + 1) +
      '</small></th><td>' + label + (changes.length ? '<br><small>Paired by table or alias label and access method</small>' : '') +
      '</td><td>' + cell(before, baselinePosition, changes, 'before') + '</td><td>' + cell(after, candidatePosition, changes, 'after') + '</td></tr>';
  }).join('');
  const counts = Object.entries(status).map(([state, label]) => label + ' ' + result.counts[state]).join(' · ') +
    ' · Moved ' + result.movedCount + ' · Candidate moves ' + result.candidateMoveCount +
    ' · Reviewed pairs ' + result.reviewedPairCount;
  const warnings = ['baseline', 'candidate'].flatMap(side => (result[side + 'Warnings'] || [])
    .map(message => '<p><strong>' + (side === 'baseline' ? 'Baseline' : 'Candidate') + '</strong> · ' + escape(message) + '</p>')).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Compare SQL plans</title><style nonce="${nonce}">
  body{margin:0;padding:1rem;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family,sans-serif)}
  h1{font-size:1.2rem;margin:0}p,small{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse;width:100%}
  th,td{text-align:left;vertical-align:top;overflow-wrap:anywhere;border-bottom:1px solid var(--vscode-panel-border);padding:.5rem}
  thead{background:var(--vscode-editorWidget-background)}strong{font-weight:600}
  ${reviewStyles}
</style></head><body><h1>Compare SQL plans</h1><p>${escape(result.version)} · ${escape(result.database)} ·
${result.measured ? 'Measured captures' : 'Optimizer estimates'}</p><p>${escape(counts)}</p>
<p>Candidate moves use unique table or alias labels and matching access methods. Review alias reuse and the before-and-after access details.</p>${warnings}
${candidateReviewHtml(result, nonce)}
<table><thead><tr><th scope="col">Operator</th><th scope="col">State</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
}

function seriesHtml(series, plans, nonce) {
  const comparing = !plans;
  const describeStats = (row, total) => {
    if (!row) return '—';
    const availability = row.count + '/' + total + ' samples' + (row.omitted ? ' · ' + row.omitted + ' unparsed' : '');
    const values = row.count ? '<div>Min <strong>' + escape(row.min) + '</strong> · Median <strong>' +
      escape(row.median) + '</strong> · Max <strong>' + escape(row.max) + '</strong></div>' : '';
    return '<span>' + escape(availability) + '</span>' + values;
  };
  const rows = series.metrics.slice(0, 400).map(item => {
    const row = comparing ? item.baseline || item.candidate : item;
    const moveLabel = moveLabels[item.alignment];
    const location = comparing && moveLabel
      ? moveLabel + ' ' + item.baselinePosition + ' → ' + item.candidatePosition : 'Level ' + (row.depth + 1);
    const id = '<th scope="row">' + escape(row.name) + ' <small>' + escape(location) + '</small></th>';
    const metric = '<td>' + escape(row.label) + '</td>';
    const summaries = comparing
      ? '<td>' + describeStats(item.baseline, series.baseline.samples) + '</td><td>' + describeStats(item.candidate, series.candidate.samples) + '</td>'
      : '<td>' + describeStats(item, series.totalSamples) + '</td>';
    return '<tr>' + id + metric + summaries + '</tr>';
  }).join('');
  const warnings = comparing
    ? [...series.baseline.warnings.map(note => 'Baseline · ' + note), ...series.candidate.warnings.map(note => 'Candidate · ' + note)]
    : series.warnings;
  const report = comparing
    ? 'Baseline · ' + series.baseline.samples + ' samples, ' + series.baseline.shapes + ' shapes. Candidate · ' +
      series.candidate.samples + ' samples, ' + series.candidate.shapes + ' shapes. Moved operators · ' + series.movedCount +
      ' · Candidate moves · ' + series.candidateMoveCount + ' · Reviewed pairs · ' + series.reviewedPairCount
    : series.totalSamples + ' sequential samples · ' + series.shapes.length + ' decoded plan shapes';
  const details = plans ? '<h2>Raw captures</h2>' + plans.map((plan, index) =>
    '<details><summary>Sample ' + (index + 1) + ' · Shape ' +
    series.shapes.find(shape => shape.samples.includes(index + 1)).label + ' · ' + escape(plan.format.toUpperCase()) +
    '</summary><pre>' + escape(plan.raw) + '</pre></details>').join('') : '';
  const accessRows = (series.changedAccess || []).slice(0, 100).flatMap(item => item.changes.map(change =>
    '<tr><th scope="row">' + escape(item.baselineName) + ' <small>' + escape(item.baselinePosition) + ' → ' +
    escape(item.candidatePosition) + '</small></th><td>' + escape(change.label) + '</td><td>' +
    escape(change.before || '—') + '</td><td>' + escape(change.after || '—') + '</td></tr>')).join('');
  const access = accessRows ? '<h2>Changed access details</h2><table><thead><tr><th scope="col">Candidate operator</th>' +
    '<th scope="col">Detail</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr></thead><tbody>' + accessRows +
    '</tbody></table>' + (series.changedAccess.length > 100 ? '<p>Showing the first 100 changed access operators.</p>' : '') : '';
  const title = comparing ? 'Compare SQL measurement series' : 'SQL measurement series';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${title}</title><style nonce="${nonce}">
  body{margin:0;padding:1rem;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family,sans-serif)}
  h1{font-size:1.2rem;margin:0}h2{font-size:1rem}p,small,td span{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse;width:100%}
  th,td{text-align:left;vertical-align:top;overflow-wrap:anywhere;border-bottom:1px solid var(--vscode-panel-border);padding:.5rem}
  thead{background:var(--vscode-editorWidget-background)}strong{font-weight:600}
  details{margin:.45rem 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}
  ${reviewStyles}
</style></head><body><h1>${title}</h1><p>${escape(series.version)} · ${escape(series.database)} · ${escape(report)}</p>
${series.saved ? '<p>Saved samples carry the server details recorded in the file. Confirm their origin before interpreting the comparison.</p>' : ''}
${comparing ? '<p>Candidate moves use stable, unique table or alias labels and matching access methods. Review alias reuse and the access details.</p>' : ''}
${warnings.map(warning => '<p>' + escape(warning) + '</p>').join('')}
${comparing ? candidateReviewHtml(series, nonce) : ''}
${access}
${series.metrics.length > 400 ? '<p>Showing the first 400 operator metrics.</p>' : ''}
<table><thead><tr><th scope="col">Operator</th><th scope="col">Metric</th>${comparing ? '<th scope="col">Baseline</th><th scope="col">Candidate</th>' : '<th scope="col">Observed distribution</th>'}</tr></thead>
<tbody>${rows}</tbody></table>${details}</body></html>`;
}

module.exports = { explanationHtml, comparisonHtml, seriesHtml };
