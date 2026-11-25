'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { examineJdbcDriver, runJdbc, credentials } = require('./jdbc');

const key = 'rocketbrain.jdbc.profiles.v1';
const approvalLifetime = 5 * 60 * 1000;
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_JDBC_PROFILE' });

function createJdbcProfiles({ state, isTrusted, getJavaHome }) {
  const approvals = new Map();
  let active, operation, disposed = false;
  function trusted() {
    if (disposed || !isTrusted()) throw fail('Trust the workspace before using custom JDBC profiles.');
  }
  function profiles() {
    const saved = state.get(key);
    return saved?.version === 1 && Array.isArray(saved.profiles) && saved.profiles.length <= 20 ?
      saved.profiles.filter(item => /^[a-f0-9-]{36}$/i.test(item?.id) && typeof item.name === 'string' && item.name.length <= 80 &&
        typeof item.jar === 'string' && path.isAbsolute(item.jar) && typeof item.driverClass === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) &&
        Number.isInteger(item.size) && item.size > 0 && item.size <= 64 * 1024 * 1024)
        .map(({ id, name, jar, driverClass, sha256, size }) => ({ id, name, jar, driverClass, sha256, size })) : [];
  }
  async function run(action, signal) {
    trusted();
    if (operation) throw fail('Finish the current JDBC operation first.');
    const controller = new AbortController();
    operation = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const value = await action(controller.signal);
      trusted();
      if (controller.signal.aborted) throw fail('The JDBC operation was cancelled.');
      return value;
    } finally { operation = undefined; signal?.removeEventListener('abort', cancel); }
  }
  function current() {
    if (!active) throw fail('Open a saved JDBC connection first.');
    return active;
  }
  return {
    list() { trusted(); return structuredClone(profiles()); },
    prepare({ name, jar, driverClass }, { signal } = {}) {
      return run(async cancellation => {
        if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw fail('Enter a JDBC profile name up to 80 characters.');
        const data = await examineJdbcDriver(jar, driverClass, cancellation);
        trusted();
        if (cancellation.aborted) throw fail('The JDBC operation was cancelled.');
        const id = randomUUID(), profile = { id, name: name.trim(), ...data };
        for (const [saved, value] of approvals) if (value.expires <= Date.now()) approvals.delete(saved);
        while (approvals.size >= 8) approvals.delete(approvals.keys().next().value);
        approvals.set(id, { expires: Date.now() + approvalLifetime, profile });
        return { ...profile };
      }, signal);
    },
    save(id, approved) {
      return run(async () => {
        const value = approvals.get(id), catalog = profiles();
        if (approved !== true || !value || value.expires <= Date.now() || catalog.length >= 20) throw fail('Review this JDBC driver again and explicitly approve its exact JAR.');
        if (catalog.some(item => item.name.toLowerCase() === value.profile.name.toLowerCase())) throw fail('Choose a unique JDBC profile name.');
        await state.update(key, { version: 1, profiles: [...catalog, value.profile] });
        approvals.delete(id);
        return { ...value.profile };
      });
    },
    remove(id) {
      return run(async () => {
        await state.update(key, { version: 1, profiles: profiles().filter(item => item.id !== id) });
        if (active?.profile.id === id) active = undefined;
      });
    },
    open(id, input, { signal } = {}) {
      return run(async cancellation => {
        const profile = profiles().find(item => item.id === id);
        if (!profile) throw fail('Select a current approved JDBC profile.');
        const credential = credentials(input);
        const catalog = await runJdbc({ javaHome: getJavaHome(), profile, credential, operation: 'catalog', signal: cancellation });
        trusted();
        if (cancellation.aborted) throw fail('The JDBC operation was cancelled.');
        active = { profile, credential, catalog };
        return structuredClone(catalog);
      }, signal);
    },
    active() { return active && isTrusted() ? { id: active.profile.id, name: active.profile.name } : null; },
    catalog() { trusted(); return structuredClone(current().catalog); },
    describe(index, { signal } = {}) {
      return run(async cancellation => {
        const { profile, credential, catalog } = current();
        const table = Number.isInteger(index) && catalog.objects[index];
        if (!table) throw fail('Select a table or view from the active JDBC catalog.');
        return runJdbc({ javaHome: getJavaHome(), profile, credential, operation: 'describe', object: table, signal: cancellation });
      }, signal);
    },
    query(sql, { maxRows, signal } = {}) {
      return run(cancellation => {
        const { profile, credential } = current();
        return runJdbc({ javaHome: getJavaHome(), profile, credential, operation: 'query', sql, maxRows, signal: cancellation });
      }, signal);
    },
    close() { operation?.abort(); active = undefined; },
    dispose() { this.close(); disposed = true; approvals.clear(); }
  };
}

module.exports = { createJdbcProfiles };
