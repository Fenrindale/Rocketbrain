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
