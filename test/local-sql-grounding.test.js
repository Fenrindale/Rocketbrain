'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { relationshipOptions, projectGrounding, compileGroundedQuery, prepareGroundedRequest } = require('../src/db/local-sql-grounding');
const { registerGroundedSqlAssistant } = require('../src/db/local-sql-grounding-vscode');
const { explanationHtml } = require('../src/db/explain-plan-view');

const column = (name, type = 'int') => ({ name, type });
const key = (table, name, pairs) => ({ name, referencedTable: table, referencedSchema: 'work', columns:
  pairs.map(([column, target], index) => ({ name: column, referencedColumn: target, ordinal: index + 1 })) });
const table = (name, columns, foreignKeys = []) => ({ name, kind: 'table', engine: 'InnoDB', columns, foreignKeys });
const catalog = { database: 'work', dialect: 'mariadb', serverVersion: '11.4', sqlMode: ['STRICT_TRANS_TABLES'],
  semanticContextObserved: true, coverage: { tables: 'loaded', columns: 'loaded', foreignKeys: 'loaded' }, tables: [
    table('orders', [column('account'), column('ord'), column('total'), column('unselected')],
      [key('accounts', 'composite', [['account', 'acct'], ['ord', 'branch']])]),
    table('accounts', [column('acct'), column('branch'), column('location'), { ...column('virtual'), extra: 'VIRTUAL GENERATED' }],
      [key('regions', 'location', [['location', 'code']])]),
    table('regions', [column('code'), { ...column('name', "enum('fixture-value')"), defaultValue: 'fixture-value' }]),
    { ...table('redirected', [column('id')]), kind: 'view' } ] };
const [first, second] = relationshipOptions(catalog);
const choices = { root: 'orders', edgeIds: [first.id, second.id], selections: [
  { table: 'orders', columns: ['total'] }, { table: 'accounts', columns: ['acct'] }, { table: 'regions', columns: ['name'] }
] };
const plan = { columns: ['regions.name'], measures: [{ column: 'orders.total', function: 'SUM' }],
  sort: [{ key: 'SUM(orders.total)', direction: 'DESC' }], limit: 25, explanation: 'Totals by region' };

