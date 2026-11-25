'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { projectSchema, prepareLocalSqlRequest, executeLocalSqlRequest } = require('../src/db/local-sql-assistant');
const { normalizeLocalChatTarget: normalizeTarget, cancelled } = require('../src/ai/local-chat');
const { registerLocalSqlAssistant } = require('../src/db/local-sql-assistant-vscode');

const marker = 'PRIVATE-GENERATED-FIXTURE';
const catalog = { semanticContextObserved: true, database: 'fixture', dialect: 'mysql', sqlMode: [], password: marker,
  coverage: { tables: 'loaded', columns: 'loaded' }, tables: [
    { name: 'people', kind: 'table', comment: marker, columns: [{ name: 'id', type: 'BIGINT UNSIGNED', primaryKey: true },
      { name: 'name', type: `enum('public', '${marker}')`, nullable: true, defaultValue: marker }, { name: 'unselected', type: 'text' } ],
    foreignKeys: [{ name: marker, referencedSchema: 'fixture', referencedTable: 'departments', columns: [
      { name: 'id', referencedColumn: 'person_id', ordinal: 1 }] }] },
    { name: 'departments', kind: 'table', columns: [{ name: 'person_id', type: 'bigint' }] },
    { name: 'private_view', kind: 'view', columns: [{ name: 'private_value', type: 'text' }] }
  ] };
const selections = [{ table: 'people', columns: ['id', 'name'] }];
const sql = 'SELECT name FROM people ORDER BY name';
const endpoint = 'http://127.0.0.1:9001/v1/chat/completions';
const draft = options => prepareLocalSqlRequest({ endpoint, model: 'fixture-model', catalog, selections, mode: 'draft',
  input: 'List names alphabetically.', ...options });

function jsonReply(response, answer) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }] }));
}

async function server(handler) {
  const active = http.createServer(handler);
  await new Promise((resolve, reject) => { active.once('error', reject); active.listen(0, '127.0.0.1', resolve); });
  return { endpoint: `http://127.0.0.1:${active.address().port}/v1/chat/completions`, close: () => {
    active.closeAllConnections();
    return new Promise(resolve => active.close(resolve));
  } };
}

test('local model configuration has an exact numeric loopback destination', () => {
  assert.equal(normalizeTarget(endpoint, 'Qwen/coder:v1').host, '127.0.0.1');
  assert.equal(normalizeTarget('http://[::1]:9001/v1/chat/completions', 'coder').host, '::1');
  for (const rejected of [endpoint.replace('127.0.0.1', 'localhost'), endpoint.replace('127.0.0.1', '192.0.2.1'),
    endpoint.replace('http:', 'https:'), endpoint.replace('http://', 'http://private@'), endpoint + '?proxy=1',
    endpoint + '#fragment', endpoint.replace('9001', '65537'), endpoint.replace('/v1/chat/completions', '/admin')]) {
    assert.throws(() => normalizeTarget(rejected, 'coder'), /loopback/);
  }
});

test('schema context projection includes explicit metadata and only complete selected relationships', () => {
  const scope = projectSchema(catalog, [...selections, { table: 'departments', columns: ['person_id'] }]);
  assert.deepEqual(scope.context.tables[0].columns[1], { name: 'name', type: 'enum', nullable: true, primaryKey: false });
  assert.deepEqual(scope.context.relationships, [{ table: 'people', columns: ['id'], referencedTable: 'departments', referencedColumns: ['person_id'] }]);
  for (const privateValue of [marker, 'unselected', 'private_value', 'private_view', 'password']) {
    assert.ok(!JSON.stringify(scope.context).includes(privateValue));
  }
  assert.deepEqual(projectSchema(catalog, selections).context.relationships, []);
  assert.throws(() => projectSchema(catalog, [{ table: 'private_view', columns: ['private_value'] }]), /visible columns/);
  assert.throws(() => projectSchema({ ...catalog, semanticContextObserved: false }, selections), /observed SQL modes/);
});

