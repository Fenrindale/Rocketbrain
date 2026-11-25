'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readPlanFile } = require('./explain-plan-archive');
const { REVIEW_LIMIT } = require('./explain-plan-alignment');

const FORMAT = 'RocketbrainSqlPlanReview';
const VERSION = 1;
const MAX_REVIEW_FILE_BYTES = 16 * 1024;
const SECRET_PREFIX = 'rocketbrain.sql.planReview.v1.';
const ACTIVE_SECRET = SECRET_PREFIX + 'activeKey';
const hex = /^[a-f0-9]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => sha256(JSON.stringify(value));

function captureFingerprint(capturedAt, plans) {
  return fingerprint([capturedAt, plans.map(plan => [
    plan.engine, plan.version, plan.database, plan.format, Boolean(plan.measured), sha256(plan.raw)
  ])]);
}

function pairFingerprint(pair) {
  const side = item => [item.position, item.name, item.method, item.index, item.predicate];
  return fingerprint([pair.matching, side(pair.baseline), side(pair.candidate)]);
}

function captureBinding(kind, baseline, candidate) {
  return { kind, captures:[baseline, candidate].map(record =>
    captureFingerprint(record.capturedAt, kind === 'series' ? record.plans : [record.report])) };
}

function signedData({ kind, captures, decisions, keyId }) {
  return JSON.stringify([FORMAT, VERSION, kind, captures, decisions, keyId]);
}

function signature(review, secret) {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(signedData(review)).digest('hex');
}

function reviewKeyStore(secrets) {
  let activeKeyPromise;
  async function get(id) {
    if (typeof id !== 'string' || !hex.test(id)) return undefined;
    const key = await secrets.get(SECRET_PREFIX + id);
    if (typeof key === 'string' && hex.test(key) && sha256(Buffer.from(key, 'hex')) === id) return key;
  }
  async function activeKey() {
    const id = await secrets.get(ACTIVE_SECRET);
    if (id !== undefined) {
      const key = await get(id);
      if (!key) throw Error('The SQL plan review signing key is unavailable in this VS Code secret store.');
      return { id, key };
    }
    const bytes = randomBytes(32), key = bytes.toString('hex'), newId = sha256(bytes);
    // Write the key before its pointer. Concurrent first saves can each keep a valid key.
    await secrets.store(SECRET_PREFIX + newId, key);
    await secrets.store(ACTIVE_SECRET, newId);
    return { id:newId, key };
  }
  function createOrGet() {
    activeKeyPromise ??= activeKey().finally(() => {
      activeKeyPromise = undefined;
    });
    return activeKeyPromise;
  }
  return { createOrGet, get };
}

async function serializePlanReview(binding, pairs, decisions, keys) {
  if (!decisions.size) throw Error('Pair or ignore an alternative before saving the SQL plan review.');
  const used = new Map(pairs.map(pair => [pair.id, pair]));
  const entries = [...decisions].sort(([left], [right]) => Number(left) - Number(right))
    .map(([id, state]) => [id, pairFingerprint(used.get(id)), state]);
  const { id:keyId, key } = await keys.createOrGet();
  const payload = { format:FORMAT, version:VERSION, kind:binding.kind, captures:binding.captures, decisions:entries, keyId };
  return JSON.stringify({ ...payload, signature:signature(payload, key) }, null, 2) + '\n';
}

function readReviewPayload(bytes) {
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)); }
  catch { throw Error('Choose a UTF-8 Rocketbrain SQL plan review file.'); }
  if (!payload || Object.keys(payload).length !== 7 || payload.format !== FORMAT || payload.version !== VERSION ||
      !['plan', 'series'].includes(payload.kind) || !Array.isArray(payload.captures) || payload.captures.length !== 2 ||
      !payload.captures.every(item => typeof item === 'string' && hex.test(item)) ||
      typeof payload.keyId !== 'string' || !hex.test(payload.keyId) ||
      typeof payload.signature !== 'string' || !hex.test(payload.signature) ||
      !Array.isArray(payload.decisions) || !payload.decisions.length || payload.decisions.length > REVIEW_LIMIT ||
      payload.decisions.some(entry => !Array.isArray(entry) || entry.length !== 3 ||
        typeof entry[0] !== 'string' || !/^[1-9][0-9]?$/.test(entry[0]) || Number(entry[0]) > REVIEW_LIMIT ||
        typeof entry[1] !== 'string' || !hex.test(entry[1]) || !['accepted', 'ignored'].includes(entry[2])) ||
      new Set(payload.decisions.map(([id]) => id)).size !== payload.decisions.length) {
    throw Error('The SQL plan review file has an invalid version or structure.');
  }
  return payload;
}

async function inspectPlanReview(file, keys) {
  const bytes = await readPlanFile(file, MAX_REVIEW_FILE_BYTES, 'Choose a regular local SQL plan review file.',
    () => Error('SQL plan review files must be at most 16 KiB.'));
  const payload = readReviewPayload(bytes);
  const key = await keys.get(payload.keyId);
  if (!key) return { payload, verified:false };
  const valid = timingSafeEqual(Buffer.from(payload.signature, 'hex'), Buffer.from(signature(payload, key), 'hex'));
  if (!valid) throw Error('The SQL plan review signature is invalid. Choose the original review file.');
  return { payload, verified:true };
}

async function readPlanReview(file, keys) {
  const { payload, verified } = await inspectPlanReview(file, keys);
  if (!verified) throw Error('Open this SQL plan review with the same VS Code secret store that signed it.');
  return payload;
}

async function readSharedPlanReview(file, keys) {
  const { payload, verified } = await inspectPlanReview(file, keys);
  if (verified) throw Error('This SQL plan review was verified by your VS Code secret store. Use Load review.');
  return payload;
}

function planReviewCandidates(payload, binding, pairs) {
  if (payload.kind !== binding.kind || payload.captures.some((capture, index) => capture !== binding.captures[index])) {
    throw Error('Open the original SQL plan captures in the same baseline and candidate order.');
  }
  const candidates = new Map(pairs.map(pair => [pair.id, pair]));
  return payload.decisions.map(([id, evidence, state]) => {
    const pair = candidates.get(id);
    if (!pair || pairFingerprint(pair) !== evidence) throw Error('The original SQL plan candidates have changed.');
    return { pair, suggested:state };
  });
}

function applyPlanReview(payload, binding, pairs, current, compare) {
  const verified = planReviewCandidates(payload, binding, pairs), decisions = new Map(current);
  for (const { pair:{ id }, suggested:state } of verified) {
    if (current.has(id) && current.get(id) !== state) {
      throw Error('The saved review conflicts with an existing decision in this comparison.');
    }
    decisions.set(id, state);
  }
  const report = compare(decisions);
  const applied = new Map(report.candidateReview.pairs.map(pair => [pair.id, pair.status]));
  if ([...decisions].some(([id, state]) => applied.get(id) !== state)) {
    throw Error('The saved review contains an operator pairing that conflicts with another decision.');
  }
  return { report, decisions };
}

module.exports = { captureBinding, reviewKeyStore, serializePlanReview, readPlanReview, readSharedPlanReview, planReviewCandidates, applyPlanReview };
