'use strict';

const escape = text => String(text ?? '').replace(/[&<>"']/g, value => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[value]);

const errors = new Map([
  ['AUTH_REQUIRED', 'The current account cannot read this Health endpoint.'],
  ['NOT_EXPOSED', 'This Health endpoint is unavailable at the selected path.'],
  ['REDIRECT_BLOCKED', 'The server redirected this Health request.'],
  ['TIMEOUT', 'The Health request timed out.'],
  ['RESPONSE_TOO_LARGE', 'The response exceeded the configured size limit.'],
  ['INVALID_JSON', 'The response could not be read as JSON.'],
  ['INVALID_SCHEMA', 'The response did not contain a supported Health status.']
]);

function badge(status) {
  const kind = status === 'UP' ? 'good' : status === 'DOWN' || status === 'OUT_OF_SERVICE' ? 'bad' : 'neutral';
  return '<span class="status ' + kind + '">' + escape(status) + '</span>';
}

function renderHealth(view, choices, nonce, revision) {
  const { state, observation, path } = view;
  const byRoute = new Map(choices.map((choice, index) => [choice.kind + ':' + choice.segment, index]));
  function pick(kind, item) {
    const index = byRoute.get(kind + ':' + item.segment);
    return index === undefined ? escape(item.name) :
      '<button class="link" type="button" data-action="select" data-index="' + index + '">' + escape(item.name) + '</button>';
  }
  function components(items, first = false) {
    if (!items.length) return '';
    return '<ul class="components">' + items.map(item => '<li><div class="row"><span>' +
      (first ? pick('component', item) : escape(item.name)) + '</span>' + badge(item.status) + '</div>' +
      components(item.components) + '</li>').join('') + '</ul>';
  }

  const location = ['Application', ...path.map(step => step.name)].map(escape).join(' / ');
  const observed = observation && state === 'observed';
  const header = '<header><div><h1>Spring Actuator Health</h1><p class="location">' + location + '</p></div>' +
    '<div class="actions">' + (path.length ? '<button type="button" data-action="back" ' + (state === 'loading' ? 'disabled' : '') + '>Back</button>' : '') +
    (state !== 'disconnected' ? '<button type="button" data-action="refresh" ' + (state === 'loading' ? 'disabled' : '') + '>Refresh</button>' : '') + '</div></header>';
  let content;
  if (observed) {
    const groups = observation.groups.length ? '<section><h2>Health groups</h2><ul class="groups">' +
      observation.groups.map(item => '<li>' + pick('group', item) + '</li>').join('') + '</ul></section>' : '';
    const visibility = observation.visibility === 'status-only'
      ? '<p>Only the aggregate status is visible at this endpoint.</p>'
      : observation.components.length ? '<section><h2>Components</h2>' + components(observation.components, true) + '</section>'
        : '<p>The response listed zero visible components.</p>';
    content = '<section class="report"><h2>Aggregate status</h2><div class="aggregate">' + badge(observation.status) +
      '<span class="muted">HTTP ' + observation.httpStatus + '</span></div><p class="muted">Observed <time datetime="' +
      escape(observation.observedAt) + '">' + escape(observation.observedAt) + '</time></p></section>' + groups + visibility +
      (observation.limited ? '<p class="muted">Some component entries exceeded the supported limits or could not be read.</p>' : '');
  } else if (state === 'unavailable') {
    content = '<p role="status">' + escape(errors.get(observation.code) || 'The Health request could not be completed.') +
      (observation.httpStatus ? ' HTTP ' + observation.httpStatus + '.' : '') + '</p>';
  } else if (state === 'loading') {
    content = '<p role="status">Reading Spring Actuator Health…</p>';
  } else if (state === 'ready') {
    content = '<p>Refresh to read Health from the current Spring runtime.</p>';
  } else {
    content = '<p>Connect to a Spring runtime to view its Actuator Health endpoint.</p>';
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Spring Actuator Health</title><style nonce="${nonce}">
  body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;line-height:1.5}
  main{max-width:840px;margin:auto}header,.row,.aggregate{display:flex;align-items:center;gap:14px;justify-content:space-between}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:12px;flex-wrap:wrap}
  h1{font-size:24px;margin:0}h2{font-size:15px;margin:0 0 8px}.report{margin:16px 0;padding:14px;border:1px solid var(--vscode-panel-border)}
  section{margin:20px 0}.location,.muted{color:var(--vscode-descriptionForeground);margin:4px 0;overflow-wrap:anywhere}.aggregate{justify-content:flex-start}
  .actions,.groups{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent);padding:4px 12px;cursor:pointer}
  button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{cursor:default;opacity:.65}
  button.link{color:var(--vscode-textLink-foreground);background:transparent;border:0;text-decoration:underline;padding:0;text-align:left;overflow-wrap:anywhere}
  .status{display:inline-block;flex:none;border:1px solid currentColor;padding:1px 7px;font-weight:600;max-width:55%;overflow-wrap:anywhere}
  .good{color:var(--vscode-testing-iconPassed,var(--vscode-foreground))}.bad{color:var(--vscode-errorForeground)}.neutral{color:var(--vscode-descriptionForeground)}
  ul{list-style:none;padding:0;margin:0}.components ul{border-inline-start:1px solid var(--vscode-panel-border);margin-inline-start:8px;padding-inline-start:12px}
  .row{min-height:30px;padding:2px 0;border-bottom:1px solid var(--vscode-panel-border);overflow-wrap:anywhere}
  </style></head><body><main>${header}${content}</main><script nonce="${nonce}">
  const host=acquireVsCodeApi();
  document.addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');
    if(!button)return;
    const message={action:button.dataset.action,revision:${revision}};
    if(button.dataset.index!==undefined)message.index=Number(button.dataset.index);
    host.postMessage(message);
  });
  </script></body></html>`;
}

module.exports = { renderHealth };
