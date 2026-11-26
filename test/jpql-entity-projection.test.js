'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { ObserverClient } = require('../src/jpa/observer-client');
const { registerJpaConsole, htmlForResult } = require('../src/jpa/console-vscode');

const query = 'select d from Person p left join p.department d on d.id = :wanted';
const factoryId = 'factory-1';
const review = 'c'.repeat(64);
const columns = [{ alias: 'id', javaType: 'java.lang.Long' }, { alias: 'name', javaType: 'java.lang.String' }];
const entityProjection = { javaType: 'sample.Department', alias: 'd', id: 'id', nullable: true, scalarFieldsOnly: true, review };
const described = { state: 'described', factoryId, columns, sqlExecuted: false, entityProjection,
  parameters: [{ key: ':wanted', javaType: 'java.lang.Long' }] };
const executed = { state: 'executed', factoryId, columns, sqlExecuted: true, entityProjection,
  rows: [[null, null], ['9', 'Sales']], rowCount: 2, hasMore: false, queryExecuted: true,
  databaseReadOnlyTransaction: true, rolledBack: true, boundParameterValuesRetained: false };

test('the JPQL protocol carries the reviewed entity fingerprint and rejects an incoherent null projection', async () => {
  const requests = [];
  let result = executed;
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const bytes of request) raw += bytes;
    requests.push(JSON.parse(raw));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/console/describe' ? described : result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new ObserverClient({ url: 'http://127.0.0.1:' + server.address().port, token: 'p'.repeat(48) });
  try {
    assert.deepEqual(await client.describeSelect(query, factoryId), described);
    const selected = await client.select(query, factoryId, { ':wanted': '9' }, 2, review);
    assert.deepEqual(selected.rows, executed.rows);
    assert.deepEqual(requests.at(-1), { query, factoryId, values: { ':wanted': '9' }, limit: 2, entityReview: review });
    await assert.rejects(client.select(query, factoryId, { ':wanted': '9' }, 2, 'short'), { code: 'INVALID_REVIEW' });
    result = { ...executed, rows: [[null, 'invented'], ['9', 'Sales']] };
    await assert.rejects(client.select(query, factoryId, { ':wanted': '9' }, 2, review), { code: 'INVALID_SCHEMA' });
    result = { ...executed, entityProjection: { ...entityProjection, review: 'b'.repeat(64) } };
    await assert.rejects(client.select(query, factoryId, { ':wanted': '9' }, 2, review), { code: 'INVALID_SCHEMA' });
    result = executed;
    const html = htmlForResult(result, query);
    assert.match(html, /sample\.Department scalar fields/u);
    assert.match(html, /<td colspan="2"><em>No matching entity<\/em><\/td>/u);
    assert.match(html, /<td>Sales<\/td>/u);
  } finally {
    client.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});

test('the JPQL review displays the provider-attributed entity fields and ties execution to its exact projection', async () => {
  const registered = new Map(), calls = [], notices = [];
  let changed = false, pane;
  const document = { languageId: 'rocketbrain-jpql', version: 1, getText: () => query };
  const vscode = { ViewColumn: { Beside: 2 }, window: {
    activeTextEditor: { document, selection: { isEmpty: true } },
    showQuickPick: async choices => choices[0],
    showInputBox: async () => '9',
    showWarningMessage: async (_message, options, approve) => {
      notices.push(options.detail);
      if (changed) document.version++;
      return approve;
    },
    createWebviewPanel: () => {
      pane = { webview: {}, onDidDispose() {}, dispose() {} };
      return pane;
    }
  } };
  const view = registerJpaConsole(vscode, { source: () => {}, command: (id, handler) => registered.set(id, handler),
    target: () => ({ factories: [{ id: factoryId }], assertCurrent() {}, client: {
      describeSelect: async () => described,
      select: async (...args) => { calls.push(args); return executed; }
    } }) });
  const run = registered.get('rocketbrain.jpa.console.run');
  changed = true;
  await assert.rejects(run(), { code: 'STALE' });
  assert.equal(calls.length, 0);
  changed = false;
  assert.equal((await run()).view, 'rocketbrain.jpql.result');
  assert.deepEqual(calls[0], [query, factoryId, { __proto__: null, ':wanted': '9' }, 25, review]);
  assert.match(notices[0], /sample\.Department scalar fields\nd\.id · java\.lang\.Long\nd\.name · java\.lang\.String/u);
  assert.doesNotMatch(notices[0], new RegExp(review, 'u'));
  assert.match(pane.webview.html, /No matching entity/u);
  view.clear();
});
