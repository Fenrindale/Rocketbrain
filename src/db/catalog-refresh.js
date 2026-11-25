'use strict';

const { createHash } = require('node:crypto');
const { readMetadata, attachCheckMetadata } = require('./metadata');
const { identifier, stableCreate } = require('./schema-rename');

const limits = { objects: 120, selected: 12, definitionBytes: 1024 * 1024, mergedBytes: 32 * 1024 * 1024, timeMs: 30000 };
const objectAreas = ['tables', 'columns', 'indexes', 'foreignKeys', 'checks'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const quote = name => '`' + name.replaceAll('`', '``') + '`';
const exact = column => 'CAST(' + column + ' AS BINARY)=CAST(? AS BINARY)';
const sortNames = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function runCatalogOperation(state, action, { needsMysql, trusted, busy, assertReady, updateStatus }) {
  const key = 'metadata-refresh';
  if (state.running.has(key)) throw Error('Another metadata refresh or capture is running.');
  if (needsMysql) assertReady();
  else if (state.disposed || state.switching || busy() || state.mysql && !trusted()) {
    throw Error('Finish the current database operation in a trusted workspace before refreshing metadata.');
  }
  const { db, epoch, mysql, tableLayoutConnection: id, metadata: before } = state;
  const current = () => state.db === db && state.epoch === epoch && !state.disposed && !state.switching &&
    (!mysql || trusted());
  const assertCurrent = () => {
    if (!current() || state.metadata !== before) throw Error('The live catalog changed during refresh. Try again.');
  };
  state.running.add(key);
  updateStatus();
  try { return await action({ db, epoch, mysql, id, before, current, assertCurrent }); }
  finally { state.running.delete(key); updateStatus(); }
}

function objectFilter(column, names) {
  return names ? ' AND (' + names.map(() => exact(column)).join(' OR ') + ')' : '';
}

function selectedNames(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > limits.selected || new Set(value).size !== value.length) {
    throw Error('Choose one to twelve different visible tables or views.');
  }
  return value.map(name => identifier(name, { table: true }));
}

async function identity(query) {
  const { rows } = await query('SELECT VERSION(), DATABASE(), @@SESSION.sql_mode, @@lower_case_table_names, CURRENT_USER()', []);
  const [[version, schema, mode, fold, account] = []] = rows;
  if (rows.length !== 1 || typeof version !== 'string' || typeof schema !== 'string' ||
      typeof mode !== 'string' || typeof account !== 'string' || ![0, 1, 2].includes(Number(fold))) {
    throw Error('The live metadata identity could not be checked.');
  }
  return { version, schema, mode, tableNameCaseSensitive: Number(fold) === 0, account,
    dialect: /MariaDB/i.test(version) ? 'mariadb' : 'mysql' };
}

async function inventory(query, schema, names) {
  const { rows } = await query('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE ' + exact('TABLE_SCHEMA') +
    objectFilter('TABLE_NAME', names) + ' ORDER BY CAST(TABLE_NAME AS BINARY) LIMIT ' + (limits.objects + 1), [schema, ...(names ?? [])]);
  if (rows.length > limits.objects) throw Error('The schema has more than 120 visible objects. Refresh the full schema or select objects.');
  const observed = rows.map(([name, type]) => ({ name: identifier(name, { table: true }),
    kind: type === 'VIEW' ? 'view' : ['BASE TABLE', 'SYSTEM VERSIONED'].includes(type) ? 'table' : 'unknown' }));
  if (new Set(observed.map(row => row.name)).size !== observed.length) throw Error('The database returned ambiguous object identities.');
  return observed;
}

