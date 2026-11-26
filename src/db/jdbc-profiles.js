'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { examineJdbcDriver, runJdbc, credentials, classpathFingerprint, maxLibraries } = require('./jdbc');
const { postgresqlRoute, postgresJdbcUrl } = require('./postgresql-jdbc');
const { comparePostgreSqlPlans } = require('./postgresql-plan');

const key = 'rocketbrain.jdbc.profiles.v1';
const approvalLifetime = 5 * 60 * 1000;
const maxVersions = 8;
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_JDBC_PROFILE' });
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const validName = value => typeof value === 'string' && value.trim() && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);

function artifact(value) {
  if (typeof value?.jar !== 'string' || !path.isAbsolute(value.jar) || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isInteger(value.size) || value.size < 1 || value.size > 64 * 1024 * 1024) return null;
  return { jar: value.jar, sha256: value.sha256, size: value.size };
}

function version(item) {
  const primary = artifact(item);
  if (!primary || !validId(item.id) || !validName(item.name) || typeof item.driverClass !== 'string' ||
      !Array.isArray(item.libraries) || item.libraries.length > maxLibraries) return null;
  const libraries = item.libraries.map(artifact);
  if (!libraries.every(Boolean)) return null;
  const fingerprint = classpathFingerprint(item.driverClass, [primary, ...libraries]);
  if (item.classpathFingerprint && fingerprint !== item.classpathFingerprint) return null;
  return { ...primary, id: item.id, name: item.name, driverClass: item.driverClass, libraries, classpathFingerprint: fingerprint };
}

function profile(item, legacy) {
  if (!validId(item?.id) || !validName(item.name)) return null;
  if (legacy) {
    const initial = version({ ...item, name: 'Initial driver', libraries: [] });
    return initial && { id: item.id, name: item.name, selectedVersion: initial.id, versions: [initial] };
  }
  if (!Array.isArray(item.versions) || !item.versions.length || item.versions.length > maxVersions) return null;
  const versions = item.versions.map(version);
  if (!versions.every(Boolean) || new Set(versions.map(entry => entry.id)).size !== versions.length ||
      !versions.some(entry => entry.id === item.selectedVersion)) return null;
  const result = { id: item.id, name: item.name, selectedVersion: item.selectedVersion, versions };
  if (item.postgresql !== undefined) {
    try { result.postgresql = postgresqlRoute(item.postgresql); }
    catch { return null; }
    if (versions.some(entry => entry.driverClass !== 'org.postgresql.Driver')) return null;
  }
  return result;
}

function selected(item) { return item.versions.find(entry => entry.id === item.selectedVersion); }
function view(item) { return structuredClone({ ...selected(item), ...item }); }

