'use strict';

const { comparePlans, parseExact } = require('./explain-plan');

const identifier = '[a-z_][a-z0-9_]{0,62}';
const space = '[ \\t\\r\\n]';
const columnList = identifier + '(?:' + space + '*,' + space + '*' + identifier + '){0,31}';
const query = new RegExp('^select' + space + '+(\\*|' + columnList + ')' + space + '+from' + space + '+' +
  '(?:(' + identifier + ')\\.)?(' + identifier + ')(?:' + space + '+where' + space + '+(' + identifier + ')' +
  space + '*=' + space + '*(-?[0-9]{1,19}))?' + space + '*;?$', 'i');
const unsupported = 'Estimate a single PostgreSQL SELECT with a table, projected columns, and an optional integer equality.';
const quote = value => '"' + value + '"';
const timing = ['Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops'];
const buffers = ['Shared', 'Local', 'Temp'].flatMap(pool => ['Hit', 'Read', 'Dirtied', 'Written'].map(kind => pool + ' ' + kind + ' Blocks'));
const ioTiming = ['I/O Read Time', 'I/O Write Time', 'Shared I/O Read Time', 'Shared I/O Write Time',
  'Local I/O Read Time', 'Local I/O Write Time', 'Temp I/O Read Time', 'Temp I/O Write Time'];
const exactNumber = value => typeof value === 'string' && /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value);
const numericMetrics = (record, keys) => keys.filter(key => exactNumber(record?.[key])).map(key => ({ label: key, value: record[key] }));

function parsePostgreSqlPlanQuery(sql, schema) {
  const text = typeof sql === 'string' ? sql.trim() : '';
  const match = text.length <= 4096 && query.exec(text);
  if (!match || !new RegExp('^' + identifier + '$').test(schema) || /^pg_|^information_schema$/.test(schema)) {
    throw Error(unsupported);
  }
  const [, projection, explicitSchema, table, column, literal] = match.map(value => value?.toLowerCase());
  if (explicitSchema && explicitSchema !== schema) throw Error('Use a table in the approved PostgreSQL schema.');
  const columns = projection.split(',').map(item => item.trim());
  if (new Set(columns).size !== columns.length) throw Error('Select each PostgreSQL plan column once.');
  const filter = column ? BigInt(literal) : undefined;
  if (filter !== undefined && (filter < -9223372036854775808n || filter > 9223372036854775807n)) {
    throw Error('Use an integer equality value within PostgreSQL bigint range.');
  }
  const names = projection === '*' ? '*' : columns.map(quote).join(', ');
  const canonicalSql = 'SELECT ' + names + ' FROM ONLY ' + quote(schema) + '.' + quote(table) +
    (column ? ' WHERE ' + quote(column) + ' = ' + filter : '');
  return { schema, table, columns, predicate: column ? column + '=' + filter : '', canonicalSql };
}

function normalizePostgreSqlPlan({ raw, relation, version, database, request, measured = false, scopeFingerprint, executionSql }) {
  const document = typeof raw === 'string' && Buffer.byteLength(raw) <= 65536 && parseExact(raw);
  if (!Array.isArray(document) || document.length !== 1 || !document[0]?.Plan) throw Error('PostgreSQL returned an invalid plan.');
  const nodes = [];
  function add(plan, parentId, depth) {
    if (!plan || typeof plan['Node Type'] !== 'string' || nodes.length >= 160 || depth > 20 ||
        (!measured && Object.keys(plan).some(key => key.startsWith('Actual '))) ||
        (measured && !timing.every(key => exactNumber(plan[key])))) {
      throw Error('PostgreSQL returned an unsupported or oversized plan for the selected capture mode.');
    }
    const id = 'node-' + (nodes.length + 1), kind = plan['Node Type'];
    const metrics = keys => keys.flatMap(key => typeof plan[key] === 'string' ? [{ label: key, value: plan[key] }] : []);
    const tags = metrics(['Schema', 'Relation Name', 'Index Name', 'Scan Direction', 'Parent Relationship']);
    const access = plan['Relation Name'] ? ' · ' + plan['Relation Name'] : '';
    nodes.push({ id, parentId, depth, kind, name: kind + access, tags,
      costs: metrics(['Startup Cost', 'Total Cost']), rows: metrics(['Plan Rows', 'Plan Width']),
      expressions: metrics(['Filter', 'Index Cond', 'Recheck Cond', 'Sort Key']),
      ...(measured && { actual: numericMetrics(plan, [...timing, ...buffers, ...ioTiming]) }) });
    if (plan.Plans !== undefined && !Array.isArray(plan.Plans)) throw Error('PostgreSQL returned invalid plan children.');
    for (const child of plan.Plans || []) add(child, id, depth + 1);
    return id;
  }
  const [top] = document;
  if (!measured && Object.keys(top).some(key => key === 'Execution Time' || key === 'Triggers')) {
    throw Error('PostgreSQL returned runtime measurements for an estimated plan.');
  }
  if (measured && (!/^[a-f0-9]{64}$/u.test(scopeFingerprint || '') || typeof executionSql !== 'string' ||
      !exactNumber(top['Execution Time']) || !exactNumber(top['Planning Time']) ||
      !buffers.some(key => exactNumber(top.Plan[key])) || top.Triggers !== undefined &&
      (!Array.isArray(top.Triggers) || top.Triggers.length))) {
    throw Error('PostgreSQL returned incomplete measured timings, buffer statistics or unsupported trigger activity.');
  }
  const rootIds = [add(top.Plan, null, 0)];
  return { engine: 'postgresql', version, database, schema: request.schema, table: request.table, relation,
    format: 'json', measured, canonicalSql: request.canonicalSql, raw, nodes, rootIds, warnings: [],
    ...(scopeFingerprint && { scopeFingerprint, executionSql, boundPredicate: request.predicate }),
    ...(measured && { summary: numericMetrics(top, ['Planning Time', 'Execution Time']),
      planningBuffers: numericMetrics(top.Planning, [...buffers, ...ioTiming]) }) };
}

