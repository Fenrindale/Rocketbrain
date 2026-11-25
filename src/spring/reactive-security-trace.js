'use strict';

const hooks = new Set(['proxy', 'filter-execution', 'web-verification', 'method-before', 'method-after']);
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'OTHER']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isSymbol = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_.$]{1,192}$/.test(value);
const bounded = (array, max) => Array.isArray(array) && array.length <= max;
const isType = value => typeof value === 'string' && value.length <= 192 && /^[A-Za-z0-9_.$]+(?:\[\])*$/.test(value);

function invalid() { throw new Error('Invalid reactive security trace.'); }

function normalizeReactiveSecurityTrace(raw) {
  if (!isObject(raw) || raw.schemaVersion !== 1 || typeof raw.enabled !== 'boolean' ||
      !bounded(raw.hooks, hooks.size) || new Set(raw.hooks).size !== raw.hooks.length ||
      !raw.hooks.every(hook => hooks.has(hook)) || !bounded(raw.traces, 16) || !isCount(raw.dropped)) invalid();
  const state = !raw.enabled ? 'disabled' : raw.hooks.includes('proxy') ? 'ready' : 'waiting';
  if (raw.state !== state || state !== 'ready' && raw.traces.length ||
      state === 'disabled' && (raw.hooks.length || raw.dropped)) invalid();
  const ids = new Set();
  const traces = raw.traces.map(trace => {
    if (!isObject(trace) || !isCount(trace.id) || trace.id === 0 || ids.has(trace.id) ||
        typeof trace.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(trace.startedAt) ||
        !Number.isFinite(Date.parse(trace.startedAt)) || !isCount(trace.durationMs) || !methods.has(trace.method) ||
        trace.status !== null && (!Number.isInteger(trace.status) || trace.status < 100 || trace.status > 599) ||
        !['completed', 'error', 'canceled', 'unobserved'].includes(trace.terminal) ||
        !['observed', 'partial'].includes(trace.coverage) || !bounded(trace.matches, 16) ||
        !bounded(trace.configured, 32) || !trace.configured.every(isSymbol) || !isCount(trace.entered) ||
        trace.entered > trace.configured.length || !['passed', 'denied', 'unobserved'].includes(trace.verification) ||
        !bounded(trace.methodDecisions, 8)) invalid();
    ids.add(trace.id);
    const matches = trace.matches.map(match => {
      if (!isObject(match) || !isSymbol(match.type) || match.matched !== null && typeof match.matched !== 'boolean') invalid();
      return { type: match.type, matched: match.matched };
    });
    if (trace.selectedChain === null) {
      if (trace.configured.length || trace.verification !== 'unobserved' || trace.coverage === 'observed') invalid();
    } else if (!isCount(trace.selectedChain) || matches[trace.selectedChain]?.matched !== true) invalid();
    const methodDecisions = trace.methodDecisions.map(decision => {
      if (!isObject(decision) || !['before', 'after'].includes(decision.phase) ||
          !isSymbol(decision.owner) || !isSymbol(decision.method) || !raw.hooks.includes('method-' + decision.phase) ||
          decision.parameterTypes !== null && (!bounded(decision.parameterTypes, 16) || !decision.parameterTypes.every(isType)) ||
          !['granted', 'denied', 'abstained'].includes(decision.decision)) invalid();
      return { phase: decision.phase, owner: decision.owner, method: decision.method, decision: decision.decision,
        parameterTypes: decision.parameterTypes === null ? null : [...decision.parameterTypes] };
    });
    const { id, startedAt, durationMs, method, status, terminal, coverage, selectedChain, configured, entered, verification } = trace;
    return { id, startedAt, durationMs, method, status, terminal, coverage, matches, selectedChain,
      configured: [...configured], entered, verification, methodDecisions };
  });
  return { schemaVersion: 1, enabled: raw.enabled, state, hooks: [...raw.hooks], dropped: raw.dropped, traces: traces.reverse() };
}

module.exports = { normalizeReactiveSecurityTrace };
