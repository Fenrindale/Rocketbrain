'use strict';

const maxDepth = 8;
const maxComponents = 256;
const maxGroups = 32;
const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const segment = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(value);

function healthPath(path) {
  if (!Array.isArray(path) || path.length > maxDepth || ![...path].every(segment)) {
    throw new TypeError('Choose a supported advertised Health group or component path.');
  }
  return path.map(value => encodeURIComponent(value)).join('/');
}

function normalizeHealth(payload, redact = value => value) {
  const label = (value, max = 128) => typeof value === 'string'
    ? redact(value).replace(/[\s\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
  const status = value => isObject(value) ? label(value.status, 64) : '';
  if (!status(payload)) throw new TypeError('Actuator Health must contain an aggregate status.');
  let count = 0, limited = false;

  function named(name) {
    const display = label(name);
    return { name: display || 'Unnamed contributor', segment: display === name && segment(name) ? name : null };
  }

  function node(value, depth) {
    const components = [];
    if (isObject(value.components)) {
      for (const name in value.components) {
        if (!Object.hasOwn(value.components, name)) continue;
        if (depth === maxDepth || count === maxComponents) { limited = true; break; }
        const child = value.components[name];
        if (!status(child)) { limited = true; continue; }
        count++;
        components.push({ ...named(name), ...node(child, depth + 1) });
      }
    } else if (Object.hasOwn(value, 'components')) {
      limited = true;
    }
    return { status: status(value), components, visibility: isObject(value.components) ? 'components' : 'status-only' };
  }

  const tree = node(payload, 0), groups = [], seenGroups = new Set();
  if (Array.isArray(payload.groups)) {
    for (const name of payload.groups) {
      if (groups.length === maxGroups) { limited = true; break; }
      if (typeof name !== 'string' || !label(name)) { limited = true; continue; }
      const entry = named(name);
      if (seenGroups.has(entry.name)) continue;
      seenGroups.add(entry.name);
      groups.push(entry);
    }
  }
  return { ...tree, groups, limited, detailsRetained: false };
}

function healthChoices(observation, pathLength) {
  if (pathLength >= maxDepth || observation.state !== 'observed') return [];
  const groups = new Set(observation.groups.map(item => item.segment).filter(Boolean));
  return [
    ...observation.groups.filter(item => item.segment).map(item => ({ kind: 'group', ...item })),
    ...observation.components.filter(item => item.segment && !groups.has(item.segment)).map(item => ({ kind: 'component', ...item }))
  ].map(({ kind, name, segment }) => ({ kind, name, segment }));
}

module.exports = { healthPath, normalizeHealth, healthChoices };
