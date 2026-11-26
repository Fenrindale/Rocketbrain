'use strict';

const { createHash } = require('node:crypto');
const { normalizeLocalChatTarget, requestLocalChat } = require('../ai/local-chat');
const { projectSchema } = require('./local-sql-assistant');

const identifier = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;
const maximumTables = 4;
const maximumColumns = 24;
const aggregateNames = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];
const numeric = /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)(?:\W|$)/i;
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const quoted = value => '`' + value + '`';
const ordinary = table => table.kind === 'table' && /^innodb$/i.test(table.engine) && identifier.test(table.name);

function bad(message) {
  return Object.assign(Error(message), { code: 'ROCKETBRAIN_LOCAL_SQL_GROUNDING' });
}

function relationshipOptions(catalog) {
  if (catalog?.coverage?.foreignKeys !== 'loaded' || !catalog.semanticContextObserved ||
      !['mysql', 'mariadb'].includes(catalog.dialect) || !identifier.test(catalog.database)) {
    throw bad('Load the live MySQL or MariaDB foreign-key catalog before building a grounded query.');
  }
  const tables = new Map(catalog.tables.filter(ordinary).map(table => [table.name, table]));
  const edges = [];
  for (const table of tables.values()) {
    for (const key of table.foreignKeys) {
      const parent = tables.get(key.referencedTable);
      if (!parent || parent === table || key.referencedSchema !== catalog.database || !key.columns.length || key.columns.length > 8) continue;
      const columns = [...key.columns].sort((a, b) => a.ordinal - b.ordinal);
      if (columns.some((column, index) => column.ordinal !== index + 1 || !allowedColumn(table, column.name) ||
          !allowedColumn(parent, column.referencedColumn))) continue;
      const edge = { name: key.name, table: table.name, parent: parent.name,
        pairs: columns.map(column => [column.name, column.referencedColumn]) };
      edges.push({ id: hash(edge), ...edge });
    }
  }
  return edges;
}

function allowedColumn(table, name) {
  return identifier.test(name) && table.columns.find(column => column.name === name && !/\b(?:VIRTUAL|STORED|PERSISTENT)\b/i.test(column.extra || ''));
}

function projectGrounding(catalog, { root, edgeIds, selections } = {}) {
  const edges = relationshipOptions(catalog);
  const tables = new Map(catalog.tables.filter(ordinary).map(table => [table.name, table]));
  if (!tables.has(root) || !Array.isArray(edgeIds) || !edgeIds.length || edgeIds.length >= maximumTables ||
      new Set(edgeIds).size !== edgeIds.length) {
    throw bad('Choose two to four distinct InnoDB tables linked by observed foreign keys.');
  }
  const names = new Set([root]);
  const route = edgeIds.map(id => {
    const edge = edges.find(item => item.id === id);
    if (!edge || names.has(edge.table) === names.has(edge.parent)) throw bad('Choose a connected route where each reviewed key adds one table.');
    const enters = names.has(edge.table) ? edge.parent : edge.table;
    names.add(enters);
    return { ...edge, enters };
  });
  if (!Array.isArray(selections) || selections.length !== names.size || selections.some(selection => !names.has(selection.table))) {
    throw bad('Choose readable output columns for each table on the selected route.');
  }
  // Include the explicitly selected join pairs even when a key is not an output-column choice.
  const projected = selections.map(({ table, columns }) => {
    const original = tables.get(table);
    if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length ||
        columns.some(name => !allowedColumn(original, name))) throw bad('Choose distinct observed ordinary columns from each selected table.');
    const keys = route.flatMap(edge => edge.pairs.flatMap(([child, parent]) => edge.table === table ? [child] : edge.parent === table ? [parent] : []));
    return { table, columns: [...new Set([...columns, ...keys])] };
  });
  if (projected.reduce((total, item) => total + item.columns.length, 0) > maximumColumns) {
    throw bad('Choose at most 24 columns, including the selected foreign-key pairs.');
  }
  const scope = projectSchema(catalog, projected);
  const output = new Map();
  for (const { table, columns } of selections) for (const name of columns) {
    output.set(`${table}.${name}`, { table, name, ...allowedColumn(tables.get(table), name) });
  }
  const observed = scope.context.tables.map(table => ({ table: table.name, columns: table.columns.map(({ name }) => {
    const { type, nullable, primaryKey, ordinal, charset, collation } = allowedColumn(tables.get(table.name), name);
    return { name, type, nullable, primaryKey, ordinal, charset, collation };
  }) })).sort((left, right) => left.table < right.table ? -1 : left.table > right.table ? 1 : 0);
  const canonical = { dialect: scope.dialect, schema: scope.catalog.database, version: catalog.serverVersion,
    modes: [...scope.sqlMode].sort(), caseSensitive: scope.tableNameCaseSensitive, columns: observed, route };
  return { root, names: [...names], output, route, scope, fingerprint: hash(canonical),
    shared: { dialect: canonical.dialect, schema: canonical.schema, root, joins: route.map(({ table, parent, pairs }) => ({ table, parent, pairs })),
      availableColumns: [...output].map(([column, item]) => ({ column, type: item.type.split(/[ (]/, 1)[0] })) } };
}