function comparePostgreSqlPlans(left, right) {
  if (left.relation !== right.relation || left.schema !== right.schema || left.canonicalSql !== right.canonicalSql) {
    throw Error('Choose two captures for the same PostgreSQL statement and relation.');
  }
  if (left.measured !== right.measured) {
    if (!left.scopeFingerprint || left.scopeFingerprint !== right.scopeFingerprint) {
      throw Error('Choose the reviewed estimate from the same PostgreSQL statement and verified relation shape.');
    }
    const comparison = comparePlans({ ...left, measured: false }, { ...right, measured: false });
    const metric = (node, label) => node?.values.find(item => item.label === label)?.value;
    const rowEstimates = comparison.rows.flatMap(row => {
      const estimate = left.measured ? row.after : row.before, runtime = left.measured ? row.before : row.after;
      const estimatedRows = metric(estimate, 'Plan Rows'), actualRowsPerLoop = metric(runtime, 'Actual Rows'), loops = metric(runtime, 'Actual Loops');
      return estimatedRows !== undefined && actualRowsPerLoop !== undefined ? [{ operator: runtime.name, estimatedRows, actualRowsPerLoop, loops }] : [];
    });
    return { ...comparison, baselineMeasured: left.measured, candidateMeasured: right.measured,
      sameReviewedScope: true, optimizerCostUnitsAreNotMilliseconds: true, rowEstimates };
  }
  return comparePlans(left, right);
}

function renderPostgreSqlPlan(plan) {
  return [plan.measured ? 'PostgreSQL Measured Plan' : 'PostgreSQL Estimated Plan', plan.database + '.' + plan.schema + ' · ' + plan.version,
    'Captured ' + plan.capturedAt, '', plan.canonicalSql, '',
    ...(plan.measured ? [...plan.summary.map(item => item.label + ' ' + item.value + ' ms'),
      ...plan.planningBuffers.map(item => 'Planning ' + item.label + ' ' + item.value), ''] : []),
    ...plan.nodes.map(node => {
      const indent = '  '.repeat(node.depth);
      return [indent + node.name, ...[...node.tags, ...node.costs, ...node.rows, ...node.expressions, ...(node.actual || [])]
        .map(item => indent + '  ' + item.label + '  ' + item.value)].join('\n');
    }), '', plan.measured ? 'PostgreSQL executed the reviewed SELECT in a read-only transaction and rolled it back. Actual rows and node timing are per-loop averages. Optimizer costs use separate units.' :
      'Optimizer estimates only. PostgreSQL did not execute the SELECT.'].join('\n');
}

function renderPostgreSqlPlanReview(review) {
  const { estimate } = review;
  return ['PostgreSQL Read-Only Measurement Review', estimate.database + '.' + estimate.schema + '.' + estimate.table,
    'Relation OID ' + estimate.relation, 'Reviewed scope SHA-256 ' + estimate.scopeFingerprint, '',
    'EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, TIMING TRUE, SUMMARY TRUE, VERBOSE TRUE, COSTS TRUE, FORMAT JSON)',
    estimate.executionSql, ...(estimate.boundPredicate ? ['Bound integer ' + estimate.boundPredicate] : []), '',
    'Measurement executes this SELECT. The server holds a bounded SHARE UPDATE EXCLUSIVE lock on this one table during capture.',
    '', renderPostgreSqlPlan(estimate)].join('\n');
}

module.exports = { parsePostgreSqlPlanQuery, normalizePostgreSqlPlan, comparePostgreSqlPlans, renderPostgreSqlPlan, renderPostgreSqlPlanReview };
