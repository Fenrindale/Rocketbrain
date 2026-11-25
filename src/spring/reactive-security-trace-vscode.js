'use strict';

const { randomBytes } = require('node:crypto');
const { registerTracePanel } = require('./security-trace-vscode');
const VIEW = 'rocketbrain.spring.reactiveSecurityTrace';
const TITLE = 'Reactive Spring Security Trace';
const safe = value => String(value).replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);
const verification = {passed: 'Web verification passed', denied: 'Web verification denied', unobserved: 'Web verification unavailable'};

function renderReactiveSecurityTrace(report) {
  const nonce = randomBytes(16).toString('base64');
  const hint = report.state === 'disabled' ? 'Enable securityReactiveTrace in the observer configuration and restart the application.'
    : report.state === 'waiting' ? 'Waiting for a supported Spring Security WebFlux chain.'
    : report.traces.length ? report.traces.length + ' recent requests' + (report.dropped ? ' · ' + report.dropped + ' omitted' : '')
    : 'Send a request to the connected application, then run this command again.';
  const samples = report.traces.map((trace, index) => {
    const matches = trace.matches.map((match, position) => '<li>' + safe(match.type || 'Type unavailable') + ' · ' +
      (trace.selectedChain === position ? 'Selected' : match.matched === false ? 'Did not match' :
        match.matched === true ? 'Matched' : 'Result unavailable') + '</li>').join('');
    const stages = trace.configured.map((type, position) => '<li>' + safe(type || 'Type unavailable') + ' · ' +
      (position < trace.entered ? 'Entered' : 'Entry unobserved') + '</li>').join('');
    const decisions = trace.methodDecisions.map(event => {
      const signature = event.parameterTypes === null ? '' : '(' + event.parameterTypes.join(', ') + ')';
      const method = [event.owner, event.method].filter(Boolean).join('.');
      return '<li>' + safe(method ? method + signature : 'Method unavailable') +
        ' · ' + safe(event.phase) + ' invocation · ' + safe(event.decision) + '</li>';
    }).join('');
    return '<details' + (index === 0 ? ' open' : '') + '><summary>' + safe(trace.startedAt) + ' · ' + safe(trace.method) +
      ' · ' + (trace.status === null ? 'Status unavailable' : 'HTTP ' + trace.status) + ' · ' + trace.durationMs + ' ms</summary>' +
      '<p>' + safe(verification[trace.verification]) + ' · ' + safe(trace.terminal) +
      (trace.coverage === 'partial' ? ' · Partial trace' : '') + '</p><section><h2>Chain match order</h2>' +
      (matches ? '<ol>' + matches + '</ol>' : '<p>No matcher result recorded.</p>') +
      '</section><section><h2>Selected filter order</h2>' + (stages ? '<ol>' + stages + '</ol>' : '<p>No configured filters recorded.</p>') +
      '</section><section><h2>Reactive method authorization</h2>' +
      (decisions ? '<ul>' + decisions + '</ul>' : '<p>No method decision recorded.</p>') + '</section></details>';
  }).join('');
  return '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + nonce + '\'">' +
    '<title>' + TITLE + '</title><style nonce="' + nonce + '">body{padding:.75rem 1rem;font-family:var(--vscode-font-family)}' +
    'h1{font-size:1.25rem}h2{font-size:1rem} p,li{color:var(--vscode-descriptionForeground)}' +
    'details{padding:.65rem 0;border-bottom:1px solid var(--vscode-panel-border)} summary{cursor:pointer}' +
    'li{overflow-wrap:anywhere}</style></head><body><h1>' + TITLE + '</h1><p>' + safe(hint) + '</p>' + samples + '</body></html>';
}

function registerReactiveSecurityTrace(vscode, options) {
  return registerTracePanel(vscode, options, { viewId: VIEW, title: TITLE, inspect: 'reactiveSecurityTrace', render: renderReactiveSecurityTrace });
}

module.exports = { registerReactiveSecurityTrace, renderReactiveSecurityTrace };