const record = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function compileGroundedQuery(scope, plan) {
  if (!record(plan, ['columns', 'measures', 'sort', 'limit', 'explanation']) || !Array.isArray(plan.columns) ||
      !Array.isArray(plan.measures) || !Array.isArray(plan.sort) || plan.columns.length > 8 || plan.measures.length > 4 ||
      !plan.columns.length && !plan.measures.length || plan.sort.length > 4 || !Number.isSafeInteger(plan.limit) ||
      plan.limit < 1 || plan.limit > 500 || typeof plan.explanation !== 'string' || !plan.explanation.trim() ||
      Buffer.byteLength(plan.explanation) > 384 || /[\u0000-\u001f\u007f]/.test(plan.explanation)) {
    throw bad('The model did not return a supported grounded SELECT plan.');
  }
  const aliases = new Map(scope.names.map((name, index) => [name, 't' + (index + 1)]));
  const reference = (table, column) => `${aliases.get(table)}.${quoted(column)}`;
  const outputs = new Map();
  const selected = [];
  const groupBy = [];
  for (const key of plan.columns) {
    const column = scope.output.get(key);
    if (!column || outputs.has(key)) throw bad('The model returned a duplicate or unapproved output column.');
    const source = reference(column.table, column.name);
    const alias = 'c' + (selected.length + 1);
    selected.push(`${source} AS ${alias}`);
    outputs.set(key, alias);
    groupBy.push(source);
  }
  for (const measure of plan.measures) {
    const column = scope.output.get(measure?.column);
    const key = measure?.function + '(' + measure?.column + ')';
    if (!record(measure, ['column', 'function']) || !aggregateNames.includes(measure.function) || !column || outputs.has(key) ||
        ['SUM', 'AVG'].includes(measure.function) && !numeric.test(column.type)) throw bad('The model returned an unsupported aggregate or measure column.');
    const alias = 'm' + (selected.length - groupBy.length + 1);
    selected.push(`${measure.function}(${reference(column.table, column.name)}) AS ${alias}`);
    outputs.set(key, alias);
  }
  const sorted = new Set();
  const orderBy = plan.sort.map(item => {
    if (!record(item, ['key', 'direction']) || !outputs.has(item.key) || sorted.has(item.key) || !['ASC', 'DESC'].includes(item.direction)) {
      throw bad('The model attempted to sort by an unapproved or repeated output.');
    }
    sorted.add(item.key);
    return `${outputs.get(item.key)} ${item.direction}`;
  });
  const tableReference = table => `${quoted(scope.scope.catalog.database)}.${quoted(table)} AS ${aliases.get(table)}`;
  const joinSql = scope.route.map(edge => `INNER JOIN ${tableReference(edge.enters)} ON ${edge.pairs.map(([column, target]) =>
    `${reference(edge.table, column)} = ${reference(edge.parent, target)}`).join(' AND ')}`);
  const sql = [`SELECT ${selected.join(', ')}`, `FROM ${tableReference(scope.root)}`, ...joinSql,
    ...(plan.measures.length && groupBy.length ? ['GROUP BY ' + groupBy.join(', ')] : []),
    ...(orderBy.length ? ['ORDER BY ' + orderBy.join(', ')] : []), 'LIMIT ' + plan.limit].join('\n');
  return { sql, plan: structuredClone(plan), route: scope.route, tables: scope.names, execution: 'not-run' };
}

function prepareGroundedRequest({ endpoint, model, context, input, previous }) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input) > 1024) {
    throw bad('Describe the query or refinement in at most 1 KiB.');
  }
  const target = normalizeLocalChatTarget(endpoint, model);
  const { columns, measures, sort, limit } = previous?.plan ?? {};
  const preview = { ...context.shared, request: input.trim(), ...(previous ? { previousPlan: { columns, measures, sort, limit } } : {}) };
  const array = (items, maxItems) => ({ type: 'array', items, maxItems });
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const string = { type: 'string' };
  const schema = object({ columns: array(string, 8), measures: array(object({ column: string, function: { enum: aggregateNames } }), 4),
    sort: array(object({ key: string, direction: { enum: ['ASC', 'DESC'] } }), 4), limit: { type: 'integer', minimum: 1, maximum: 500 },
    explanation: { type: 'string', maxLength: 384 } });
  const instructions = 'Build a structured read-only SELECT plan from the availableColumns. The fixed inner joins are already chosen. ' +
    'Use full table.column strings exactly as provided. Use columns for selected dimensions and measures for COUNT, SUM, AVG, MIN or MAX of an available column. ' +
    'Grouping by columns is automatic when using measures. Sort only by a returned column or a measure formatted as FUNCTION(table.column). ' +
    'Choose limit 100 unless requested. Never output SQL or row values. If the request needs filters, other tables, or cannot be represented, return empty columns and measures. ' +
    'For refinements follow the latest request and retain applicable previousPlan selections.';
  const payload = { temperature: 0, max_tokens: 512, response_format: { type: 'json_schema',
    json_schema: { name: 'rocketbrain_grounded_select', strict: true, schema } }, messages: [{ role: 'system', content: instructions },
    { role: 'user', content: JSON.stringify(preview) }] };
  return { target, context, preview, payload };
}

async function executeGroundedRequest(prepared, { signal } = {}) {
  const result = await requestLocalChat(prepared.target, prepared.payload, { signal });
  const [choice] = Array.isArray(result?.choices) ? result.choices : [];
  const calls = choice?.message?.tool_calls;
  if (result?.choices?.length !== 1 || choice.finish_reason !== 'stop' || choice.message?.role !== 'assistant' ||
      typeof choice.message.content !== 'string' || choice.message.function_call || calls != null && (!Array.isArray(calls) || calls.length)) {
    throw bad('The configured model did not return one complete structured plan.');
  }
  let plan;
  try { plan = JSON.parse(choice.message.content); }
  catch { throw bad('The configured model returned invalid plan JSON.'); }
  return compileGroundedQuery(prepared.context, plan);
}

module.exports = { relationshipOptions, projectGrounding, allowedColumn, compileGroundedQuery, prepareGroundedRequest, executeGroundedRequest };
