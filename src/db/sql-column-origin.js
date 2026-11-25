'use strict';

const { analyzeSql, sourceTokens } = require('./sql-analysis');
const { endpointKey, maxSources, validName, readJoinCatalog } = require('./join-catalog');
const { loadSource } = require('./object-source');
const { storedViewSelect, ddlDefinitionLocation } = require('./sql-ddl-location');

const maxLayers = 6;
const maxEndpoints = 24;
const allowedReferences = new Set(['column', 'projection', 'projection-definition']);
const uncertainTraversal = new Set(['RECURSIVE', 'UNION', 'INTERSECT', 'EXCEPT', 'INTO']);
const unavailable = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_SQL_ORIGIN_UNAVAILABLE' });
const equalColumn = (left, right) => left.toLowerCase() === right.toLowerCase();
const member = name => ({ kind: 'column', name });

function selectTokens(text, options) {
  const tokens = sourceTokens(text, options);
  if (!['SELECT', 'WITH'].includes(tokens[0]?.upper) ||
      tokens.some(token => token.kind === 'word' && uncertainTraversal.has(token.upper))) {
    throw unavailable('Choose a column in a SELECT query with a unique, nonrecursive origin.');
  }
  return tokens;
}

function rootSelection(proof, token) {
  const refs = proof.references.filter(ref => ref.start === token.start && ref.end === token.end && allowedReferences.has(ref.kind));
  const origins = new Map();
  for (const ref of refs) {
    const origin = ref.joinOrigin || ref.physicalColumn;
    if (origin?.column) origins.set(JSON.stringify([origin.database, origin.table, origin.column]), origin);
  }
  if (origins.size !== 1) throw unavailable('This column has no unique pass-through database origin.');
  return origins.values().next().value;
}

function selectedProjection(proof, labels, column) {
  if (labels && labels.length !== proof.projections.length)
    throw unavailable('The view column list does not match its visible projections.');
  const matches = proof.projections.filter((projection, index) => equalColumn(labels?.[index] ?? projection.name, column));
  if (matches.length !== 1 || !matches[0].joinOrigin) throw unavailable('The view output is an expression or has no unique source column.');
  return matches[0].joinOrigin;
}

