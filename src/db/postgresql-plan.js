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

function normalizePostgreSqlPlan({ raw, relation, version, database, request }) {
  const document = typeof raw === 'string' && Buffer.byteLength(raw) <= 65536 && parseExact(raw);
  if (!Array.isArray(document) || document.length !== 1 || !document[0]?.Plan) throw Error('PostgreSQL returned an invalid estimated plan.');
  const nodes = [];
  function add(plan, parentId, depth) {
    if (!plan || typeof plan['Node Type'] !== 'string' || nodes.length >= 160 || depth > 20 ||
        Object.keys(plan).some(key => key.startsWith('Actual '))) {
      throw Error('PostgreSQL returned an unsupported or oversized estimated plan.');
    }
    const id = 'node-' + (nodes.length + 1), kind = plan['Node Type'];
    const metrics = keys => keys.flatMap(key => typeof plan[key] === 'string' ? [{ label: key, value: plan[key] }] : []);
    const tags = metrics(['Schema', 'Relation Name', 'Index Name', 'Scan Direction', 'Parent Relationship']);
    const access = plan['Relation Name'] ? ' · ' + plan['Relation Name'] : '';
    nodes.push({ id, parentId, depth, kind, name: kind + access, tags,
      costs: metrics(['Startup Cost', 'Total Cost']), rows: metrics(['Plan Rows', 'Plan Width']),
      expressions: metrics(['Filter', 'Index Cond', 'Recheck Cond', 'Sort Key']) });
    if (plan.Plans !== undefined && !Array.isArray(plan.Plans)) throw Error('PostgreSQL returned invalid plan children.');
    for (const child of plan.Plans || []) add(child, id, depth + 1);
    return id;
  }
  if (Object.keys(document[0]).some(key => key === 'Execution Time' || key === 'Triggers')) {
    throw Error('PostgreSQL returned runtime measurements for an estimated plan.');
  }
  const rootIds = [add(document[0].Plan, null, 0)];
  return { engine: 'postgresql', version, database, schema: request.schema, table: request.table, relation,
    format: 'json', measured: false, canonicalSql: request.canonicalSql, raw, nodes, rootIds, warnings: [] };
}

function comparePostgreSqlPlans(left, right) {
  if (left.relation !== right.relation || left.schema !== right.schema || left.canonicalSql !== right.canonicalSql) {
    throw Error('Choose two estimates for the same PostgreSQL statement and relation.');
  }
  return comparePlans(left, right);
}

function renderPostgreSqlPlan(plan) {
  return ['PostgreSQL Estimated Plan', plan.database + '.' + plan.schema + ' · ' + plan.version,
    'Captured ' + plan.capturedAt, '', plan.canonicalSql, '',
    ...plan.nodes.map(node => {
      const indent = '  '.repeat(node.depth);
      return [indent + node.name, ...[...node.tags, ...node.costs, ...node.rows, ...node.expressions]
        .map(item => indent + '  ' + item.label + '  ' + item.value)].join('\n');
    }), '', 'Optimizer estimates only. PostgreSQL did not execute the SELECT.'].join('\n');
}

module.exports = { parsePostgreSqlPlanQuery, normalizePostgreSqlPlan, comparePostgreSqlPlans, renderPostgreSqlPlan };
