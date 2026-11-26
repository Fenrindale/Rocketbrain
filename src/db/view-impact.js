'use strict';

const { createHash } = require('node:crypto');
const { identifier } = require('./schema-rename');
const { AST, parseView } = require('./schema-dependency-graph');

const limits = Object.freeze({ schemas: 8, relations: 256, views: 64, definitionBytes: 16 * 1024 });
const systemSchemas = new Set(['mysql', 'sys', 'information_schema', 'performance_schema']);
const contextSql = 'SELECT VERSION(), DATABASE(), CURRENT_USER(), CURRENT_ROLE(), @@lower_case_table_names, @@SESSION.sql_mode';
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_VIEW_IMPACT' });
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = relation => JSON.stringify([relation.schema, relation.name]);

function isApplicationSchema(name) {
  return !systemSchemas.has(name.toLowerCase());
}

function normalizeRequest(request) {
  if (!request?.target || !Array.isArray(request.schemas) || !request.schemas.length || request.schemas.length > limits.schemas) {
    throw fail('Choose a table or view and one to eight application schemas.');
  }
  const target = { schema: identifier(request.target.schema, { table: true }), name: identifier(request.target.name), kind: request.target.kind };
  const schemas = request.schemas.map(value => identifier(value, { table: true }));
  if (!['table', 'view'].includes(target.kind) || new Set(schemas).size !== schemas.length ||
      !schemas.every(isApplicationSchema) || !schemas.includes(target.schema)) {
    throw fail('Include the exact target schema once and select distinct application schemas.');
  }
  return { target, schemas: schemas.sort() };
}

async function readRows(query, sql, values, maximum) {
  const { rows, truncated } = await query(sql, values);
  if (!Array.isArray(rows) || truncated || rows.length > maximum) {
    throw fail('The view impact metadata exceeds its bound. Select fewer or smaller schemas.');
  }
  return rows;
}

async function snapshot(query, schemas) {
  const contexts = await readRows(query, contextSql, [], 1);
  const [version, database, account, role, caseMode, sqlMode] = contexts[0] || [];
  if (contexts.length !== 1 || ![version, database, account, sqlMode].every(value => typeof value === 'string') ||
      ![0, 1, 2].includes(Number(caseMode)) || caseMode === null || role !== null && typeof role !== 'string') {
    throw fail('Could not verify the connected database account and identifier rules.');
  }

  const inScope = column => 'CAST(' + column + ' AS BINARY) IN (' + schemas.map(() => 'CAST(? AS BINARY)').join(',') + ')';
  const order = columns => columns.map(column => 'CAST(' + column + ' AS BINARY)').join(',');
  const visible = await readRows(query, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE ' + inScope('SCHEMA_NAME') +
    ' ORDER BY ' + order(['SCHEMA_NAME']), schemas, limits.schemas);
  if (visible.length !== schemas.length || schemas.some(name => !visible.some(row => row[0] === name))) {
    throw fail('A selected schema is missing or not visible to the current account.');
  }

  const relations = await readRows(query, 'SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE ' +
    inScope('TABLE_SCHEMA') + " AND TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED','VIEW')" +
    ' ORDER BY ' + order(['TABLE_SCHEMA', 'TABLE_NAME']) + ' LIMIT ' + (limits.relations + 1), schemas, limits.relations);
  if (relations.filter(row => row[2] === 'VIEW').length > limits.views) {
    throw fail('The selected schemas expose more than ' + limits.views + ' views. Select fewer schemas.');
  }

  const definitions = await readRows(query, 'SELECT TABLE_SCHEMA,TABLE_NAME,OCTET_LENGTH(VIEW_DEFINITION),' +
    'CASE WHEN OCTET_LENGTH(VIEW_DEFINITION) <= ' + limits.definitionBytes + ' THEN VIEW_DEFINITION ELSE NULL END' +
    ' FROM information_schema.VIEWS WHERE ' + inScope('TABLE_SCHEMA') +
    ' ORDER BY ' + order(['TABLE_SCHEMA', 'TABLE_NAME']) + ' LIMIT ' + (limits.views + 1), schemas, limits.views);
  return { context: { version, database, account, role, lowerCaseTableNames: Number(caseMode), sqlMode }, relations, definitions };
}

function staticReferences(definition, schema, sqlMode, creationModeObserved = false) {
  // The creation SQL mode is unavailable for views in this catalog.
  if (!creationModeObserved && definition.includes('\\')) throw fail('Backslash escapes need the view creation SQL mode.');
  // Grouped comma joins may hide a relation in a nested parenthesis. Keep them opaque.
  const tokens = AST.lex(definition, { sqlMode });
  const word = token => token.kind === 'word' ? token.value.toUpperCase() : '';
  if (tokens.filter(token => word(token) === 'SELECT').length !== 1) {
    throw fail('Nested SELECT scopes are outside the observed relation subset.');
  }
  const from = tokens.findIndex(token => word(token) === 'FROM');
  const where = tokens.findIndex((token, index) => index > from && ['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT'].includes(word(token)));
  if (from >= 0 && tokens.slice(from + 1, where < 0 ? undefined : where).some(token => token.value === ',')) {
    throw fail('Comma-separated FROM clauses are outside the observed view subset.');
  }
  return parseView(definition, schema, { sqlMode }).refs;
}