async function traceColumnOrigin(query, context, input, assertActive = () => {}) {
  assertActive();
  const { text, offset, catalog, options } = input;
  if (!Number.isInteger(offset) || offset < 0 || catalog?.database !== context.database || catalog.dialect !== context.dialect ||
      catalog.cachedMetadata || !catalog.semanticContextObserved) {
    throw unavailable('Refresh visible live SQL metadata before tracing a database column.');
  }
  const tokens = selectTokens(text, options);
  const target = tokens.find(token => ['word', 'identifier'].includes(token.kind) && token.start <= offset && offset < token.end);
  if (!target) throw unavailable('Place the cursor inside a bound column name.');

  const current = new Map(), sources = [];
  const caseSensitive = options.tableNameCaseSensitive !== false;
  const sameSchema = (a, b) => caseSensitive ? a === b : equalColumn(a, b);
  const modelOptions = (database, sqlMode) => ({ ...options, database, sqlMode, catalogComplete: true, joinOrigins: true });
  function inventory(database, tables) {
    return { database, tables: tables.filter(table => sameSchema(table.schema, database) && table.kind === 'table'),
      views: tables.filter(table => sameSchema(table.schema, database) && table.kind === 'view') };
  }
  async function bind(sql, database, sqlMode, kind) {
    const opts = { ...modelOptions(database, sqlMode), mysqlShowCreateView: kind === 'view' };
    const discovery = analyzeSql(sql, { database, tables: [], views: [] }, opts);
    const distinct = new Map(discovery.relations.filter(relation => relation.kind === 'catalog').map(relation => {
      const requested = relation.requested || { schema: database, table: relation.name };
      return [endpointKey(requested), requested];
    }));
    if (!distinct.size || distinct.size > maxSources || [...distinct.values()].some(({ schema, table }) => !validName(schema) || !validName(table))) {
      throw unavailable('Use a query with one to eight exact catalog sources.');
    }
    const missing = [...distinct].filter(([key]) => !current.has(key)).map(([, endpoint]) => endpoint);
    if (current.size + missing.length > maxEndpoints) throw unavailable('Too many objects are involved in this column origin.');
    if (missing.length) {
      const { tables } = await readJoinCatalog(query, database, { endpoints: missing, includeEdges: false });
      assertActive();
      for (const endpoint of missing) {
        const key = endpointKey(endpoint), visible = tables.find(table => endpointKey({ schema: table.schema, table: table.name }) === key);
        if (!visible) throw unavailable('Catalog metadata is unavailable for ' + endpoint.schema + '.' + endpoint.table + '.');
        current.set(key, visible);
      }
    }
    const tables = [...distinct.keys()].map(key => current.get(key));
    const observed = analyzeSql(sql, inventory(database, tables), { ...opts, joinTables: tables });
    if (observed.state !== 'known') throw unavailable('The visible SQL sources do not prove a complete column binding.');
    return observed;
  }
  async function assertCatalogUnchanged() {
    const entries = [...current];
    for (let start = 0; start < entries.length; start += maxSources) {
      const batch = entries.slice(start, start + maxSources);
      const endpoints = batch.map(([, table]) => ({ schema: table.schema, table: table.name }));
      const observed = await readJoinCatalog(query, context.database, { endpoints, includeEdges: false });
      assertActive();
      const latest = new Map(observed.tables.map(table => [endpointKey({ schema: table.schema, table: table.name }), table]));
      if (batch.some(([key, table]) => JSON.stringify(latest.get(key)) !== JSON.stringify(table))) {
        throw unavailable('Catalog columns changed while tracing the origin. Try again.');
      }
    }
  }

  const entered = await bind(text, context.database, options.sqlMode);
  let origin = rootSelection(entered, target);
  const seen = new Set(), chain = [];
  for (let index = 0; index < maxLayers; index++) {
    assertActive();
    const key = endpointKey({ schema: origin.database, table: origin.table });
    const object = current.get(key), column = object?.columns.find(value => value.name === origin.column);
    if (!object || !column || object.columns.filter(value => equalColumn(value.name, column.name)).length !== 1)
      throw unavailable('The exact origin column is no longer visible.');
    if (seen.has(key)) throw unavailable('A repeated view prevents a unique column origin.');
    seen.add(key);
    const identity = { kind: object.kind, schema: object.schema, name: object.name };
    const loaded = await loadSource(query, context, identity);
    assertActive();
    sources.push(loaded);
    chain.push({ object: identity, column: column.name, type: column.type, nullable: column.nullable });
    if (object.kind === 'table') {
      const anchor = ddlDefinitionLocation(loaded, member(column.name), options.sqlMode);
      if (!anchor) throw unavailable('The exact table column declaration is unavailable.');
      for (const earlier of sources) {
        const latest = await loadSource(query, context, earlier.object);
        assertActive();
        if (earlier.source !== latest.source || JSON.stringify(earlier.settings) !== JSON.stringify(latest.settings)) {
          throw unavailable('A database definition changed while tracing the column. Try again.');
        }
      }
      await assertCatalogUnchanged();
      return { loaded, anchor, chain, selected: target.value, selectedStart: target.start, selectedEnd: target.end,
        observedAt: new Date().toISOString(), executedSql: false };
    }
    const sqlMode = typeof loaded.settings.sql_mode === 'string' ? loaded.settings.sql_mode.split(',').filter(Boolean) : options.sqlMode;
    // MySQL omits the active metadata session's database from deparsed relation names.
    const viewDatabase = context.dialect === 'mysql' ? context.database : object.schema;
    const viewOptions = modelOptions(viewDatabase, sqlMode);
    const view = storedViewSelect(loaded, viewOptions);
    if (!view) throw unavailable('A visible view does not have a supported stored SELECT definition.');
    selectTokens(view.text, viewOptions);
    origin = selectedProjection(await bind(view.text, viewDatabase, sqlMode, 'view'), view.labels, column.name);
  }
  throw unavailable('The column passes through more than five views.');
}

function originExplanation(value) {
  if (!value?.chain?.length) return '';
  return ['Origin of ' + value.selected, ...value.chain.map(({ object, column, type, nullable }) =>
    object.kind + ' ' + [object.schema, object.name, column].join('.') + ' · ' + type + (nullable ? ' · nullable' : ' · NOT NULL')),
  'Observed ' + value.observedAt + ' from visible database definitions. No user SQL was executed.'].join('\n');
}

module.exports = { traceColumnOrigin, originExplanation };