async function observePrograms(query, schema, names, assertCurrent) {
  const result = {};
  try {
    const { rows } = await query('SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ' +
      'SHA2(JSON_ARRAY(ACTION_STATEMENT, SQL_MODE, DEFINER, ACTION_ORDER),256) FROM information_schema.TRIGGERS ' +
      'WHERE ' + exact('TRIGGER_SCHEMA') + objectFilter('EVENT_OBJECT_TABLE', names) + ' ORDER BY CAST(TRIGGER_NAME AS BINARY)',
    [schema, ...(names ?? [])]);
    result.triggerRows = rows;
  } catch { assertCurrent(); result.triggerError = true; }
  if (!names) try {
    const { rows } = await query('SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, IS_DETERMINISTIC, SQL_DATA_ACCESS, SECURITY_TYPE, ' +
      'ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ' + exact('ROUTINE_SCHEMA') + ' ORDER BY CAST(ROUTINE_NAME AS BINARY), ROUTINE_TYPE', [schema]);
    result.routines = rows.map(([name, type, returnType, deterministic, dataAccess, security, comment]) => ({
      name, type, returnType, deterministic: deterministic === 'YES', dataAccess, security, comment
    }));
  } catch { assertCurrent(); result.routineError = true; }
  return result;
}

async function signature(query, schema, object, triggerRows, assertCurrent) {
  try {
    const result = await query('SHOW CREATE ' + (object.kind === 'view' ? 'VIEW ' : 'TABLE ') +
      quote(schema) + '.' + quote(object.name), []);
    const [[observedName, source] = []] = result.rows;
    if (result.rows.length !== 1 || observedName !== object.name || typeof source !== 'string' || !/^\s*CREATE\s/i.test(source) ||
        Buffer.byteLength(source) > limits.definitionBytes) return undefined;
    return digest([object.kind, object.kind === 'view' ? source : stableCreate(source, { omitCounter: true }),
      (triggerRows ?? []).filter(row => row[1] === object.name)]);
  } catch { assertCurrent(); return undefined; }
}

async function readObject(query, schema, expected, context, revision) {
  const scoped = await readMetadata(query, schema, revision, expected.name, { exactScope: true });
  scoped.dialect = context.dialect;
  await attachCheckMetadata(query, scoped, expected.name);
  const objects = [...scoped.tables, ...scoped.views];
  if (objects.length !== 1 || objects[0].name !== expected.name || objects[0].kind !== expected.kind ||
      !objects[0].columns.length || !objectAreas.every(area => scoped.coverage[area] === 'loaded')) {
    throw Error('The exact object, columns and constraints could not be read.');
  }
  return objects[0];
}

function applyProgramResult(before, coverage, observed, names) {
  let triggers = before.triggers;
  if (observed.triggerError) coverage.triggers = 'unavailable';
  else {
    const live = observed.triggerRows.map(([name, table, timing, event]) => ({ name, table, timing, event }));
    triggers = names ? [...before.triggers.filter(item => !names.includes(item.table)), ...live].sort(sortNames) : live;
    if (!names) coverage.triggers = 'loaded';
  }
  if (!names) coverage.routines = observed.routineError ? 'unavailable' : 'loaded';
  return { triggers, routines: observed.routines ?? before.routines };
}

