'use strict';

const { createHash } = require('node:crypto');
const { identifier } = require('./schema-rename');
const { loadSource, listNames } = require('./object-source');

const kinds = ['procedure', 'function', 'trigger', 'event'];
const maxObjects = 100;
const maxObjectBytes = 128 * 1024;
const maxCapturedBytes = 4 * 1024 * 1024;
const sources = ['observed', 'withheld', 'unavailable', 'over-bound'];
const contextKeys = ['sql_mode', 'character_set_client', 'collation_connection', 'database collation', 'time_zone'];
const ordinary = contextKeys.slice(0, 4);
const types = new Set(['loaded', 'unavailable', 'over-bound']);
const difference = 'Stored objects are compared from observable source and creation settings only.';
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_DIFF_STORED_OBJECTS' });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = object => JSON.stringify([object.kind, object.name]);
const ordered = items => [...items].sort((a, b) => id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const permission = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_PROCACCESS_DENIED_ERROR']);

function text(value, maximum, message) {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > maximum) throw fail(message);
  return value;
}

function observedSettings(kind, value) {
  const result = {};
  for (const key of (kind === 'event' ? contextKeys : ordinary)) {
    const setting = value?.[key] ?? (key === 'time_zone' ? value?.['time zone'] : undefined);
    result[key] = text(setting, 4096, 'A stored object lacks valid creation settings.');
    if (key !== 'sql_mode' && !result[key]) throw fail('A stored object lacks complete creation settings.');
  }
  return result;
}

function triggerOrder(value) {
  if (!value || !['BEFORE', 'AFTER'].includes(value.timing) || !['INSERT', 'UPDATE', 'DELETE'].includes(value.event) ||
      !Number.isSafeInteger(value.actionOrder) || value.actionOrder < 1) throw fail('A trigger lacks observable table and action order metadata.');
  return { table: identifier(value.table, { table: true }), timing: value.timing, event: value.event, actionOrder: value.actionOrder };
}

function normalizeObject(value) {
  if (!value || !kinds.includes(value.kind) || !sources.includes(value.state)) throw fail('Invalid stored object or visibility state.');
  const { kind, state } = value, name = identifier(value.name);
  if (state !== 'observed') return { kind, name, state };
  const definition = text(value.definition, maxObjectBytes, 'A stored definition exceeds its supported size or encoding.');
  if (!/^\s*CREATE\s/iu.test(definition)) throw fail('Choose an exact CREATE definition returned by the server.');
  const settings = observedSettings(kind, value.settings);
  return { kind, name, state, definition, settings, ...(kind === 'trigger' && { trigger: triggerOrder(value.trigger) }) };
}

function normalizeStored(value, server, { verifyFingerprint = true } = {}) {
  if (value?.formatVersion !== 1 || value.scope !== 'account-visible' || !Array.isArray(value.objects) ||
      value.objects.length > maxObjects || !kinds.every(kind => types.has(value.coverage?.[kind]))) throw fail('Invalid stored-object snapshot.');
  const coverage = Object.fromEntries(kinds.map(kind => [kind, value.coverage[kind]]));
  const objects = ordered(value.objects.map(normalizeObject));
  if (new Set(objects.map(id)).size !== objects.length || objects.some(object => coverage[object.kind] !== 'loaded')) {
    throw fail('The stored-object inventory has duplicate identities or lies outside observed coverage.');
  }
  const body = { formatVersion: 1, scope: 'account-visible', coverage, objects };
  const fingerprint = hash([server, body]);
  if (verifyFingerprint && value.fingerprint !== fingerprint) throw fail('The stored-object snapshot content or server does not match its fingerprint.');
  if (Buffer.byteLength(JSON.stringify(body)) > maxCapturedBytes) throw fail('Stored-object snapshot content exceeds 4 MiB.');
  return { ...body, fingerprint };
}

