'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { explainSql, normalizePlan } = require('../src/db/explain-plan');
const { explanationHtml } = require('../src/db/explain-plan-view');
const { browserRuntime } = require('./helpers/browser-runtime');

const mysqlJson = `{
  "query_block": {"select_id": 1, "cost_info": {"query_cost": "1.000"},
    "ordering_operation": {"using_filesort": true, "cost_info": {"sort_cost": "0.150"},
      "nested_loop": [
        {"table": {"table_name": "p", "access_type": "ALL", "rows_examined_per_scan": 9007199254740993,
          "attached_condition": "p.name < 'A'", "cost_info": {"prefix_cost": "0.005", "read_cost": "0.002"}}},
        {"table": {"table_name": "d", "access_type": "eq_ref", "key": "PRIMARY",
          "rows_produced_per_join": 1, "filtered": "100.00", "cost_info": {"prefix_cost": "0.850"}}}
      ]
    }
  }
}`;
const mariaJson = '{"query_block":{"select_id":1,"filesort":{"sort_key":"p.name","temporary_table":{"nested_loop":[' +
  '{"table":{"table_name":"p","access_type":"ALL","rows":4294967296,"filtered":99.000,' +
  '"attached_condition":"p.name <> \'<script>\'"}},' +
  '{"block-nl-join":{"table":{"table_name":"d","access_type":"ALL","rows":3},"join_type":"BNL"}}]}}}}';
const mysqlV2 = `{"operation":"Nested loop inner join","join_algorithm":"nested_loop", "estimated_total_cost": 49827.83951582908241,
  "inputs":[{"operation":"Table scan on orders","estimated_rows":2e4,"estimated_total_cost":0.1500},
  {"operation":"Filter: qty > 10","condition":"qty > 10","estimated_rows":1.0}]}`;
const plan = (raw, engine = 'mysql') => normalizePlan({ raw, engine, database: 'fixture', version: 'test' });

test('visual EXPLAIN reuses the single-statement read-only policy and dispatches only an estimated JSON plan', () => {
  assert.equal(explainSql('SELECT 1;'), 'EXPLAIN FORMAT=JSON\nSELECT 1;');
  assert.equal(explainSql('SELECT 1;', undefined, 'tree'), 'EXPLAIN FORMAT=TREE\nSELECT 1;');
  assert.throws(() => explainSql('SELECT 1;', undefined, 'ANALYZE'), /Choose JSON or MySQL TREE/);
  assert.match(explainSql('WITH a AS (SELECT 1 AS n) SELECT n FROM a'), /^EXPLAIN FORMAT=JSON\nWITH/);
  for (const sql of ['EXPLAIN ANALYZE SELECT 1', 'ANALYZE FORMAT=JSON SELECT 1', 'UPDATE p SET n=1',
    'SELECT 1; SELECT 2', 'SELECT GET_LOCK(\'rb\', 3)', 'SELECT * FROM p FOR UPDATE',
    'SELECT 1 INTO OUTFILE \'file\'', 'SELECT @user', 'SELECT 1 /*!80000 UNION SELECT 2 */',
    'WITH a AS (SELECT 1) DELETE FROM p', 'SELECT 1 /*M!100500 UNION SELECT 2 */']) {
    assert.throws(() => explainSql(sql), Error, sql);
  }
});

test('MySQL visual EXPLAIN retains operation trees and exact server cost and row values', () => {
  const result = plan(mysqlJson);
  assert.equal(result.raw, mysqlJson);
  assert.deepEqual(result.nodes.map(node => node.kind), ['query_block', 'ordering_operation', 'nested_loop', 'table', 'table']);
  const [root, order, join, person, dept] = result.nodes;
  assert.equal(person.parentId, join.id);
  assert.equal(dept.parentId, join.id);
  assert.deepEqual(root.costs.map(item => item.value), ['1.000']);
  assert.deepEqual(order.costs.map(item => item.value), ['0.150']);
  assert.deepEqual(person.rows.map(item => item.value), ['9007199254740993']);
  assert.deepEqual(dept.rows.map(item => item.value), ['1', '100.00']);
  assert.deepEqual(person.expressions, [{ label: 'Filter', value: "p.name < 'A'" }]);
  assert.deepEqual(result.warnings, []);
  const accessPath = plan(mysqlV2);
  assert.deepEqual(accessPath.nodes.map(node => node.name), ['Nested loop inner join', 'Table scan on orders', 'Filter: qty > 10']);
  assert.equal(accessPath.nodes[0].costs[0].value, '49827.83951582908241');
  assert.equal(accessPath.nodes[1].costs[0].value, '0.1500');
  assert.equal(accessPath.nodes[1].rows[0].value, '2e4');
  const serverTree = '-> Nested loop inner join  (cost=0.15 rows=1)\n    -> Table scan on p\n';
  assert.equal(normalizePlan({ raw: serverTree, engine: 'mysql', version: '8.4', database: 'fixture', format: 'tree' }).raw, serverTree);
});

