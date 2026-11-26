'use strict';

const { createHash } = require('node:crypto');

const maxBatchFiles = 8;
const maxBatchBytes = 2 * 1024 * 1024;
const hex = /^[0-9a-f]{64}$/u;
const operationReasons = new Set(['preimage-changed', 'staging-failed', 'replace-interrupted', 'readback-changed']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && hex.test(value);

function exactPaths(values, partsFor) {
  if (!Array.isArray(values) || values.length < 2 || values.length > maxBatchFiles || new Set(values).size !== values.length) {
    throw Error('Select two to eight distinct existing SSH files.');
  }
  return values.map(value => {
    const parts = partsFor(value);
    if (!parts.length || parts.some(part => /[. ]$/u.test(part) || part.toLowerCase().startsWith('.rocketbrain-batch-'))) {
      throw Error('Select physical SSH file paths without trailing dots, spaces or staging names.');
    }
    return parts;
  });
}

function validImage(entry) {
  return sha(entry?.sha256) && sha(entry?.stamp) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= maxBatchBytes;
}

function text(bytes) {
  const invalid = 'Choose supported saved UTF-8 text for each reviewed SSH replacement.';
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) throw Error(invalid);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Error(invalid); }
  return bytes;
}

function expectedEntries(plan, partsFor, applying) {
  const { rootKey, entries } = plan ?? {};
  if (!sha(rootKey)) throw Error('Choose a current reviewed SSH batch root.');
  const paths = exactPaths(entries?.map(row => row.path), partsFor);
  let beforeBytes = 0, afterBytes = 0;
  const targets = entries.map((row, index) => {
    if (!validImage(row.before) || !sha(row.after) || row.before.sha256 === row.after) {
      throw Error('Each SSH batch row needs distinct reviewed original and replacement bytes.');
    }
    beforeBytes += row.before.size;
    const target = { parts: paths[index], before: { sha256: row.before.sha256, stamp: row.before.stamp }, after: row.after };
    if (applying) {
      const data = text(row.data);
      afterBytes += data.length;
      if (digest(data) !== row.after) throw Error('The local SSH batch replacement changed after review.');
      target.content = data.toString('base64');
    }
    return target;
  });
  if (beforeBytes > maxBatchBytes || afterBytes > maxBatchBytes) throw Error('The SSH batch originals and replacements each have a total 2 MiB limit.');
  return { rootKey, targets };
}

function unknown(entries, reason) {
  return { state: 'unconfirmed', reason, rows: entries.map(() => ({ state: 'unconfirmed' })) };
}

function verifiedApply(result, plan) {
  if (!result || !['applied', 'refused', 'partial', 'unconfirmed'].includes(result.state) ||
      !Array.isArray(result.rows) || result.rows.length !== plan.entries.length ||
      (result.state === 'applied' ? result.reason !== undefined : !operationReasons.has(result.reason))) return false;
  for (const [index, entry] of result.rows.entries()) {
    if (!entry || !['confirmed', 'not-written', 'unconfirmed'].includes(entry.state) ||
        (entry.state === 'confirmed' && (!validImage(entry) || entry.sha256 !== plan.entries[index].after))) return false;
  }
  const states = result.rows.map(entry => entry.state);
  if (!/^c*u?n*$/u.test(states.map(state => state[0]).join(''))) return false;
  if (result.state === 'applied') return states.every(state => state === 'confirmed');
  if (result.state === 'refused') return states.every(state => state === 'not-written');
  if (result.state === 'partial') return states.includes('confirmed') && !states.every(state => state === 'confirmed');
  return !states.includes('confirmed') && states.includes('unconfirmed');
}

function createSshBatchOperations(request, partsFor) {
  return {
    async inspectBatch(values) {
      const paths = exactPaths(values, partsFor);
      const result = await request('inspect-batch', [], { targets: paths.map(parts => ({ parts })) });
      if (!sha(result?.rootKey) || !Array.isArray(result?.rows) || result.rows.length !== paths.length ||
          !result.rows.every(validImage) || result.rows.reduce((total, row) => total + row.size, 0) > maxBatchBytes) {
        throw Error('The remote SSH batch preimages could not be verified.');
      }
      return result;
    },
    async replaceBatch(plan) {
      const fields = expectedEntries(plan, partsFor, true);
      try {
        const result = await request('apply-batch', [], fields);
        return verifiedApply(result, plan) ? result : unknown(plan.entries, 'reply-unverified');
      } catch (error) {
        if (error.remoteCode === 'changed-root') {
          return { state: 'refused', reason: 'root-changed', rows: plan.entries.map(() => ({ state: 'not-written' })) };
        }
        return unknown(plan.entries, 'connection-interrupted');
      }
    },
    async readbackBatch(plan) {
      const fields = expectedEntries(plan, partsFor, false);
      const result = await request('readback-batch', [], fields);
      if (!Array.isArray(result?.rows) || result.rows.length !== fields.targets.length || result.rows.some((row, index) => {
        if (row?.state === 'missing' || row?.state === 'unavailable') return false;
        if (!validImage(row)) return true;
        const { before, after } = plan.entries[index];
        if (row.state === 'preimage') return row.sha256 !== before.sha256 || row.stamp !== before.stamp;
        if (row.state === 'replacement-bytes') return row.sha256 !== after;
        if (row.state === 'different') return row.sha256 === after || row.sha256 === before.sha256 && row.stamp === before.stamp;
        return true;
      })) throw Error('The SSH batch readback is incomplete.');
      return result.rows;
    }
  };
}

module.exports = { createSshBatchOperations, maxBatchBytes, maxBatchFiles, text };
