'use strict';

const { validateQuery } = require('./sql-policy');

const MAX_PLAN_BYTES = 512 * 1024;
const MAX_NODES = 400;
const MAX_DEPTH = 36;
const JSON_NUMBER = /^(?:-)?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const XML_SAFE_LENGTH = 2048;

const LABELS = {
  query_block: 'Query block', table: 'Table access', nested_loop: 'Nested loop', 'block-nl-join': 'Block nested loop',
  ordering_operation: 'Ordering', grouping_operation: 'Grouping', duplicates_removal: 'Distinct', union_result: 'Union',
  query_specifications: 'Union inputs', filesort: 'Filesort', temporary_table: 'Temporary table', windowing: 'Window',
  materialized_from_subquery: 'Materialized subquery', materialized: 'Materialized subquery', subqueries: 'Subqueries',
  attached_subqueries: 'Attached subqueries', optimized_away_subqueries: 'Optimized-away subqueries',
  read_sorted_file: 'Read sorted result', expression_cache: 'Expression cache', window_functions_computation: 'Window functions',
  having_subqueries: 'Having subqueries', group_by_subqueries: 'Grouping subqueries', select_list_subqueries: 'Projection subqueries'
};
const COST_FIELDS = {
  query_cost: 'Query cost', read_cost: 'Read cost', eval_cost: 'Evaluation cost', prefix_cost: 'Join prefix cost',
  sort_cost: 'Sort cost', cost: 'Cost', estimated_total_cost: 'Estimated total cost',
  estimated_first_row_cost: 'Estimated first-row cost'
};
const ROW_FIELDS = {
  rows_examined_per_scan: 'Rows examined per scan', rows_produced_per_join: 'Rows produced per join',
  rows: 'Rows per access', estimated_rows: 'Estimated output rows', filtered: 'Filtered (%)'
};
const ACTUAL_FIELDS = {
  r_loops: 'Loops', r_rows: 'Observed rows per loop', r_output_rows: 'Output rows per loop', r_filtered: 'Observed filtered (%)',
  r_total_time_ms: 'Total time (ms)', r_table_time_ms: 'Table time (ms)', r_other_time_ms: 'Other time (ms)'
};
const TAG_FIELDS = {
  access_type: 'Access', index_access_type: 'Index access', key: 'Index', index_name: 'Index',
  join_type: 'Join type', join_algorithm: 'Join algorithm', using_join_buffer: 'Join buffer',
  using_filesort: 'Filesort', using_temporary_table: 'Temporary table', using_index: 'Covering index', covering: 'Covering index',
  message: 'Message', schema_name: 'Schema', table_name: 'Table or alias', alias: 'Alias', select_id: 'Select ID'
};
const EXPRESSION_FIELDS = {
  attached_condition: 'Filter', condition: 'Filter', index_condition: 'Index filter', lookup_condition: 'Lookup condition',
  having_condition: 'Having filter', sort_key: 'Sort key'
};

function validatePlanQuery(sql, sqlMode, { measured = false } = {}) {
  const statement = validateQuery(sql, { readOnly: true, sqlMode, allowOptimizerHints: !measured });
  if (!['SELECT', 'WITH'].includes(statement.first)) throw Error('Visual EXPLAIN accepts a SELECT or WITH SELECT statement.');
}

function explainSql(sql, sqlMode, format = 'json') {
  if (!['json', 'tree'].includes(format)) throw Error('Choose JSON or MySQL TREE plan output.');
  validatePlanQuery(sql, sqlMode);
  return 'EXPLAIN FORMAT=' + format.toUpperCase() + '\n' + sql;
}

function measuredSql(sql, sqlMode, engine) {
  validatePlanQuery(sql, sqlMode, { measured: true });
  if (engine === 'mysql') return 'EXPLAIN ANALYZE FORMAT=TREE\n' + sql;
  if (engine === 'mariadb') return 'ANALYZE FORMAT=JSON\n' + sql;
  throw Error('Choose MySQL or MariaDB to measure a query plan.');
}

