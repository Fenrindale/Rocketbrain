'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { typedParameter, LIMITS } = require('./sql-script');

const stateKey = 'rocketbrain.sql.parameterPresets.v1';
const secretKey = id => 'rocketbrain.sql.parameterPreset.' + id;
const maxPresets = 32;
const maxSecretBytes = 256 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
const isName = value => typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/u.test(value);

function presetSignature(description) {
  if (!isHash(description.parameterScope) || !isHash(description.sourceSqlHash) ||
    !['named', 'positional'].includes(description.parameterStyle) || !description.parameterDefinitions.length) return;
  return hash([description.parameterScope, description.sourceSqlHash, description.sqlMode, description.parameterStyle,
    description.parameterDefinitions.map(p => [p.key, p.name, p.index, p.occurrences]), description.parameterEvidence ?? null]);
}

function validatedValues(description, input) {
  const positional = description.parameterStyle === 'positional';
  if (positional !== Array.isArray(input) || !input || typeof input !== 'object' ||
    Object.keys(input).length !== description.parameterDefinitions.length) {
    throw Error('Preset values must exactly match the current SQL parameters.');
  }
  const values = positional ? [] : Object.create(null);
  let total = 0;
  const kinds = [];
  for (const parameter of description.parameterDefinitions) {
    const key = positional ? parameter.index : parameter.name;
    const entry = Object.getOwnPropertyDescriptor(input, key);
    if (!entry || entry.get || entry.set) throw Error('Preset values must exactly match the current SQL parameters.');
    const value = entry.value;
    const typed = typedParameter(value);
    values[key] = { kind: typed.kind, ...(typed.kind === 'null' ? {} : { value: value.value }) };
    kinds.push(typed.kind);
    total += typed.bytes * parameter.occurrences;
  }
  const data = JSON.stringify({ values, kinds });
  if (total > LIMITS.parameterBytes || Buffer.byteLength(data) > maxSecretBytes) {
    throw Error('Saved SQL parameter values exceed the preset storage limit.');
  }
  return { values, kinds, data };
}

function createParameterPresets({ state, secrets } = {}) {
  if (!state || !secrets) return;
  let queue = Promise.resolve();
  const serialize = operation => {
    const task = queue.then(operation);
    queue = task.catch(() => {});
    return task;
  };
  const records = () => {
    const saved = state.get(stateKey, []);
    return Array.isArray(saved) ? saved.slice(0, maxPresets).filter(entry => isId(entry?.id) &&
      isName(entry.name) && isHash(entry.signature) && isHash(entry.kindsHash)) : [];
  };
  const publicRecord = ({ id, name }) => ({ id, name });
  return {
    list(signature) {
      return records().filter(record => signature === undefined || record.signature === signature).map(publicRecord);
    },
    save(description, name, parameters, assertCurrent) {
      return serialize(async () => {
        assertCurrent();
        const signature = presetSignature(description);
        if (!signature) throw Error('An observed MySQL or MariaDB account and a parameterized SQL source are required.');
        if (typeof name !== 'string' || !isName(name.trim())) throw Error('Enter a preset name of at most 80 characters.');
        const all = records();
        if (all.length >= maxPresets) throw Error('Remove an existing SQL parameter preset before saving another one.');
        name = name.trim();
        if (all.some(entry => entry.signature === signature && entry.name === name)) throw Error('This SQL already has a preset with that name.');
        const { kinds, data } = validatedValues(description, parameters);
        const entry = { id: randomUUID(), name, signature, kindsHash: hash(kinds) };
        await secrets.store(secretKey(entry.id), data);
        try {
          assertCurrent();
          await state.update(stateKey, [...all, entry]);
        } catch (error) {
          await secrets.delete(secretKey(entry.id)).catch(() => {});
          throw error;
        }
        return publicRecord(entry);
      });
    },
    load(description, id, assertCurrent) {
      return serialize(async () => {
        assertCurrent();
        const signature = presetSignature(description);
        const entry = signature && records().find(record => record.id === id && record.signature === signature);
        if (!entry) throw Error('This preset does not match the SQL source, parameter definitions, or current connection account.');
        const data = await secrets.get(secretKey(id));
        assertCurrent();
        if (typeof data !== 'string' || Buffer.byteLength(data) > maxSecretBytes) throw Error('The saved preset values are unavailable.');
        let stored;
        try { stored = JSON.parse(data); }
        catch { throw Error('The saved preset values are unavailable.'); }
        const current = validatedValues(description, stored?.values);
        if (hash(current.kinds) !== entry.kindsHash || hash(stored.kinds) !== entry.kindsHash) {
          throw Error('The saved parameter types no longer match this preset.');
        }
        return current.values;
      });
    },
    remove(id, assertCurrent) {
      return serialize(async () => {
        assertCurrent();
        const all = records();
        if (!all.some(record => record.id === id)) return false;
        const value = await secrets.get(secretKey(id));
        assertCurrent();
        await secrets.delete(secretKey(id));
        try { await state.update(stateKey, all.filter(record => record.id !== id)); }
        catch (error) {
          if (typeof value === 'string') await secrets.store(secretKey(id), value).catch(() => {});
          throw error;
        }
        return true;
      });
    }
  };
}

module.exports = { createParameterPresets, presetSignature };
