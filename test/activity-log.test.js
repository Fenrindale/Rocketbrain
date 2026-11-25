'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createActivityLog, operationOf, outcomeOf, driverActivity } = require('../src/db/activity-log');
const { logHtml, registerSqlActivity, HISTORY } = require('../src/db/activity-log-vscode');
const { MysqlService } = require('../src/db/mysql');
const { browserRuntime } = require('./helpers/browser-runtime');

test('SQL activity is opt-in, scoped and redacts by construction', () => {
  let allowed = true;
  const log = createActivityLog({ canRecord: () => allowed });
  const report = log.createReporter();
  const session = { id: 'secret sql editor identifier', password: 'secret db password' };
  const hint = { category: 'query', operation: 'SELECT', sql: "SELECT 'secret literal'", values: ['secret bound value'] };
  assert.equal(report(session, hint), undefined);
  assert.deepEqual(log.snapshot().entries, []);
  log.setEnabled(true);
  const succeed = report(session, hint);
  const entry = log.snapshot().entries[0];
  assert.equal(entry.status, 'running');
  assert.equal(entry.durationMs, null);
  succeed('succeeded');
  succeed('failed');
  let snapshot = log.snapshot();
  assert.ok(snapshot.entries[0].durationMs >= 0);
  assert.equal(snapshot.entries[0].status, 'succeeded');
  assert.match(snapshot.entries[0].id, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|literal|password|sql editor/);
  assert.equal(report(session, { category: 'secret category' }), undefined);
  report(session, { ...hint, operation: 'secret verb' })('succeeded');
  snapshot = log.snapshot();
  assert.equal(snapshot.entries[0].operation, 'SQL');
  assert.equal(snapshot.entries[0].session, entry.session);
  assert.equal(snapshot.entries[0].connection, entry.connection);
  assert.notEqual(snapshot.entries[0].id, entry.id);
  snapshot.entries[0].status = 'edited';
  assert.equal(log.snapshot().entries[0].status, 'succeeded');
  allowed = false;
  assert.equal(report(session, hint), undefined);
  assert.equal(log.snapshot().available, false);
  assert.deepEqual(log.snapshot().entries, []);
});

test('SQL activity keeps a bounded newer-first buffer and clears in-flight retention', () => {
  const log = createActivityLog({ enabled: true });
  const active = log.createReporter();
  const session = {}, hint = { category: 'query', operation: 'SELECT' };
  const oldest = active(session, hint);
  const firstId = log.snapshot().entries[0].id;
  for (let index = 0; index < 405; index++) active(session, hint)('succeeded');
  oldest('cancelled');
  assert.equal(log.snapshot().entries.length, 400);
  assert.equal(log.snapshot().dropped, 6);
  assert.ok(log.snapshot().entries.every(row => row.id !== firstId));
  const unfinished = active(session, hint);
  log.clear();
  unfinished('succeeded');
  assert.equal(log.snapshot().dropped, 0);
  assert.deepEqual(log.snapshot().entries, []);
  const closing = active(session, hint);
  log.setEnabled(false);
  log.setEnabled(true);
  closing('succeeded');
  assert.deepEqual(log.snapshot().entries, []);
  log.dispose();
  assert.equal(active(session, hint), undefined);
});

test('SQL activity retains schema and account action through large internal catalog bursts', () => {
  const log = createActivityLog({ enabled: true }), report = log.createReporter(), session = {};
  report(session, { category: 'schema', operation: 'CREATE' })('succeeded');
  report(session, { category: 'authorization', operation: 'GRANT' })('failed');
  for (let index = 0; index < 750; index++) {
    report(session, { category: 'metadata', operation: 'SELECT' })('succeeded');
    report(session, { category: 'session', operation: 'DO' })('succeeded');
  }
  let snapshot = log.snapshot();
  assert.equal(snapshot.entries.length, 102);
  assert.equal(snapshot.dropped, 1400);
  assert.deepEqual(snapshot.entries.slice(-2).map(row => row.category), ['authorization', 'schema']);
  for (let index = 0; index < 398; index++) report(session, { category: 'query', operation: 'SELECT' })('succeeded');
  assert.equal(report(session, { category: 'metadata', operation: 'SELECT' }), undefined);
  snapshot = log.snapshot();
  assert.equal(snapshot.entries.length, 400);
  assert.equal(snapshot.dropped, 1501);
  assert.deepEqual(snapshot.entries.slice(-2).map(row => row.category), ['authorization', 'schema']);
});

