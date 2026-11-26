'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeReactiveSecurityTrace } = require('../src/spring/reactive-security-trace');
const { renderReactiveSecurityTrace } = require('../src/spring/reactive-security-trace-vscode');

const baseline = () => ({
  schemaVersion: 1, enabled: true, state: 'ready', hooks: ['proxy', 'filter-execution', 'web-verification', 'method-before'],
  dropped: 0, traces: [{
    id: 1, startedAt: '2026-11-26T01:22:03.123456789Z', method: 'GET', status: 403, terminal: 'completed', durationMs: 4,
    coverage: 'observed', matches: [{ type: 'fixture.Chain', matched: false }, { type: 'fixture.Chain', matched: true }],
    selectedChain: 1, configured: ['fixture.FirstFilter', 'fixture.NextFilter'], entered: 2, verification: 'passed',
    methodDecisions: [{ owner: 'fixture.Service', method: 'load', parameterTypes: ['int[]'], phase: 'before', decision: 'denied' }]
  }]
});

function withAuthentication() {
  const value = baseline();
  value.authenticationEnabled = true;
  value.hooks.push('authentication-manager', 'authentication-delegates');
  const manager = 'org.springframework.security.authentication.DelegatingReactiveAuthenticationManager';
  const delegate = 'fixture.LookupManager';
  Object.assign(value.traces[0], {
    authenticationLimited: false, authenticationAttempts: [{
      managerId: 1, managerType: manager, outcome: 'returned', delegateCoverage: 'observed', delegates: [
        { sequence: 1, parent: 0, managerId: 2, managerType: delegate, outcome: 'empty' },
        { sequence: 2, parent: 0, managerId: 3, managerType: manager, outcome: 'returned' },
        { sequence: 3, parent: 2, managerId: 4, managerType: delegate, outcome: 'rejected' },
        { sequence: 4, parent: 2, managerId: 5, managerType: 'fixture.OtherManager', outcome: 'returned' }
      ]
    }]
  });
  return value;
}

test('reactive authentication keeps exact request-local identities, structural parents and outcome metadata', () => {
  const raw = withAuthentication(), attempt = raw.traces[0].authenticationAttempts[0];
  attempt.delegates[2].credential = 'private-credential';
  attempt.delegates[2].message = 'private-exception';
  const result = normalizeReactiveSecurityTrace(raw), html = renderReactiveSecurityTrace(result);
  assert.match(html, /Reactive authentication/);
  assert.match(html, /Manager 4 · fixture\.LookupManager · Authentication rejection · Dispatched by step 2/);
  assert.match(html, /Authentication result emitted/);
  for (const secret of ['private-credential', 'private-exception']) {
    assert.ok(!html.includes(secret));
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal(normalizeReactiveSecurityTrace(baseline()).authenticationEnabled, undefined);
  assert.doesNotMatch(renderReactiveSecurityTrace(normalizeReactiveSecurityTrace(baseline())), /Reactive authentication/);
});

test('reactive authentication refuses unproved delegate parent and identity claims', () => {
  const bad = [
    (raw,attempt) => { attempt.delegates[2].parent = 1; },
    (raw,attempt) => { attempt.delegates[2].parent = 3; },
    (raw,attempt) => { attempt.delegates[2].managerId = 1; },
    (raw,attempt) => { attempt.delegates[2].outcome = 'guessed'; },
    (raw,attempt) => { attempt.delegates[2].outcome = 'unobserved'; },
    raw => { raw.authenticationEnabled = false; },
    raw => { raw.hooks = raw.hooks.filter(hook => hook !== 'authentication-delegates'); }
  ];
  for (const mutate of bad) {
    const raw = withAuthentication();
    mutate(raw, raw.traces[0].authenticationAttempts[0]);
    assert.throws(() => normalizeReactiveSecurityTrace(raw), /Invalid reactive security trace/);
  }
});

test('reactive trace keeps explicit observation data and renders bounded evidence', () => {
  const raw = baseline();
  raw.token = 'private-token';
  raw.traces[0].methodDecisions[0].argumentValues = ['private-argument'];
  raw.traces[0].path = '/private-route';
  const result = normalizeReactiveSecurityTrace(raw);
  const report = JSON.stringify(result);
  const page = renderReactiveSecurityTrace(result);
  for (const privateValue of ['private-token', 'private-argument', 'private-route']) {
    assert.ok(!report.includes(privateValue));
    assert.ok(!page.includes(privateValue));
  }
  assert.match(page, /fixture\.Service\.load\(int\[\]\) · before invocation · denied/);
  assert.match(page, /Web verification passed/);
  assert.match(page, /Chain match order/);
  assert.match(page, /Content-Security-Policy/);
  assert.ok(!page.includes('<script'));
});

test('reactive trace rejects impossible selections and unsupported or oversized evidence', () => {
  const impossible = [
    raw => { raw.traces[0].selectedChain = 0; },
    raw => { raw.traces[0].entered = 3; },
    raw => { raw.traces[0].methodDecisions[0].phase = 'after'; },
    raw => { raw.traces[0].methodDecisions[0].parameterTypes = ['anything:']; },
    raw => { raw.traces[0].methodDecisions[0].owner = '<script>'; },
    raw => { raw.traces.push(structuredClone(raw.traces[0])); },
    raw => { raw.traces[0].methodDecisions = Array(9).fill(raw.traces[0].methodDecisions[0]); },
    raw => { raw.enabled = false; }
  ];
  for (const modify of impossible) {
    const raw = baseline();
    modify(raw);
    assert.throws(() => normalizeReactiveSecurityTrace(raw), /Invalid reactive security trace/);
  }
});

test('reactive trace labels unavailable status and unmatched chain without inferred outcome', () => {
  const raw = baseline();
  Object.assign(raw.traces[0], {
    status: null, selectedChain: null, matches: [{ type: 'fixture.Chain', matched: false }], configured: [], entered: 0,
    coverage: 'partial', verification: 'unobserved', methodDecisions: [], terminal: 'canceled'
  });
  const page = renderReactiveSecurityTrace(normalizeReactiveSecurityTrace(raw));
  assert.match(page, /Status unavailable/);
  assert.match(page, /Web verification unavailable · canceled · Partial trace/);
  assert.match(page, /No configured filters recorded/);
});
