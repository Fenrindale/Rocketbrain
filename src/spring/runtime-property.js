'use strict';

const KEY = /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*|\[[0-9]{1,7}\])*$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function propertyPath(key) {
  if (typeof key !== 'string' || key.length > 200 || !KEY.test(key))
    throw Error('Enter one literal Spring property key using dots, dashes, underscores or numeric indexes.');
  return '/' + encodeURIComponent(key);
}

function readProcessId(payload) {
  const pid = payload?.process?.pid;
  return Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff ? pid : null;
}

function readProperty(payload, redact) {
  if (!record(payload) || !Array.isArray(payload.propertySources) || payload.propertySources.length > 250 ||
      typeof payload.property?.source !== 'string' || !payload.property.source || !Object.hasOwn(payload.property, 'value'))
    throw Error('Unsupported Spring Boot environment property response.');

  const text = (value, limit) => typeof value === 'string' && value.length <= limit
    ? redact(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, character => '\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'))
    : null;
  const sourceName = payload.property.source;
  const source = text(sourceName, 1200);
  if (!source) throw Error('Unsupported effective property source name.');

  const sources = [];
  for (const [position, item] of payload.propertySources.entries()) {
    if (!record(item) || !text(item.name, 1200)) throw Error('Unsupported property source.');
    if (item.property === undefined || item.property === null) continue;
    if (!record(item.property) || !Object.hasOwn(item.property, 'value')) throw Error('Unsupported source property.');
    sources.push({ position: position + 1, name: text(item.name, 1200), origin: text(item.property.origin, 1600), effective: item.name === sourceName });
  }
  const matching = sources.filter(item => item.effective);
  if (matching.length > 1) for (const item of matching) item.effective = false;

  const value = payload.property.value;
  let display = { state: 'unavailable' };
  if (typeof value === 'string') {
    const sanitized = text(value, 4096);
    if (/^\*{3,}$/.test(value) || sanitized?.includes('[REDACTED]')) display = { state: 'redacted' };
    else if (sanitized !== null) display = { state: 'visible', type: 'string', value: sanitized };
  } else if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value)) {
    display = { state: 'visible', type: value === null ? 'null' : typeof value, value };
  }
  return { source, origin: matching.length === 1 ? matching[0].origin : null, display, sources };
}

module.exports = { propertyPath, readProcessId, readProperty };