function buildGraph(targetRequest, schemas, observed, fingerprint) {
  const { context, relations, definitions } = observed;
  const exact = new Map(), folded = new Map(), sources = new Map();
  const fold = value => context.lowerCaseTableNames && /^[\x20-\x7e]+$/u.test(value) ? value.toLowerCase() : value;
  const resolutionKey = relation => key({ schema: fold(relation.schema), name: fold(relation.name) });
  const scope = new Set(schemas.map(fold));
  for (const [schema, name, type] of relations) {
    const relation = { schema, name, kind: type === 'VIEW' ? 'view' : 'table' };
    const exactKey = key(relation), matchingKey = resolutionKey(relation);
    if (exact.has(exactKey)) throw fail('The catalog returned duplicate relation identities.');
    exact.set(exactKey, relation);
    folded.set(matchingKey, folded.has(matchingKey) ? null : relation);
  }
  for (const [schema, name, bytes, sql] of definitions) {
    const entry = key({ schema, name });
    if (sources.has(entry) || exact.get(entry)?.kind !== 'view') {
      throw fail('The relation list and view definitions disagree. Refresh the catalog and try again.');
    }
    sources.set(entry, { bytes, sql });
  }

  const target = exact.get(key(targetRequest));
  if (target?.kind !== targetRequest.kind) {
    throw fail('The selected target is missing, hidden or no longer the selected object kind.');
  }
  const incoming = new Map();
  const edges = [], opaqueViews = [], unresolvedReferences = [];
  for (const [viewKey, relation] of exact) {
    if (relation.kind !== 'view') continue;
    const source = sources.get(viewKey);
    if (source?.bytes > limits.definitionBytes) {
      opaqueViews.push({ relation, reason: 'definition-over-limit' });
      continue;
    }
    if (!source?.sql) {
      opaqueViews.push({ relation, reason: 'definition-unavailable' });
      continue;
    }
    let references;
    try { references = staticReferences(source.sql, relation.schema, context.sqlMode); }
    catch {
      opaqueViews.push({ relation, reason: 'unsupported-view-definition' });
      continue;
    }
    const seen = new Set();
    for (const reference of references) {
      const name = { schema: reference.schema, name: reference.table };
      const linkKey = resolutionKey(name);
      if (seen.has(linkKey)) continue;
      seen.add(linkKey);
      const dependency = folded.get(linkKey);
      if (!dependency) {
        const reason = !scope.has(fold(name.schema)) ? 'outside-selected-schemas' :
          folded.has(linkKey) ? 'ambiguous-catalog-name' : 'relation-unavailable';
        unresolvedReferences.push({ view: relation, relation: name, reason });
        continue;
      }
      const dependents = incoming.get(key(dependency)) || [];
      dependents.push(relation);
      incoming.set(key(dependency), dependents);
      edges.push({ view: relation, dependsOn: dependency });
    }
  }

  const visited = new Set([key(target)]), queue = [{ relation: target, depth: 0, path: [target] }];
  for (const current of queue) {
    for (const dependent of incoming.get(key(current.relation)) || []) {
      const dependentKey = key(dependent);
      if (visited.has(dependentKey)) continue;
      visited.add(dependentKey);
      queue.push({ relation: dependent, depth: current.depth + 1, path: [...current.path, dependent] });
    }
  }
  return {
    target, schemas, coverage: 'account-visible selected application schemas', readOnly: true, fingerprint,
    scopeNote: 'A repeated metadata observation. Hidden relations and opaque views can leave dependencies undiscovered.',
    lowerCaseTableNames: context.lowerCaseTableNames,
    observedRelations: exact.size, observedViews: [...exact.values()].filter(relation => relation.kind === 'view').length,
    impacted: queue.slice(1),
    edges: edges.filter(edge => visited.has(key(edge.view)) && visited.has(key(edge.dependsOn))),
    opaqueViews, unresolvedReferences
  };
}

async function observeViewImpact(query, request) {
  const { target, schemas } = normalizeRequest(request);
  const first = await snapshot(query, schemas), fingerprint = sha256(first);
  if (fingerprint !== sha256(await snapshot(query, schemas))) {
    throw fail('Visible definitions or connection metadata changed during analysis. Inspect again.');
  }
  return buildGraph(target, schemas, first, fingerprint);
}

module.exports = { isApplicationSchema, limits, observeViewImpact, staticReferences };