async function readCatalogRefresh(query, schema, request, revision) {
  const { before, fingerprints = new Map(), assertCurrent = () => {} } = request;
  const names = selectedNames(request.names);
  if (before?.database !== schema || before.scope !== 'database') throw Error('Refresh the full live catalog first.');
  const deadline = Date.now() + limits.timeMs;
  const check = () => {
    assertCurrent();
    if (Date.now() >= deadline) throw Error('The metadata refresh exceeded its time budget. Select fewer objects and try again.');
  };
  const checkQuery = async (sql, values) => {
    check();
    const result = await query(sql, values);
    check();
    return result;
  };
  const start = await identity(checkQuery);
  if (start.schema !== schema || start.dialect !== before.dialect || start.version !== before.serverVersion ||
      start.tableNameCaseSensitive !== before.tableNameCaseSensitive || !equal(start.mode.split(',').filter(Boolean), before.sqlMode)) {
    throw Error('The server SQL mode or identifier rules changed. Refresh the full live catalog.');
  }
  const observed = await inventory(checkQuery, schema, names);
  const programs = await observePrograms(checkQuery, schema, names, check);
  const present = new Map(observed.map(item => [item.name, item]));
  const objects = new Map([...before.tables, ...before.views].map(item => [item.name, item]));
  const stale = new Map((before.refresh?.staleObjects ?? []).map(item => [item.name, item]));
  const nextFingerprints = new Map(fingerprints);
  const processed = [];
  const report = { mode: names ? 'object' : 'incremental', database: schema, revision,
    checked: observed.length, refreshed: [], unchanged: [], removedFromView: [], notVisible: [], failed: [], definitionsUnavailable: [],
    triggerMetadataAvailable: !programs.triggerError, routineMetadataAvailable: names ? undefined : !programs.routineError };

  for (const name of names ?? [...objects.keys()]) {
    if (!present.has(name)) {
      if (objects.has(name)) {
        report.removedFromView.push(name);
        processed.push({ name, object: null });
      } else report.notVisible.push(name);
      objects.delete(name);
      stale.delete(name);
      nextFingerprints.delete(name);
    }
  }
  for (const expected of observed) {
    const name = expected.name;
    if (expected.kind === 'unknown') {
      report.failed.push({ name, reason: 'Object type is outside the table and view refresh scope.' });
      nextFingerprints.delete(name);
      continue;
    }
    const beforeShape = await signature(checkQuery, schema, expected, programs.triggerRows, check);
    if (!beforeShape) report.definitionsUnavailable.push(name);
    if (!names && beforeShape && !programs.triggerError && !stale.has(name) && objects.has(name) && fingerprints.get(name) === beforeShape) {
      report.unchanged.push(name);
      continue;
    }
    try {
      const object = await readObject(checkQuery, schema, expected, start, revision);
      const afterShape = await signature(checkQuery, schema, expected, programs.triggerRows, check);
      if (beforeShape !== afterShape || !beforeShape && !equal(object, await readObject(checkQuery, schema, expected, start, revision))) {
        throw Error('The object changed during inspection.');
      }
      const previous = objects.get(name);
      objects.set(name, previous && equal(previous, object) ? previous : object);
      if (afterShape && !programs.triggerError) nextFingerprints.set(name, afterShape);
      else nextFingerprints.delete(name);
      stale.delete(name);
      processed.push({ name, object });
      report.refreshed.push(name);
    } catch {
      check();
      const issue = { name, reason: 'Object metadata was unavailable or changed during inspection. Last known values were retained.' };
      stale.set(name, issue);
      nextFingerprints.delete(name);
      report.failed.push(issue);
    }
  }
  if (!equal(observed, await inventory(checkQuery, schema, names)) ||
      !equal(programs, await observePrograms(checkQuery, schema, names, check)) ||
      !equal(start, await identity(checkQuery))) {
    throw Error('The visible object set or metadata connection changed during refresh. Try again.');
  }
  check();

  const stableCoverage = { ...(before.refresh?.stableCoverage ?? before.coverage) };
  if (!names && !report.failed.length) for (const area of objectAreas) stableCoverage[area] = 'loaded';
  const programsAfter = applyProgramResult(before, stableCoverage, programs, names);
  const coverage = { ...stableCoverage };
  if (stale.size) for (const area of objectAreas) coverage[area] = 'unavailable';
  const sorted = [...objects.values()].sort(sortNames);
  const catalog = { ...before, ...programsAfter, revision, tables: sorted.filter(item => item.kind !== 'view'),
    views: sorted.filter(item => item.kind === 'view'), coverage, complete: Object.values(coverage).every(status => status === 'loaded'),
    warnings: before.warnings.filter(warning => coverage[warning.area] !== 'loaded'),
    refresh: { mode: report.mode, checkedAt: new Date().toISOString(), staleObjects: [...stale.values()], stableCoverage } };
  if (Buffer.byteLength(JSON.stringify(catalog)) > limits.mergedBytes) {
    throw Error('The refreshed catalog exceeds its 32 MiB limit.');
  }
  return { catalog, report, fingerprints: nextFingerprints, processed };
}

module.exports = { runCatalogOperation, readCatalogRefresh, selectedNames, limits };