test('an exploration has fixed turn, model request and total lifetime bounds', async t => {
  let accept = true, hits = 0;
  const model = createServer((request, response) => {
    hits++;
    request.resume();
    response.writeHead(accept ? 200 : 500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const subscriptions = [], disposable = { dispose() {} };
  const target = { model: 'fixture', endpoint: 'http://127.0.0.1:' + model.address().port + '/v1/chat/completions' };
  const api = registerGroundedSqlAssistant({ subscriptions }, {
    workspace: { isTrusted: true, getConfiguration: () => ({ get: name => target[name] }),
      onDidChangeConfiguration: () => disposable, registerTextDocumentContentProvider: () => disposable },
    commands: { registerCommand: () => disposable }
  }, { liveCatalogIdentity: () => 'fixture', databaseCatalog: async () => catalog, onDidChangeDatabase: () => disposable });
  t.after(async () => {
    for (const item of subscriptions) item.dispose();
    await new Promise(resolve => model.close(resolve));
  });
  const stage = previousId => api.stage(previousId ? { previousId, input: 'Keep the request' } : { choices, input: 'Summarize by region' });
  async function approved(previousId) {
    const request = await stage(previousId);
    const proposal = await api.draft(request.id, { confirmed: true });
    api.review(proposal.id, { confirmed: true, digest: proposal.digest });
    return proposal;
  }
  const first = await approved();
  let latest = first;
  for (let turn = 2; turn <= 4; turn++) latest = await approved(latest.id);
  assert.equal(first.explorationId, latest.explorationId);
  assert.equal(api.transcript(first.explorationId).turns.length, 4);
  await assert.rejects(stage(latest.id), /turn or model request limit/);
  assert.equal(hits, 4);
  const limited = await approved();
  accept = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const pending = await stage(limited.id);
    await assert.rejects(api.draft(pending.id, { confirmed: true }), /could not complete the request/);
  }
  await assert.rejects(stage(limited.id), /turn or model request limit/);
  assert.equal(hits, 10);
  const { expiresAt } = api.transcript(first.explorationId);
  t.mock.method(Date, 'now', () => expiresAt);
  assert.throws(() => api.transcript(first.explorationId), /expired/);
  await assert.rejects(stage(limited.id), /expired|limit/);
});

test('full composite and chained keys are compiled rather than inferred from model SQL', () => {
  const scope = projectGrounding(catalog, choices);
  const result = compileGroundedQuery(scope, plan);
  assert.equal(result.sql, ['SELECT t3.`name` AS c1, SUM(t1.`total`) AS m1', 'FROM `work`.`orders` AS t1',
    'INNER JOIN `work`.`accounts` AS t2 ON t1.`account` = t2.`acct` AND t1.`ord` = t2.`branch`',
    'INNER JOIN `work`.`regions` AS t3 ON t2.`location` = t3.`code`', 'GROUP BY t3.`name`', 'ORDER BY m1 DESC', 'LIMIT 25'].join('\n'));
  assert.equal(result.execution, 'not-run');
  const backward = projectGrounding(catalog, { ...choices, root: 'regions', edgeIds: [second.id, first.id] });
  assert.match(compileGroundedQuery(backward, plan).sql, /t3\.`account` = t2\.`acct` AND t3\.`ord` = t2\.`branch`/);
  assert.throws(() => projectGrounding(catalog, { ...choices, root: 'regions' }), /connected route/);
  assert.throws(() => projectGrounding(catalog, { ...choices, edgeIds: [first.id, first.id] }), /distinct/);
});

test('hidden rows, other objects, defaults, and the prior explanation stay out of refinement payloads', () => {
  const scope = projectGrounding(catalog, choices);
  const endpoint = 'http://127.0.0.1:3000/v1/chat/completions';
  const previous = { sql: 'SELECT fixture-sentinel', plan: { ...plan, explanation: 'fixture-sentinel' } };
  const request = prepareGroundedRequest({ endpoint, model: 'fixture', context: scope, input: 'Reverse the order', previous });
  assert.deepEqual(request.preview.previousPlan.sort, plan.sort);
  for (const omitted of ['fixture-value', 'unselected', 'redirected', 'fixture-sentinel', 'composite']) {
    assert.ok(!JSON.stringify(request.preview).includes(omitted));
  }
  assert.throws(() => prepareGroundedRequest({ endpoint: endpoint.replace('127.0.0.1','example.invalid'), model: 'fixture', context: scope, input: 'test' }), /loopback/);
});

test('raw SQL, unsupported aggregate types, unavailable or generated columns and extra plan fields are rejected', () => {
  const scope = projectGrounding(catalog, choices);
  for (const invalid of [{ ...plan, join: 'OR TRUE' }, { ...plan, limit: 501 }, { ...plan, columns: ['orders.unselected'] },
    { ...plan, measures: [{ column: 'regions.name', function: 'SUM' }] }, { ...plan, columns: ['accounts.virtual'] },
    { ...plan, sort: [{ key: 'orders.total', direction: 'ASC' }] }, { ...plan, columns: [], measures: [] },
    { ...plan, explanation: '<text>\n' }]) assert.throws(() => compileGroundedQuery(scope, invalid));
  assert.throws(() => projectGrounding(catalog, { ...choices, selections: [choices.selections[0],
    { table: 'accounts', columns: ['virtual'] }, choices.selections[2]] }), /observed ordinary/);
});

test('exact schema changes alter the plan binding, unselected fields and enumeration literal types are not shared', () => {
  const scope = projectGrounding(catalog, choices);
  const changed = structuredClone(catalog);
  changed.tables[0].columns.find(item => item.name === 'total').type = 'bigint';
  assert.notEqual(projectGrounding(changed, choices).fingerprint, scope.fingerprint);
  changed.tables[0].columns.find(item => item.name === 'total').type = 'int';
  changed.tables[0].columns.find(item => item.name === 'unselected').type = 'bigint';
  assert.equal(projectGrounding(changed, choices).fingerprint, scope.fingerprint);
  changed.tables[0].foreignKeys[0].columns[1].ordinal = 3;
  assert.throws(() => projectGrounding(changed, choices), /reviewed key/);
  assert.throws(() => relationshipOptions({ ...catalog, coverage: { ...catalog.coverage, foreignKeys: 'unavailable' } }), /live MySQL or MariaDB/);
});

test('the plan viewer preserves normal tree and JSON controls without offering an unavailable second database capture', () => {
  const report = { engine: 'mysql', database: 'work', version: '8.4.13', nodes: [], rootIds: [], warnings: [], raw: '{}' };
  assert.match(explanationHtml(report, { nonce: 'test' }), /data-view="raw-tree"/);
  const html = explanationHtml(report, { nonce: 'test', allowTreeCapture: false });
  assert.doesNotMatch(html, /data-view="raw-tree"/);
  assert.match(html, /data-view="raw"/);
  assert.match(html, /data-view="table"/);
});