test('activity statuses and metadata verbs accept only the fixed output schema', () => {
  assert.equal(operationOf(' SELECT secret FROM db'), 'SELECT');
  assert.equal(operationOf('SHOW CREATE TABLE secret'), 'SHOW');
  assert.equal(operationOf('a_secret_name something'), 'SQL');
  assert.equal(operationOf('EXPLAIN FORMAT=JSON SELECT x'), 'EXPLAIN');
  assert.equal(outcomeOf('ROCKETBRAIN_TIMEOUT'), 'timeout');
  assert.equal(outcomeOf('ROCKETBRAIN_RESULT_LIMIT'), 'limited');
  assert.equal(outcomeOf('ROCKETBRAIN_CANCELLED'), 'cancelled');
  assert.equal(outcomeOf('PRIVATE_SERVER_ERROR'), 'failed');
  assert.equal(outcomeOf(undefined), 'succeeded');
  assert.equal(outcomeOf(undefined, true), 'limited');
  assert.deepEqual(driverActivity("CREATE USER 'private name' IDENTIFIED BY 'secret'"), { category: 'authorization', operation: 'CREATE' });
  assert.deepEqual(driverActivity('CREATE TABLE private_name(a int)'), { category: 'schema', operation: 'CREATE' });
  assert.deepEqual(driverActivity('GRANT SELECT ON secret TO secret'), { category: 'authorization', operation: 'GRANT' });
  assert.deepEqual(driverActivity('START TRANSACTION READ ONLY'), { category: 'session', operation: 'START' });
  assert.deepEqual(driverActivity('SELECT name FROM INFORMATION_SCHEMA.TABLES'), { category: 'metadata', operation: 'SELECT' });
});

test('workspace retention is separately opted in, restored on reactivation, cleared and scoped', async () => {
  const values = new Map();
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{}] }, commands: { registerCommand() { return { dispose() {} }; } } };
  const workspace = { get: key => structuredClone(values.get(key)), async update(key, value) { values.set(key, structuredClone(value)); } };
  const open = (state = workspace) => registerSqlActivity({ workspaceState: state, subscriptions: [] }, vscode);
  let log = open();
  assert.equal(log.snapshot().enabled, false);
  await assert.rejects(log.setRetention('workspace'), /Enable SQL Activity/);
  await log.setEnabled(true);
  const session = {};
  log.createReporter()(session, { category: 'schema', operation: 'CREATE' })('succeeded');
  await log.flush();
  assert.equal(values.has(HISTORY), false);
  await log.setRetention('workspace');
  log.createReporter()(session, { category: 'authorization', operation: 'CREATE' });
  await log.flush();
  assert.equal(values.get(HISTORY).entries.length, 2);
  assert.equal(values.get(HISTORY).entries[0].status, 'running');
  await log.dispose();

  const stored = values.get(HISTORY);
  stored.entries[0].unexpected = 'secret transport identity';
  stored.entries.push({ ...stored.entries[0], id: 'definitely not an activity UUID' });
  log = open();
  assert.equal(log.snapshot().retention, 'workspace');
  assert.deepEqual(log.snapshot().entries.map(row => row.status), ['interrupted', 'succeeded']);
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /secret transport/);
  vscode.workspace.isTrusted = false;
  assert.deepEqual(log.snapshot().entries, []);
  await assert.rejects(log.clear(), /trusted workspace/);
  vscode.workspace.isTrusted = true;
  await log.clear();
  assert.deepEqual(values.get(HISTORY).entries, []);
  log.createReporter()(session, { category: 'session', operation: 'COMMIT' })('succeeded');
  await log.setRetention('temporary');
  assert.equal(values.get(HISTORY), undefined);
  assert.equal(log.snapshot().entries.length, 1);
  await log.setRetention('workspace');
  await log.setEnabled(false);
  assert.deepEqual(values.get(HISTORY).entries, []);
  await log.dispose();
  const separate = open({ get() {}, async update() {} });
  assert.deepEqual(separate.snapshot().entries, []);
  assert.equal(separate.snapshot().retention, 'temporary');
  await separate.dispose();
});

