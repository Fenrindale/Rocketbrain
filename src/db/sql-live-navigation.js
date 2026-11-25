'use strict';

const { analyzeSql, sourceTokens } = require('./sql-analysis');
const { endpointKey, maxSources, validName } = require('./join-catalog');

const nameToken = token => token?.kind === 'word' || token?.kind === 'identifier';
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const nameEqual = (left, right, insensitive) => insensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
const visibleCatalog = catalog => validName(catalog?.database) &&
  ['tables', 'columns'].every(area => catalog.coverage?.[area] === 'loaded');
const currentToken = (token, offset) => token.start <= offset && offset <= token.end;
const identityOf = object => JSON.stringify([object.schema, object.kind, object.name]);

function routineTarget(reference, catalog, insensitive) {
  if (![reference.schema, reference.name].every(validName)) return undefined;
  const local = nameEqual(reference.schema, catalog.database, insensitive);
  if (!local) return { object: reference, observed: false };
  if (catalog.coverage?.routines !== 'loaded') return undefined;
  const routines = (catalog.routines || []).filter(routine => String(routine.type).toLowerCase() === reference.kind &&
    routine.name.toLowerCase() === reference.name.toLowerCase());
  if (routines.length !== 1) return undefined;
  const routine = routines[0];
  return { object: { schema: catalog.database, kind: reference.kind, name: routine.name }, observed: true,
    ...(routine.returnType && { type: routine.returnType }) };
}

function callTarget(tokens, offset, catalog, insensitive) {
  const relation = tokens[1];
  if (!nameToken(relation)) return undefined;
  let name = relation, schema = catalog.database, tail = 2;
  if (tokens[2]?.kind === 'symbol' && tokens[2].value === '.') {
    if (!nameToken(tokens[3])) return undefined;
    schema = relation.value;
    name = tokens[3];
    tail = 4;
  }
  const end = tokens.at(-1)?.value === ';' && tokens.at(-1)?.kind === 'symbol' ? tokens.length - 1 : tokens.length;
  if (tail !== end && (tokens[tail]?.value !== '(' || tokens[tail].close !== end - 1)) return undefined;
  return currentToken(name, offset) ? routineTarget({ schema, name: name.value, kind: 'procedure' }, catalog, insensitive) : undefined;
}

function tableTarget(origin, catalog, remote) {
  if (![origin.database, origin.table].every(validName)) return undefined;
  const local = origin.database === catalog.database;
  const tables = local ? [...(catalog.tables || []), ...(catalog.views || [])] : remote.filter(table => table.schema === origin.database);
  const matches = tables.filter(table => table.name === origin.table && ['table', 'view'].includes(table.kind));
  if (matches.length !== 1) return undefined;
  const table = matches[0], object = { schema: origin.database, kind: table.kind, name: table.name };
  if (origin.column === undefined) return { object, observed: true };
  const columns = (table.columns || []).filter(column => column.name === origin.column);
  if (!validName(origin.column) || columns.length !== 1) return undefined;
  const { name, type, nullable } = columns[0];
  return { object, member: { name, kind: 'column' }, observed: true, type, nullable };
}

function plannedEndpoints(references, relation, catalog, insensitive) {
  const requested = references.flatMap(reference => reference.endpoints || []);
  if (relation?.requested && !relation.catalog) requested.push(relation.requested);
  const foreign = requested.filter(endpoint => validName(endpoint.schema) && validName(endpoint.table) &&
    !nameEqual(endpoint.schema, catalog.database, insensitive));
  const endpoints = [...new Map(foreign.map(endpoint => [endpointKey(endpoint), endpoint])).values()];
  return endpoints.length && endpoints.length <= maxSources ? { endpoints } : undefined;
}

function liveNavigation(text, offset, catalog, options = {}, remote = []) {
  if (!visibleCatalog(catalog) || !Number.isInteger(offset)) return undefined;
  let tokens;
  try { tokens = sourceTokens(text, options); }
  catch { return undefined; }
  if (word(tokens[0], 'CALL')) return callTarget(tokens, offset, catalog, options.tableNameCaseSensitive === false);
  const dml = require('./sql-dml-usages').analyzeDmlUsage(text,catalog,options,remote,tokens);
  if (dml) {
    if (dml.pending && dml.possibleTokens.some(token=>currentToken(token,offset))) return {endpoints:dml.pending};
    if (dml.state !== 'known') return undefined;
    const ref = dml.references.find(item=>currentToken(item,offset));
    if (ref?.definition) return {local:ref.definition};
    const origin = ref?.physicalColumn || ref?.catalog || ref?.physicalTable;
    const target = origin && tableTarget(origin,catalog,remote);
    return target && {...target,usage:ref.usage,command:ref.command};
  }
  if (!word(tokens[0], 'SELECT') && !word(tokens[0], 'WITH')) return undefined;
  const current = tokens.find(token => token.start <= offset && offset < token.end);
  const exactToken = !current || current.kind === 'symbol' ?
    tokens.find(token => nameToken(token) && token.end === offset) : current;
  if (!nameToken(exactToken)) return undefined;
  const model = analyzeSql(text, catalog, { ...options, catalogComplete: true, joinOrigins: true, sourceNavigation: true, joinTables: remote });
  if (model.state === 'invalid') return undefined;
  const references = model.references.filter(reference => reference.start === exactToken.start && reference.end === exactToken.end);
  if (references.some(reference => reference.definition)) return undefined;
  const rootRef = references.find(reference => reference.kind === 'table' || reference.kind === 'relation');
  const relation = model.relations.find(relation => relation.id === rootRef?.relationId);
  if (references.some(reference => model.scopes.some(scope => scope.id === (reference.scopeId || relation?.scopeId) && scope.partial))) return undefined;
  const routine = references.find(reference => reference.physicalRoutine)?.physicalRoutine;
  if (routine) return routineTarget(routine, catalog, options.tableNameCaseSensitive === false);

  const column = references.find(reference => reference.kind === 'column' && reference.physicalColumn);
  const origin = column?.physicalColumn || rootRef?.physicalTable || (rootRef?.kind === 'table' && rootRef.catalog);
  if (origin) return tableTarget(origin, catalog, remote);
  return plannedEndpoints(references, relation, catalog, options.tableNameCaseSensitive === false);
}

function quickInfo(target, available = false) {
  if (!target?.object || !target.observed && !available) return undefined;
  const { object, member, type, nullable } = target;
  const kind = member ? object.kind + ' column' : ['function', 'procedure'].includes(object.kind) ? 'stored ' + object.kind : object.kind;
  const qualified = [object.schema, object.name, ...(member ? [member.name] : [])].join('.');
  const operation = target.usage ? target.command + ' ' + (target.usage === 'write' ? 'write target' : 'read reference') + ' · ' : '';
  const summary = operation + kind + ' ' + qualified + (type ? ' · ' + type : '') +
    (typeof nullable === 'boolean' ? nullable ? ' · nullable' : ' · NOT NULL' : '');
  return summary + '\n' + (available ? 'DDL was read from the current account. Go to Definition refreshes the source.' :
    'Go to Definition reads server DDL when visible to the current account.');
}

module.exports = { liveNavigation, quickInfo, identityOf };