function parseExact(raw) {
  // Validate the original syntax, then keep numeric lexemes through the
  // supported Node versions without converting them to IEEE-754 doubles.
  JSON.parse(raw);
  return JSON.parse(raw.replace(/"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => token.startsWith('"') ? token : JSON.stringify(token)));
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function short(value) { return typeof value === 'string' ? value.slice(0, XML_SAFE_LENGTH) : undefined; }
function labelFor(kind) { return Object.hasOwn(LABELS, kind) ? LABELS[kind] : kind.replaceAll('_', ' ').slice(0, 120); }
function childContainer(key, child) {
  return Object.hasOwn(LABELS, key) || key === 'inputs' || key === 'query_plan' ||
    record(child) && (Object.hasOwn(child, 'query_block') || Object.hasOwn(child, 'table') || typeof child.operation === 'string');
}

function metricList(value, fields) {
  return Object.entries(fields).flatMap(([key, label]) => {
    const metric = value[key];
    return typeof metric === 'string' && metric.length <= 100 && JSON_NUMBER.test(metric) ? [{ key, label, value: metric }] : [];
  });
}

const numeric = '([+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)';
const actualSuffix = new RegExp('\\s+\\(actual time=' + numeric + '\\.\\.' + numeric + ' rows=' + numeric + ' loops=' + numeric + '\\)$');
const estimateSuffix = new RegExp('\\s+\\(cost=' + numeric + ' rows=' + numeric + '\\)$');

function mysqlMeasuredTree(identity) {
  const nodes = [], rootIds = [], warnings = [], parents = [];
  let omitted = false;
  for (const line of identity.raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const part = /^(\s*)->\s+(.+)$/.exec(line);
    if (!part) { omitted = true; continue; }
    const indent = part[1].replaceAll('\t', '    ').length;
    while (parents.length && parents.at(-1).indent >= indent) parents.pop();
    if (nodes.length >= MAX_NODES || parents.length > MAX_DEPTH) { omitted = true; continue; }
    let operation = part[2].trimEnd();
    const actual = actualSuffix.exec(operation);
    const never = !actual && /\s+\(never executed\)$/i.exec(operation);
    if (actual || never) operation = operation.slice(0, (actual || never).index);
    const estimate = estimateSuffix.exec(operation);
    if (estimate) operation = operation.slice(0, estimate.index);
    const id = 'node-' + (nodes.length + 1);
    const parentId = parents.at(-1)?.id ?? null;
    const entry = (key, label, value) => ({ key, label, value });
    const measured = actual ? [
      entry('first_ms', 'First row (ms)', actual[1]), entry('last_ms', 'Last row (ms)', actual[2]),
      entry('actual_rows', 'Observed rows per loop', actual[3]), entry('loops', 'Loops', actual[4])
    ] : [];
    nodes.push({ id, parentId, depth: parents.length, kind: 'iterator', name: short(operation), expressions: [],
      tags: never ? [{ label: 'Execution', value: 'Never executed' }] : [],
      costs: estimate ? [entry('cost', 'Cost', estimate[1])] : [],
      rows: estimate ? [entry('estimated_rows', 'Estimated output rows', estimate[2])] : [], actual: measured });
    if (!parentId) rootIds.push(id);
    parents.push({ indent, id });
  }
  if (omitted) warnings.push('Some server text is available only in the original TREE output.');
  if (!nodes.some(node => node.actual.length)) warnings.push('No iterator timing or row statistics were decoded. Inspect the original TREE output.');
  return { ...identity, nodes, rootIds, warnings };
}

function normalizePlan({ raw, engine, version, database, format = 'json', measured = false }) {
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > MAX_PLAN_BYTES) {
    throw Error('Visual EXPLAIN accepts plans up to 512 KiB. Narrow the query and try again.');
  }
  const identity = { raw, engine, version, database, format, ...(measured ? { measured: true } : {}) };
  if (format === 'tree') return measured ? mysqlMeasuredTree(identity) : identity;
  const base = { ...identity, nodes: [], rootIds: [], warnings: [] };
  let document;
  try { document = parseExact(raw); }
  catch { return { ...base, warnings: ['The server response could not be decoded as JSON. Open the original output to inspect it.'] }; }
  if (!record(document)) return { ...base, warnings: ['The result has an unfamiliar plan structure. Original output is available.'] };
  const nodes = [], omitted = new Set();
  let truncated = false;

  function add(kind, value, parentId, depth) {
    if (nodes.length >= MAX_NODES || depth > MAX_DEPTH) { truncated = true; return; }
    if (!record(value) && !Array.isArray(value)) return;
    const data = record(value) ? value : {};
    const id = 'node-' + (nodes.length + 1);
    const name = short(data.operation) ?? [labelFor(kind), short(data.table_name) ?? (data.select_id ? '#' + data.select_id : undefined)]
      .filter(Boolean).join(' · ');
    const cost = { ...(record(data.cost_info) ? data.cost_info : {}), ...data };
    const tags = Object.entries(TAG_FIELDS).flatMap(([key, label]) => {
      const item = data[key];
      return typeof item === 'boolean' && item || typeof item === 'string' && item ? [{ label, value: item === true ? 'Yes' : short(item) }] : [];
    });
    const expressions = Object.entries(EXPRESSION_FIELDS).filter(([key]) => typeof data[key] === 'string' && data[key])
      .map(([key, label]) => ({ label, value: short(data[key]) }));
    nodes.push({ id, parentId, depth, kind, name, tags, expressions, costs: metricList(cost, COST_FIELDS),
      rows: metricList(data, ROW_FIELDS), ...(measured ? { actual: metricList(data, ACTUAL_FIELDS) } : {}) });
    if (Array.isArray(value)) {
      for (const item of value) {
        if (nodes.length >= MAX_NODES) { truncated = true; break; }
        if (record(item) && Object.keys(item).length === 1 && Object.hasOwn(item, 'query_block')) add('query_block', item.query_block, id, depth + 1);
        else if (record(item) && Object.keys(item).length === 1 && Object.hasOwn(item, 'table')) add('table', item.table, id, depth + 1);
        else add(typeof item?.operation === 'string' ? 'operator' : 'Input', item, id, depth + 1);
      }
      return id;
    }
    for (const [key, child] of Object.entries(data)) {
      if (key === 'cost_info') continue;
      if (!record(child) && !Array.isArray(child)) continue;
      if (childContainer(key, child)) {
        if (key === 'inputs' && Array.isArray(child)) {
          for (const item of child) {
            if (nodes.length >= MAX_NODES) { truncated = true; break; }
            add('operator', item, id, depth + 1);
          }
        } else add(key, child, id, depth + 1);
      } else if (record(child) || child.some(record)) {
        if (omitted.size < 12) omitted.add(key.slice(0, 80));
      }
    }
    return id;
  }

  const rootIds = [];
  if (typeof document.operation === 'string') rootIds.push(add('operator', document, null, 0));
  else for (const [key, value] of Object.entries(document)) {
    if (childContainer(key, value)) {
      const id = add(key, value, null, 0);
      if (id) rootIds.push(id);
    }
  }
  const warnings = [];
  if (truncated) warnings.push('The visual plan shows up to 400 nodes and 36 nested levels. The original plan remains available.');
  if (omitted.size) warnings.push('Additional server plan structures are in the original JSON: ' + [...omitted].join(', ') + '.');
  if (!rootIds.length) warnings.push('The result has an unfamiliar plan structure. Original output is available.');
  if (nodes.length && !nodes.some(node => node.costs.length)) warnings.push('This plan has no numeric optimizer costs. Row estimates are shown where available.');
  return { ...base, nodes, rootIds, warnings };
}

function comparePlans(left, right) {
  if (left.engine !== right.engine || left.version !== right.version || left.database !== right.database ||
      left.format !== right.format || Boolean(left.measured) !== Boolean(right.measured)) {
    throw Error('Choose two captured plans from the same server, format and capture mode.');
  }
  if (!left.nodes?.length || !right.nodes?.length) throw Error('Both plans need a decoded tree to compare.');
  function index(plan) {
    const paths = new Map(), counts = new Map(), result = new Map();
    for (const node of plan.nodes) {
      const parent = paths.get(node.parentId) ?? '';
      const slot = (counts.get(node.parentId) || 0) + 1;
      counts.set(node.parentId, slot);
      const key = parent + '/' + JSON.stringify([slot, node.kind, node.name]);
      paths.set(node.id, key);
      const values = [...node.costs, ...node.rows, ...(node.actual || [])];
      result.set(key, { name: node.name, depth: node.depth, values,
        detail: [...node.tags, ...node.expressions].map(item => [item.label, item.value]) });
    }
    return result;
  }
  const a = index(left), b = index(right);
  const rows = [...new Set([...a.keys(), ...b.keys()])].map(key => {
    const before = a.get(key), after = b.get(key);
    const state = !before ? 'added' : !after ? 'removed' :
      JSON.stringify(before) === JSON.stringify(after) ? 'same' : 'changed';
    return { state, before, after };
  });
  return { engine: left.engine, version: left.version, database: left.database, measured: Boolean(left.measured), rows,
    baselineWarnings: left.warnings, candidateWarnings: right.warnings,
    counts: Object.fromEntries(['same', 'changed', 'removed', 'added'].map(state => [state, rows.filter(row => row.state === state).length])) };
}

module.exports = { MAX_PLAN_BYTES, explainSql, measuredSql, validatePlanQuery, normalizePlan, comparePlans };
