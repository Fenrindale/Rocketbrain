'use strict';

const { createHash } = require('node:crypto');
const { identifier } = require('./schema-rename');
const { loadSource } = require('./object-source');
const { staticReferences, isApplicationSchema } = require('./view-impact');
const { sourceTokens, statementRanges } = require('./sql-analysis');

const maximumSchemas = 8;
const maximumProcedures = 64;
const maximumDefinitionBytes = 64 * 1024;
const maximumStatements = 32;
const maximumHits = 512;
const code = 'ROCKETBRAIN_CATALOG_USAGES';
const reject = message => Object.assign(Error(message), { code });
const word = token => token?.kind === 'word' ? token.upper : '';
const sqlIdentifier = token => token?.kind === 'identifier' || token?.kind === 'word';
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const contextSql = 'SELECT VERSION(), DATABASE(), CURRENT_USER(), CURRENT_ROLE(), @@lower_case_table_names';
const scoped = (column, schemas) => 'CAST(' + column + ' AS BINARY) IN (' + schemas.map(() => 'CAST(? AS BINARY)').join(',') + ')';
const binaryOrder = columns => columns.map(column => 'CAST(' + column + ' AS BINARY)').join(',');
const definitionErrors = new Map(['PERMISSION', 'UNAVAILABLE', 'DEFINITION', 'SIZE'].map((kind, index) =>
  ['ROCKETBRAIN_OBJECT_SOURCE_' + kind, ['definition-unavailable', 'definition-unavailable', 'definition-incomplete', 'definition-over-limit'][index]]));

function normalizeRequest(request) {
  const relation = request?.target;
  if (!relation || !['table', 'view'].includes(relation.kind) || !Array.isArray(request.schemas) ||
      request.schemas.length < 1 || request.schemas.length > maximumSchemas) throw reject('Choose a relation and one to eight application schemas.');
  const target = { schema: identifier(relation.schema, { table: true }), name: identifier(relation.name), kind: relation.kind };
  const schemas = request.schemas.map(name => identifier(name, { table: true })).sort();
  if (new Set(schemas).size !== schemas.length || !schemas.every(isApplicationSchema) || !schemas.includes(target.schema)) {
    throw reject('Include the exact target schema once and choose distinct application schemas.');
  }
  return { target, schemas };
}

function bodyOffset(tokens) {
  if (word(tokens[0]) !== 'CREATE') throw reject('The procedure header is unavailable.');
  const kind = tokens.findIndex(token => word(token) === 'PROCEDURE');
  if (kind < 1 || !sqlIdentifier(tokens[kind + 1])) throw reject('Unsupported procedure header.');
  let signature = kind + 2;
  if (tokens[signature]?.value === '.' && sqlIdentifier(tokens[signature + 1])) signature += 2;
  const opening = tokens[signature];
  if (opening?.value !== '(' || !Number.isInteger(opening.close)) throw reject('Unsupported procedure signature.');
  let index = opening.close + 1;
  const clauses = [
    ['LANGUAGE', 'SQL'], ['NOT', 'DETERMINISTIC'], ['DETERMINISTIC'], ['CONTAINS', 'SQL'], ['NO', 'SQL'],
    ['READS', 'SQL', 'DATA'], ['MODIFIES', 'SQL', 'DATA'], ['SQL', 'SECURITY', 'DEFINER'], ['SQL', 'SECURITY', 'INVOKER']
  ];
  for (let steps = 0; steps < 10; steps++) {
    if (['BEGIN', 'SELECT'].includes(word(tokens[index]))) return index;
    if (word(tokens[index]) === 'COMMENT' && tokens[index + 1]?.kind === 'string') { index += 2; continue; }
    const modifier = clauses.find(clause => clause.every((value, offset) => word(tokens[index + offset]) === value));
    if (!modifier) break;
    index += modifier.length;
  }
  throw reject('Only a direct SELECT or a flat block of SELECT statements is modeled.');
}

function procedureReferences(loaded) {
  const { source, object, settings } = loaded;
  if (typeof settings?.sql_mode !== 'string') throw reject('The stored SQL mode is unavailable.');
  const sqlMode = settings.sql_mode.split(',').filter(Boolean);
  if (sqlMode.some(mode => ['ORACLE','MSSQL','POSTGRESQL','DB2','MAXDB'].includes(mode))) {
    throw reject('The stored compatibility mode is outside the procedure usage subset.');
  }
  const options = { dialect: loaded.dialect, sqlMode };
  const tokens = sourceTokens(source, options);
  const head = bodyOffset(tokens);
  const trailing = tokens.at(-1)?.value === ';' ? tokens.length - 2 : tokens.length - 1;
  const block = word(tokens[head]) === 'BEGIN';
  if (block && word(tokens[trailing]) !== 'END') throw reject('The flat procedure block is incomplete.');
  const offset = block ? tokens[head].end : tokens[head].start;
  const end = block ? tokens[trailing].start : tokens[trailing].end;
  const body = source.slice(offset, end);
  const parsed = statementRanges(body, options);
  if (parsed.unknown.length || !parsed.statements.length || parsed.statements.length > maximumStatements ||
      !block && parsed.statements.length !== 1) throw reject('Unsupported procedure statement boundaries.');
  return parsed.statements.flatMap(part => {
    const sql = body.slice(part.start, part.end).trimEnd().replace(/;$/u, '');
    return staticReferences(sql, object.schema, settings.sql_mode, true).map(ref => ({
      schema: ref.schema, name: ref.table, start: offset + part.start + ref.start, end: offset + part.start + ref.end
    }));
  });
}