test('MariaDB visual EXPLAIN preserves filesort, joins, row metrics and raw output without inferring costs', () => {
  const result = plan(mariaJson, 'mariadb');
  assert.deepEqual(result.nodes.map(node => node.kind), ['query_block', 'filesort', 'temporary_table', 'nested_loop', 'table', 'Input', 'block-nl-join', 'table']);
  assert.equal(result.nodes[4].rows[1].value, '99.000');
  assert.ok(result.nodes.every(node => !node.costs.length));
  assert.ok(result.warnings.some(note => /no numeric optimizer costs/.test(note)));
  const withCost = plan(mariaJson.replace('"filtered":99.000', '"filtered":99.000,"cost":0.12500'), 'mariadb');
  assert.equal(withCost.nodes[4].costs[0].value, '0.12500');
  const html = explanationHtml(result, { nonce: 'test-only' });
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /p\.name <> '<script>'/);
});

test('visual EXPLAIN keeps unfamiliar or oversized graphs inspectable as raw server output', () => {
  const future = plan('{"unrecognized":{"sibling":[]}}');
  assert.equal(future.nodes.length, 0);
  assert.equal(future.raw, '{"unrecognized":{"sibling":[]}}');
  assert.ok(future.warnings.length);
  assert.match(plan('{oops}').warnings[0], /could not be decoded/);
  const many = plan(JSON.stringify({ query_block: { nested_loop: Array.from({ length: 402 }, (_, index) => ({ table: { table_name: 'table_' + index } })) } }));
  assert.equal(many.nodes.length, 400);
  assert.match(many.warnings.join(' '), /400 nodes/);
  assert.throws(() => plan('x'.repeat(513 * 1024)), /512 KiB/);
});

const runtime = browserRuntime();
test('visual EXPLAIN Webview displays the tree, keyboard filter, rows, cost markers and raw view', { skip: runtime.skip, timeout: 30000 }, async () => {
  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1250, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://explain.local/', route => route.fulfill({ contentType: 'text/html',
      body: explanationHtml(plan(mysqlJson), { nonce: 'test-only', source: true }) }));
    await page.addInitScript(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) });
    });
    await page.goto('https://explain.local/');
    await page.getByRole('button', { name: 'Expand all' }).click();
    assert.equal(await page.locator('#tree meter:visible').count(), 2);
    assert.match(await page.locator('#tree').innerText(), /9007199254740993/);
    await page.getByRole('searchbox', { name: 'Filter' }).fill('PRIMARY');
    assert.equal(await page.locator('#tree li.branch:visible').count(), 4);
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    assert.equal(await page.locator('tbody tr:visible').count(), 1);
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    assert.equal(await page.locator('#original').textContent(), mysqlJson);
    await page.getByRole('button', { name: 'Copy JSON' }).click();
    await page.getByRole('button', { name: 'Open SQL' }).click();
    await page.getByRole('button', { name: 'MySQL TREE text', exact: true }).click();
    await page.getByRole('button', { name: 'Capture TREE text' }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'tree-error', text: 'An error' } })));
    assert.equal(await page.getByRole('status').innerText(), 'An error');
    await page.getByRole('button', { name: 'Capture TREE text' }).click();
    const text = '-> Query tree <script> (cost=2.0 rows=3)\n';
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'tree', text: value } })), text);
    assert.equal(await page.locator('#original-tree').textContent(), text);
    await page.getByRole('button', { name: 'Copy TREE text' }).click();
    assert.deepEqual(await page.evaluate(() => window.messages),
      [{ type: 'copy' }, { type: 'source' }, { type: 'tree' }, { type: 'tree' }, { type: 'copy-tree' }]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