function createJdbcProfiles({ state, isTrusted, getJavaHome }) {
  const approvals = new Map();
  const captures = new Map();
  let active, operation, disposed = false;
  function trusted() {
    if (disposed || !isTrusted()) throw fail('Trust the workspace before using custom JDBC profiles.');
  }
  function profiles() {
    const saved = state.get(key);
    return [1, 2].includes(saved?.version) && Array.isArray(saved.profiles) && saved.profiles.length <= 20 ?
      saved.profiles.map(item => profile(item, saved.version === 1)).filter(Boolean) : [];
  }
  const persist = items => state.update(key, { version: 2, profiles: items });
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
    const saved = profiles().find(item => item.id === active.profile.id);
    if (!saved || saved.selectedVersion !== active.profile.selectedVersion || selected(saved).classpathFingerprint !== active.profile.classpathFingerprint ||
        JSON.stringify(saved.postgresql) !== JSON.stringify(active.profile.postgresql)) {
      active = undefined;
      captures.clear();
      throw fail('The approved JDBC version changed. Reopen the saved profile.');
    }
    return active;
  }
  function prepare(target, { name, jar, driverClass, libraries, postgresql }, signal) {
    return run(async cancellation => {
      if (!validName(name)) throw fail('Enter a JDBC profile or version name up to 80 characters.');
      const current = target && profiles().find(item => item.id === target);
      if (target && !current) throw fail('Select a current approved JDBC profile.');
      const route = target ? current.postgresql : postgresql === undefined ? undefined : postgresqlRoute(postgresql);
      if (route && driverClass !== 'org.postgresql.Driver') throw fail('Use the official PostgreSQL JDBC driver class for this profile.');
      const data = await examineJdbcDriver(jar, driverClass, cancellation, libraries);
      trusted();
      if (cancellation.aborted) throw fail('The JDBC operation was cancelled.');
      const id = randomUUID(), proposal = { id, name: name.trim(), ...data };
      for (const [saved, value] of approvals) if (value.expires <= Date.now()) approvals.delete(saved);
      while (approvals.size >= 8) approvals.delete(approvals.keys().next().value);
      approvals.set(id, { expires: Date.now() + approvalLifetime, target, proposal, route });
      return structuredClone({ ...proposal, ...(route && { postgresql: route }) });
    }, signal);
  }

  function approval(id, approved, versionOnly) {
    const value = approvals.get(id);
    if (approved !== true || !value || value.expires <= Date.now() || Boolean(value.target) !== versionOnly) {
      throw fail('Review this JDBC driver again and explicitly approve its exact JARs.');
    }
    return value;
  }

  return {
    list() { trusted(); return profiles().map(view); },
    prepare(draft, { signal } = {}) { return prepare(null, draft, signal); },
    prepareVersion(profileId, draft, { signal } = {}) {
      if (!validId(profileId)) return Promise.reject(fail('Select a current approved JDBC profile.'));
      return prepare(profileId, draft, signal);
    },
    save(id, approved) {
      return run(async () => {
        const { proposal, route } = approval(id, approved, false), catalog = profiles();
        if (catalog.length >= 20) throw fail('Remove a JDBC profile before adding another.');
        if (catalog.some(item => item.name.toLowerCase() === proposal.name.toLowerCase())) throw fail('Choose a unique JDBC profile name.');
        const item = { id: proposal.id, name: proposal.name, selectedVersion: proposal.id,
          versions: [{ ...proposal, name: 'Initial driver' }], ...(route && { postgresql: route }) };
        await persist([...catalog, item]);
        approvals.delete(id);
        return view(item);
      });
    },
    saveVersion(id, approved) {
      return run(async () => {
        const { target, proposal } = approval(id, approved, true), catalog = profiles();
        const item = catalog.find(entry => entry.id === target);
        if (!item || item.versions.length >= maxVersions) throw fail('Select an existing JDBC profile with room for another version.');
        if (item.versions.some(entry => entry.name.toLowerCase() === proposal.name.toLowerCase() ||
            entry.classpathFingerprint === proposal.classpathFingerprint)) throw fail('Choose a distinct JDBC version name and classpath.');
        item.versions.push(proposal);
        await persist(catalog);
        approvals.delete(id);
        return view(item);
      });
    },
    selectVersion(id, versionId) {
      return run(async () => {
        const catalog = profiles(), item = catalog.find(entry => entry.id === id);
        if (!item?.versions.some(entry => entry.id === versionId)) throw fail('Choose an approved JDBC driver version.');
        if (item.selectedVersion === versionId) return view(item);
        item.selectedVersion = versionId;
        await persist(catalog);
        if (active?.profile.id === id) active = undefined;
        if (!active) captures.clear();
        return view(item);
      });
    },
    removeVersion(id, versionId) {
      return run(async () => {
        const catalog = profiles(), item = catalog.find(entry => entry.id === id);
        if (!item?.versions.some(entry => entry.id === versionId) || item.selectedVersion === versionId) {
          throw fail('Select a different JDBC version before removing this approval.');
        }
        item.versions = item.versions.filter(entry => entry.id !== versionId);
        await persist(catalog);
        return view(item);
      });
    },
    remove(id) {
      return run(async () => {
        await persist(profiles().filter(item => item.id !== id));
        if (active?.profile.id === id) active = undefined;
        if (!active) captures.clear();
      });
    },
    open(id, input, { signal } = {}) {
      return run(async cancellation => {
        const item = profiles().find(candidate => candidate.id === id);
        if (!item) throw fail('Select a current approved JDBC profile.');
        const profile = view(item);
        const credential = credentials(profile.postgresql ? { ...input, url: postgresJdbcUrl(profile.postgresql) } : input);
        const catalog = await runJdbc({ javaHome: getJavaHome(), profile, credential, operation: 'catalog', signal: cancellation });
        trusted();
        if (cancellation.aborted) throw fail('The JDBC operation was cancelled.');
        active = { profile, credential, catalog };
        captures.clear();
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
    supportsPostgreSqlPlans() { return Boolean(isTrusted() && active?.profile.postgresql); },
    estimatePostgreSqlPlan(sql, { signal } = {}) {
      return run(async cancellation => {
        const connection = current(), { profile, credential } = connection;
        const plan = await runJdbc({ javaHome: getJavaHome(), profile, credential, operation: 'plan', sql, signal: cancellation });
        trusted();
        if (cancellation.aborted || current() !== connection) throw fail('The PostgreSQL plan capture was cancelled.');
        const capture = { ...plan, id: randomUUID(), capturedAt: new Date().toISOString() };
        if (captures.size >= 8) captures.delete(captures.keys().next().value);
        captures.set(capture.id, capture);
        return structuredClone(capture);
      }, signal);
    },
    postgreSqlPlanCaptures() {
      trusted();
      current();
      return [...captures.values()].map(({ id, canonicalSql, capturedAt, table }) => ({ id, canonicalSql, capturedAt, table }));
    },
    postgreSqlPlanCapture(id) {
      trusted();
      current();
      const capture = captures.get(id);
      if (!capture) throw fail('Choose a PostgreSQL estimate from the active connection.');
      return structuredClone(capture);
    },
    comparePostgreSqlPlans(left, right) {
      if (left === right) throw fail('Choose two different PostgreSQL estimates.');
      return comparePostgreSqlPlans(this.postgreSqlPlanCapture(left), this.postgreSqlPlanCapture(right));
    },
    close() { operation?.abort(); active = undefined; captures.clear(); },
    dispose() { this.close(); disposed = true; approvals.clear(); }
  };
}

module.exports = { createJdbcProfiles };