async function readMatchInventory(query, target, schemas) {
  const { rows: states } = await query(contextSql, []);
  const mode = Number(states[0]?.[4]);
  if (states.length !== 1 || states[0][4] == null || ![0,1,2].includes(mode) ||
      ![0,1,2].every(index => typeof states[0][index] === 'string' && states[0][index])) {
    throw reject('The account and identifier comparison could not be confirmed.');
  }
  const { rows: visibility } = await query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE ' +
    scoped('SCHEMA_NAME', schemas) + ' ORDER BY ' + binaryOrder(['SCHEMA_NAME']), schemas);
  if (visibility.length !== schemas.length || schemas.some(schema => !visibility.some(row => row[0] === schema))) {
    throw reject('A selected schema is missing or hidden from the current account.');
  }
  const { rows: matches } = await query('SELECT TABLE_TYPE FROM information_schema.TABLES WHERE ' +
    scoped('TABLE_SCHEMA', [target.schema]) + ' AND ' + scoped('TABLE_NAME', [target.name]) +
    " AND TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED','VIEW') LIMIT 2", [target.schema,target.name]);
  if (matches.length !== 1 || (matches[0][0] === 'VIEW' ? 'view' : 'table') !== target.kind) {
    throw reject('The exact target is missing, hidden or its object kind changed.');
  }
  const { rows: procedures, truncated } = await query('SELECT ROUTINE_SCHEMA,ROUTINE_NAME FROM information_schema.ROUTINES' +
    " WHERE ROUTINE_TYPE = 'PROCEDURE' AND " + scoped('ROUTINE_SCHEMA', schemas) + ' ORDER BY ' +
    binaryOrder(['ROUTINE_SCHEMA','ROUTINE_NAME']) + ' LIMIT ' + (maximumProcedures + 1), schemas);
  if (truncated || procedures.length > maximumProcedures) throw reject('The scope exceeds 64 visible standalone procedures.');
  return { state: states[0], mode, procedures };
}

async function observeRoutineUsages(query, context, request) {
  const deadline = Date.now() + 12000;
  const timedQuery = async (sql, parameters) => {
    if (Date.now() >= deadline) throw reject('The procedure scan exceeded 12 seconds. Select fewer schemas.');
    const result = await query(sql, parameters);
    if (Date.now() >= deadline) throw reject('The procedure scan exceeded 12 seconds. Select fewer schemas.');
    return result;
  };
  const { target, schemas } = normalizeRequest(request);
  const inventory = await readMatchInventory(timedQuery, target, schemas);
  const fold = name => inventory.mode && /^[\x20-\x7e]+$/u.test(name) ? name.toLowerCase() : name;
  const observations = [], opaque = [], hits = [];
  for (const [schema, name] of inventory.procedures) {
    const object = { schema, name, kind: 'procedure' };
    let loaded;
    try { loaded = await loadSource(timedQuery, context, object); }
    catch (error) {
      const reason = definitionErrors.get(error.code);
      if (!reason) throw error;
      opaque.push({ object, reason });
      continue;
    }
    const sourceSha256 = sha(loaded.source);
    observations.push({ object, sourceSha256, settings: loaded.settings });
    if (Buffer.byteLength(loaded.source) > maximumDefinitionBytes) {
      opaque.push({ object, reason: 'definition-over-limit' });
      continue;
    }
    let references;
    try { references = procedureReferences(loaded); }
    catch {
      opaque.push({ object, reason: 'unsupported-procedure-body' });
      continue;
    }
    for (const ref of references) {
      if (fold(ref.schema) !== fold(target.schema) || fold(ref.name) !== fold(target.name)) continue;
      if (hits.length === maximumHits) throw reject('The scope exposes more than 512 routine locations.');
      hits.push({ object, sourceSha256, settingsSha256: sha(loaded.settings), start: ref.start, end: ref.end });
    }
  }
  const checked = await readMatchInventory(timedQuery, target, schemas);
  if (sha(checked) !== sha(inventory)) throw reject('The account or object inventory changed during inspection.');
  return { target, schemas, hits, opaque, observedProcedures: inventory.procedures.length,
    coverage: 'account-visible standalone procedures in selected schemas',
    note: 'Definitions are observed separately. The catalog can hide procedures or source. Unsupported bodies may contain additional usages.',
    fingerprint: sha({ inventory, observations, opaque }), executedSql: false };
}

module.exports = { normalizeRequest, observeRoutineUsages, procedureReferences };
