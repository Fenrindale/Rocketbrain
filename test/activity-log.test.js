'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createActivityLog, operationOf, outcomeOf } = require('../src/db/activity-log');
const { logHtml } = require('../src/db/activity-log-vscode');
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
  const session = {}, hint = { category: 'metadata', operation: 'SELECT' };
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
      [{ type: 'ready' }, { type: 'enable' }, { type: 'clear' }, { type: 'disable' }]);
  } finally { await browser.close(); }
});