test('SQL explanation uses the approved identifiers and redacts source literals, constants, comments and aliases', () => {
  const input = `SELECT name AS \`${marker}\` FROM people WHERE name <> '${marker}' AND id > 123456789 /* ${marker} */;`;
  const prepared = draft({ mode: 'explain', input });
  assert.equal(prepared.preview.sql, 'SELECT name AS alias_1 FROM people WHERE name <> ? AND id > ? ;');
  assert.ok(!JSON.stringify(prepared.payload).includes(marker));
  assert.ok(!JSON.stringify(prepared.payload).includes('123456789'));
  for (const rejected of ['SELECT * FROM people', 'SELECT p.* FROM people p', 'SELECT unselected FROM people',
    'SELECT id FROM departments', 'SELECT id FROM other.people', 'SELECT id FROM people; SELECT id FROM people',
    'DELETE FROM people', 'SELECT SLEEP(30) FROM people', 'SELECT name FROM people INTO OUTFILE \'secret\'']) {
    assert.throws(() => draft({ mode: 'explain', input: rejected }));
  }
  assert.ok(draft({ mode: 'explain', input: 'SELECT COUNT(*) FROM people' }).preview.sql.includes('COUNT'));
});

test('cancelling an active local request aborts the model connection', async () => {
  let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  const api = await server((request, _response) => { request.resume(); request.on('end', arrived); });
  try {
    const control = new AbortController();
    const pending = executeLocalSqlRequest(draft({ endpoint: api.endpoint }), { signal: control.signal });
    await received;
    control.abort();
    await assert.rejects(pending, error => error.code === cancelled);
  } finally { await api.close(); }
});

test('the loopback transport rejects unsafe model SQL, redirects and oversized responses', async () => {
  let mode = 'allow', redirected = 0;
  const api = await server((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, undefined);
    if (request.url !== '/v1/chat/completions') { redirected++; response.writeHead(404).end(); return; }
    request.resume();
    request.on('end', () => {
      if (mode === 'redirect') { response.writeHead(307, { Location: '/moved' }).end(); return; }
      if (mode === 'huge') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('x'.repeat(65537)); return; }
      jsonReply(response, { sql: mode === 'allow' ? sql : mode, explanation: 'Lists names.' });
    });
  });
  try {
    const run = () => executeLocalSqlRequest(draft({ endpoint: api.endpoint }));
    assert.equal((await run()).execution, 'not-run');
    for (const rejected of ['SELECT * FROM people', 'SELECT unselected FROM people', 'DROP TABLE people', 'redirect', 'huge']) {
      mode = rejected;
      await assert.rejects(run);
    }
    assert.equal(redirected, 0);
  } finally { await api.close(); }
});

test('the actual command requires exact outbound preview consent and opens a draft without SQL execution', async () => {
  let requests = 0;
  const api = await server((request, response) => {
    requests++;
    const parts = [];
    request.on('data', chunk => parts.push(chunk));
    request.on('end', () => {
      const data = JSON.parse(Buffer.concat(parts));
      assert.deepEqual(JSON.parse(data.messages[1].content), approved);
      jsonReply(response, { sql, explanation: 'Lists names.' });
    });
  });
  const subscriptions = [], commands = new Map(), errors = [], opened = [];
  let approved, selection = 'decline', databaseChanged;
  const vscode = { ProgressLocation: { Notification: 17 }, ViewColumn: { Beside: -2 }, commands: {
    registerCommand(id, action) { commands.set(id, action); return { dispose() {} }; }
  }, workspace: { isTrusted: true, getConfiguration: () => ({ get: key => key === 'endpoint' ? api.endpoint : 'fixture-model' }),
    onDidChangeConfiguration: () => ({ dispose() {} }), openTextDocument: async document => document }, window: {
    showInputBox: async () => 'List names alphabetically.',
    showQuickPick: async (items, options) => options.title.startsWith('Choose Schema') ? [items[0]] : ['id', 'name'],
    showInformationMessage: async (_message, options) => {
      approved = JSON.parse(options.detail.slice(options.detail.indexOf('\n\n') + 2));
      if (selection === 'stale') databaseChanged();
      return selection === 'decline' ? undefined : 'Send to Local Model';
    }, showErrorMessage: async message => errors.push(message), showTextDocument: async document => opened.push(document),
    withProgress: async (_options, work) => work({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
  } };
  try {
    registerLocalSqlAssistant({ subscriptions }, vscode, { liveCatalogSnapshot: () => catalog,
      onDidChangeDatabase(listener) { databaseChanged = listener; return { dispose() {} }; } });
    const start = commands.get('rocketbrain.localSqlAssistant.draft');
    await start();
    assert.equal(requests, 0);
    selection = 'stale';
    await start();
    assert.equal(requests, 0);
    assert.match(errors.at(-1), /changed/);
    selection = 'accept';
    assert.equal((await start()).execution, 'not-run');
    assert.equal(requests, 1);
    assert.deepEqual(opened.map(document => document.language), ['sql', 'plaintext']);
    assert.ok(opened[0].content.includes(sql));
  } finally {
    subscriptions.forEach(item => item.dispose());
    await api.close();
  }
});
