'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { examineJdbcDriver, runJdbc, credentials, classpathFingerprint, maxLibraries } = require('./jdbc');
const { postgresqlRoute, postgresJdbcUrl } = require('./postgresql-jdbc');
const { comparePostgreSqlPlans } = require('./postgresql-plan');
const { gridNames, gridCell } = require('./postgresql-grid');

const key = 'rocketbrain.jdbc.profiles.v1';
const approvalLifetime = 5 * 60 * 1000;
const gridLifetime = 5 * 60 * 1000;
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
  if (item.postgresqlGridEditing === true && result.postgresql) result.postgresqlGridEditing = true;
  return result;
}

function selected(item) { return item.versions.find(entry => entry.id === item.selectedVersion); }
function view(item) { return structuredClone({ ...selected(item), ...item }); }

function createJdbcProfiles({ state, isTrusted, getJavaHome }) {
  const approvals = new Map();
  const captures = new Map();
  const planReviews = new Map();
  const grids = new Map();
  const edits = new Map();
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
  function clearSessionWork() { captures.clear(); planReviews.clear(); grids.clear(); edits.clear(); }
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
        saved.postgresqlGridEditing !== active.profile.postgresqlGridEditing ||
        JSON.stringify(saved.postgresql) !== JSON.stringify(active.profile.postgresql)) {
      active = undefined;
      clearSessionWork();
      throw fail('The approved JDBC version changed. Reopen the saved profile.');
    }
    return active;
  }
  function prepare(target, { name, jar, driverClass, libraries, postgresql, postgresqlGridEditing }, signal) {
    return run(async cancellation => {
      if (!validName(name)) throw fail('Enter a JDBC profile or version name up to 80 characters.');
      const current = target && profiles().find(item => item.id === target);
      if (target && !current) throw fail('Select a current approved JDBC profile.');
      const route = target ? current.postgresql : postgresql === undefined ? undefined : postgresqlRoute(postgresql);
      if (route && driverClass !== 'org.postgresql.Driver') throw fail('Use the official PostgreSQL JDBC driver class for this profile.');
      const gridEditing = target ? current.postgresqlGridEditing === true : postgresqlGridEditing === true;
      if (gridEditing && !route) throw fail('Reviewed grid editing requires an explicitly approved PostgreSQL profile.');
      const data = await examineJdbcDriver(jar, driverClass, cancellation, libraries);
      trusted();
      if (cancellation.aborted) throw fail('The JDBC operation was cancelled.');
      const id = randomUUID(), proposal = { id, name: name.trim(), ...data };
      for (const [saved, value] of approvals) if (value.expires <= Date.now()) approvals.delete(saved);
      while (approvals.size >= 8) approvals.delete(approvals.keys().next().value);
      approvals.set(id, { expires: Date.now() + approvalLifetime, target, proposal, route, gridEditing });
      return structuredClone({ ...proposal, ...(route && { postgresql: route }), ...(gridEditing && { postgresqlGridEditing: true }) });
    }, signal);
  }

  function approval(id, approved, versionOnly) {
    const value = approvals.get(id);
    if (approved !== true || !value || value.expires <= Date.now() || Boolean(value.target) !== versionOnly) {
      throw fail('Review this JDBC driver again and explicitly approve its exact JARs.');
    }
    return value;
  }

  function retainPlan(plan) {
    const capture = { ...plan, id: randomUUID(), capturedAt: new Date().toISOString() };
    if (captures.size >= 8) captures.delete(captures.keys().next().value);
    captures.set(capture.id, capture);
    return capture;
  }

  async function capturePlan(connection, operation, sql, cancellation, planApproval) {
    const { profile, credential } = connection;
    const plan = await runJdbc({ javaHome: getJavaHome(), profile, credential, operation, sql, signal: cancellation, planApproval });
    trusted();
    if (cancellation.aborted || current() !== connection) throw fail('The PostgreSQL plan capture was cancelled.');
    return retainPlan(plan);
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
        const { proposal, route, gridEditing } = approval(id, approved, false), catalog = profiles();
        if (catalog.length >= 20) throw fail('Remove a JDBC profile before adding another.');
        if (catalog.some(item => item.name.toLowerCase() === proposal.name.toLowerCase())) throw fail('Choose a unique JDBC profile name.');
        const item = { id: proposal.id, name: proposal.name, selectedVersion: proposal.id,
          versions: [{ ...proposal, name: 'Initial driver' }], ...(route && { postgresql: route }),
          ...(gridEditing && { postgresqlGridEditing: true }) };
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
        if (!active) clearSessionWork();
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
        if (!active) clearSessionWork();
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
        clearSessionWork();
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
    supportsPostgreSqlMeasurements() {
      return Boolean(isTrusted() && active?.profile.postgresql && Number(/^\d+/u.exec(active.catalog.connection.version)?.[0]) >= 17);
    },
    estimatePostgreSqlPlan(sql, { signal } = {}) {
      return run(async cancellation => structuredClone(await capturePlan(current(), 'plan', sql, cancellation)), signal);
    },
    reviewPostgreSqlMeasurement(sql, { signal } = {}) {
      return run(async cancellation => {
        const connection = current();
        if (!this.supportsPostgreSqlMeasurements()) throw fail('Choose an approved PostgreSQL 17 or newer profile for measurement.');
        const estimate = await capturePlan(connection, 'plan-review', sql, cancellation);
        const review = { id: randomUUID(), expiresAt: Date.now() + 120000, estimate };
        while (planReviews.size >= 4) planReviews.delete(planReviews.keys().next().value);
        planReviews.set(review.id, { connection, sql, review });
        return structuredClone(review);
      }, signal);
    },
    discardPostgreSqlMeasurement(id) { planReviews.delete(id); },
    measurePostgreSqlPlan(id, approved, { signal } = {}) {
      return run(async cancellation => {
        const connection = current(), saved = planReviews.get(id);
        if (approved !== true || !saved || saved.connection !== connection || saved.review.expiresAt <= Date.now()) {
          throw fail('Review this exact PostgreSQL SELECT and explicitly approve its measurement.');
        }
        if (cancellation.aborted) throw fail('The PostgreSQL plan measurement was cancelled.');
        planReviews.delete(id);
        return structuredClone(await capturePlan(connection, 'plan-measure', saved.sql, cancellation, saved.review.estimate));
      }, signal);
    },
    postgreSqlPlanCaptures() {
      trusted();
      current();
      return [...captures.values()].map(({ id, canonicalSql, capturedAt, table, measured }) => ({ id, canonicalSql, capturedAt, table, measured }));
    },
    postgreSqlPlanCapture(id) {
      trusted();
      current();
      const capture = captures.get(id);
      if (!capture) throw fail('Choose a PostgreSQL plan from the active connection.');
      return structuredClone(capture);
    },
    comparePostgreSqlPlans(left, right) {
      if (left === right) throw fail('Choose two different PostgreSQL plans.');
      return comparePostgreSqlPlans(this.postgreSqlPlanCapture(left), this.postgreSqlPlanCapture(right));
    },
    supportsPostgreSqlGrid() { return Boolean(isTrusted() && active?.profile.postgresqlGridEditing); },
    previewPostgreSqlGrid(table, { signal } = {}) {
      return run(async cancellation => {
        const connection = current(), { profile, credential, catalog } = connection;
        gridNames(profile, table);
        if (!catalog.objects.some(item => item.schema === profile.postgresql.schema && item.name === table &&
            ['TABLE', 'BASE TABLE'].includes(item.kind))) throw fail('Choose an observed table from the approved PostgreSQL catalog.');
        const preview = await runJdbc({ javaHome: getJavaHome(), profile, credential, operation: 'grid-read', grid: { table }, signal: cancellation });
        trusted();
        if (cancellation.aborted || current() !== connection) throw fail('The PostgreSQL preview was cancelled.');
        const result = { ...preview, id: randomUUID(), table, database: profile.postgresql.database, schema: profile.postgresql.schema };
        if (grids.size >= 4) grids.delete(grids.keys().next().value);
        grids.set(result.id, { result, expires: Date.now() + gridLifetime });
        return structuredClone(result);
      }, signal);
    },
    preparePostgreSqlGridEdit(gridId, rowIndex, fieldIndex, value) {
      trusted();
      const connection = current(), { profile } = connection;
      const entry = grids.get(gridId);
      if (!entry || entry.expires <= Date.now()) throw fail('Reload the PostgreSQL grid before reviewing a cell change.');
      const grid = entry.result, row = grid.rows[rowIndex], column = grid.columns[fieldIndex];
      gridNames(profile, grid.table);
      if (!row || !column || fieldIndex === 0 || !Number.isInteger(rowIndex) || !Number.isInteger(fieldIndex)) {
        throw fail('Choose an observed non-key cell and reload the grid if needed.');
      }
      const original = gridCell(row.values[fieldIndex], column), replacement = gridCell(value, column);
      if (original === replacement) throw fail('Enter a changed PostgreSQL value.');
      const edit = { id: randomUUID(), gridId, table: grid.table, schema: grid.schema, database: grid.database, relation: grid.relation,
        rowVersion: row.version, identity: { column: grid.columns[0].name, type: grid.columns[0].type,
          number: grid.columns[0].number, value: row.values[0] },
        column, original, replacement };
      while (edits.size >= 8) edits.delete(edits.keys().next().value);
      edits.set(edit.id, { edit, expires: Date.now() + 120000 });
      return structuredClone(edit);
    },
    applyPostgreSqlGridEdit(id, approved, { signal } = {}) {
      let dispatched = false;
      return run(async cancellation => {
        const { profile, credential } = current(), record = edits.get(id);
        const preview = record && grids.get(record.edit.gridId);
        if (approved !== true || !preview || preview.expires <= Date.now() || record.expires <= Date.now()) {
          throw fail('Review this PostgreSQL cell edit again before applying it.');
        }
        gridNames(profile, record.edit.table);
        if (cancellation.aborted) throw fail('The PostgreSQL edit was cancelled.');
        edits.delete(id);
        grids.delete(record.edit.gridId);
        dispatched = true;
        return runJdbc({ javaHome: getJavaHome(), profile, credential, operation: 'grid-update', grid: record.edit, signal: cancellation });
      }, signal).catch(cause => {
        if (!dispatched || ['ROCKETBRAIN_JDBC_GRID_STALE', 'ROCKETBRAIN_JDBC_GRID_SCOPE', 'ROCKETBRAIN_JDBC_JAR'].includes(cause.code)) throw cause;
        throw fail(cause.message + ' Reload the row to confirm the result of this edit before submitting another.');
      });
    },
    close() { operation?.abort(); active = undefined; clearSessionWork(); },
    dispose() { this.close(); disposed = true; approvals.clear(); }
  };
}

module.exports = { createJdbcProfiles };