async function captureStored(query, server) {
  const context = { database: server.database, dialect: server.dialect, version: server.version };
  const assertServer = async () => {
    const uid = server.dialect === 'mariadb' ? '@@server_uid' : '@@server_uuid';
    const { rows } = await query('SELECT VERSION(),DATABASE(),CURRENT_USER(),' + uid + ',@@sql_mode');
    if (!same(rows, [[server.version, server.database, server.currentUser, server.serverUniqueId, server.sqlMode]])) {
      throw fail('The active server or account changed during stored-object inspection.');
    }
  };
  async function inventory() {
    const coverage = {}, items = [];
    for (const kind of kinds) {
      try {
        const page = await listNames(query, context, { schema: server.database, kind });
        coverage[kind] = page.next === null ? 'loaded' : 'over-bound';
        if (!page.next) items.push(...page.items);
      } catch (cause) {
        if (!permission.has(cause.code)) throw cause;
        coverage[kind] = 'unavailable';
      }
    }
    if (items.length > maxObjects) throw fail('At most 100 visible routines, triggers and events are supported per stored-object snapshot.');
    return { coverage, items };
  }
  const captureTrigger = async object => {
    const { rows } = await query('SELECT EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,ACTION_ORDER ' +
      'FROM information_schema.TRIGGERS WHERE BINARY TRIGGER_SCHEMA=BINARY ? AND BINARY TRIGGER_NAME=BINARY ? LIMIT 2',
    [server.database, object.name]);
    if (rows.length !== 1) throw fail('The visible trigger action metadata could not be confirmed.');
    const [table, timing, event, order] = rows[0];
    return triggerOrder({ table, timing, event, actionOrder: Number(order) });
  };
  const observe = async object => {
    const { name, kind } = object;
    try {
      const shown = await loadSource(query, context, object);
      if (Buffer.byteLength(shown.source) > maxObjectBytes) return { name, kind, state: 'over-bound' };
      return normalizeObject({ kind, name, state: 'observed', definition: shown.source, settings: shown.settings,
        ...(kind === 'trigger' && { trigger: await captureTrigger(object) }) });
    } catch (cause) {
      if (permission.has(cause.code) || cause.code === 'ROCKETBRAIN_OBJECT_SOURCE_PERMISSION') return { kind, name, state: 'withheld' };
      if (cause.code === 'ROCKETBRAIN_OBJECT_SOURCE_SIZE') return { kind, name, state: 'over-bound' };
      if (cause.code?.startsWith('ROCKETBRAIN_OBJECT_SOURCE_') || cause.code === 'ROCKETBRAIN_DIFF_STORED_OBJECTS') {
        return { kind, name, state: 'unavailable' };
      }
      throw cause;
    }
  };
  await assertServer();
  const before = await inventory(), objects = [];
  let bytes = 0;
  for (const item of before.items) {
    const value = await observe(item);
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxCapturedBytes) throw fail('Stored-object snapshot content exceeds 4 MiB.');
    objects.push(value);
  }
  for (const [index, item] of before.items.entries()) {
    if (!same(await observe(item), objects[index])) throw fail('A stored definition or its visibility changed during comparison capture.');
  }
  if (!same(before, await inventory())) throw fail('The visible stored-object inventory changed during capture.');
  await assertServer();
  return normalizeStored({ formatVersion: 1, scope: 'account-visible', ...before, objects }, server, { verifyFingerprint: false });
}

function compareStored(current, desired, sameDialect) {
  if (!current || !desired) return { state: 'not-compared', differences: [], matchedExact: 0, semanticEquivalenceCompared: false,
    reason: 'Capture the stored-object inventory on both sides to compare it.' };
  const from = new Map(current.objects.map(object => [id(object), object])), to = new Map(desired.objects.map(object => [id(object), object]));
  const differences = [];
  let matchedExact = 0;
  for (const key of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const before = from.get(key) || null, after = to.get(key) || null;
    const { kind, name } = before || after;
    let state, aspects = [];
    if (!before || !after) {
      const unseen = before ? desired : current;
      state = unseen.coverage[kind] === 'loaded' ? (before ? 'seen-current-only' : 'seen-desired-only') : 'inventory-unavailable';
    } else if (before.state !== 'observed' || after.state !== 'observed') state = 'definition-unavailable';
    else {
      aspects = ['definition', 'settings', 'trigger'].filter(aspect => !same(before[aspect], after[aspect]));
      if (!aspects.length && sameDialect) { matchedExact++; continue; }
      state = aspects.length ? 'changed-source-or-context' : 'same-text-cross-dialect';
    }
    differences.push({ id: hash(['stored-object', kind, name]).slice(0, 24), kind, name, state, aspects, before, after, selectable: false });
  }
  return { state: 'account-visible-comparison', current: current.coverage, desired: desired.coverage,
    differences, matchedExact, semanticEquivalenceCompared: false, note: difference };
}

module.exports = { normalizeStored, captureStored, compareStored };