test('SQL dispatch still settles when a logging backend fails to persist', async () => {
  const data = new Map();
  let fail = false;
  const workspaceState = { get: key => data.get(key), async update(key, value) {
    if (fail && key === HISTORY) throw Error('storage unavailable');
    data.set(key, value);
  } };
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{}] }, commands: { registerCommand() { return { dispose() {} }; } } };
  const log = registerSqlActivity({ workspaceState, subscriptions: [] }, vscode);
  await log.setEnabled(true);
  await log.setRetention('workspace');
  const service = new MysqlService({ host: 'localhost', database: 'fixture', user: 'tester', password: 'private' },
    { reportActivity: log.createReporter() });
  fail = true;
  const session = { connection: { query(_sql, callback) { callback(null, { affectedRows: 1 }); } } };
  assert.equal((await service._control(session, "CREATE USER 'private' IDENTIFIED BY 'secret'")).affectedRows, 1);
  await assert.rejects(log.flush(), /storage unavailable/);
  assert.equal(log.snapshot().persistenceFailure, true);
  assert.equal(log.snapshot().entries[0].category, 'authorization');
  assert.equal(log.snapshot().entries[0].status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /private|secret/);
  fail = false;
  await log.flush();
  assert.equal(log.snapshot().persistenceFailure, false);
  assert.equal(data.get(HISTORY).entries[0].id, log.snapshot().entries[0].id);
  await log.dispose();
  await service.dispose();
});

test('MySQL transport records only requests that reach the driver and hides driver errors and binding values', async () => {
  const log = createActivityLog({ enabled: true });
  const activity = log.createReporter();
  const service = new MysqlService({ host: 'localhost', database: 'test', user: 'tester', password: 'private' }, { reportActivity: activity });
  const hint = { category: 'script', operation: 'SELECT' }, limits = { maxRows: 10, timeoutMs: 3000 };
  const state = { connection: {
    execute() {
      const query = new EventEmitter();
      queueMicrotask(() => query.emit('error', Object.assign(Error('secret server error'), { code: 'SECRET_ERROR' })));
      return query;
    },
    query() { throw Error('secret before dispatch failure'); }
  } };
  const result = service._stream(state, 'SELECT ?', ['secret parameter'], limits, false, hint);
  assert.equal(log.snapshot().entries[0].status, 'running');
  await assert.rejects(result);
  assert.equal(log.snapshot().entries[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /secret|SECRET_ERROR|private/);
  await assert.rejects(service._stream(state, 'SELECT 1', [], limits, false, { category: 'query', operation: 'SELECT' }));
  assert.equal(log.snapshot().entries.length, 1);
  await service.dispose();
});

const runtime = browserRuntime();
test('SQL Activity Webview handles explicit opt-in and filters category, status and connection', { skip: runtime.skip, timeout: 30000 }, async () => {
  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 800 } });
    await page.route('https://activity.local/', route => route.fulfill({ contentType: 'text/html', body: logHtml('activity-test') }));
    await page.addInitScript(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: value => window.messages.push(value) });
    });
    await page.goto('https://activity.local');
    const snapshot = value => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', value: data } })), value);
    await snapshot({ enabled: false, available: true, entries: [], limit: 400, dropped: 0 });
    await page.getByRole('button', { name: 'Enable for workspace' }).click();
    const log = createActivityLog({ enabled: true }), one = log.createReporter(), two = log.createReporter();
    one({}, { category: 'query', operation: 'SELECT' })('succeeded');
    one({}, { category: 'metadata', operation: 'SELECT' })('succeeded');
    two({}, { category: 'script', operation: 'UPDATE' })('failed');
    await snapshot(log.snapshot());
    await page.getByRole('checkbox', { name: 'Keep history in this workspace' }).check();
    assert.equal(await page.locator('tbody tr').count(), 3);
    await page.getByLabel('Category').selectOption('script');
    assert.equal(await page.locator('tbody tr').count(), 1);
    assert.match(await page.locator('tbody tr').innerText(), /UPDATE/);
    await page.getByLabel('Status').selectOption('succeeded');
    assert.equal(await page.locator('tbody tr').count(), 0);
    await page.getByLabel('Category').selectOption('');
    await page.getByLabel('Connection').selectOption(log.snapshot().entries[1].connection);
    assert.equal(await page.locator('tbody tr').count(), 2);
    await page.getByRole('button', { name: 'Clear log' }).click();
    await page.getByRole('button', { name: 'Disable and clear' }).click();
    assert.deepEqual(await page.evaluate(() => window.messages),
      [{ type: 'ready' }, { type: 'enable' }, { type: 'retention', value: 'workspace' }, { type: 'clear' }, { type: 'disable' }]);
  } finally { await browser.close(); }
});
