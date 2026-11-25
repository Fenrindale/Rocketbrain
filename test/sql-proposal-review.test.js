'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createSqlProposalReview, prepareSqlProposalBatch } = require('../src/db/sql-proposal-review');
const { registerSqlProposalReview } = require('../src/db/sql-proposal-review-vscode');

const catalog = { database: 'book', dialect: 'mysql', sqlMode: [], semanticContextObserved: true,
  coverage: { tables: 'loaded', columns: 'loaded' }, tables: [{ name: 'entries', kind: 'table',
    columns: [{ name: 'id', type: 'int' }, { name: 'private_note', type: 'text' }] }] };
const selections = [{ table: 'entries', columns: ['id'] }];
const requests = ['List the entry IDs ascending', 'List the entry IDs descending'];
const model = 'fixture';
const ascending = 'SELECT id FROM entries ORDER BY id ASC';
const descending = 'SELECT id FROM entries ORDER BY id DESC';
const base = { catalog, selections, requests, endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model };

function deferred() {
  let resolve;
  const promise = new Promise(callback => { resolve = callback; });
  return { promise, resolve };
}

test('previews the loopback route and shares only selected schema plus each independent request', () => {
  const prepared = prepareSqlProposalBatch(base);
  assert.deepEqual(prepared.preview.requests, requests);
  assert.equal(prepared.preview.schema.tables[0].columns[0].name, 'id');
  assert.equal(prepared.drafts.length, 2);
  for (const [i, draft] of prepared.drafts.entries()) {
    const payload = JSON.stringify(draft.payload);
    assert.ok(payload.includes(requests[i]));
    assert.ok(!payload.includes(requests[1 - i]));
    assert.ok(!payload.includes('private_note'));
  }
  for (const invalid of [[], [requests[0]], ['same', ' same '], ['', 'ok'], ['x'.repeat(1025), 'ok'],
    ['one', 'two', 'three', 'four']]) assert.throws(() => prepareSqlProposalBatch({ ...base, requests: invalid }), /different proposal requests/);
});

test('isolates job cancellation, result validation, exact review and stale scope', async () => {
  const slots = [deferred(), deferred(), deferred()];
  const signals = [];
  let cursor = 0;
  const review = createSqlProposalReview(prepareSqlProposalBatch({ ...base, requests: [...requests, 'List any private notes'] }),
    { infer: (_draft, { signal }) => { signals.push(signal); return slots[cursor++].promise; } });
  const complete = review.start();
  const { id, jobs } = review.snapshot();
  assert.deepEqual(jobs.map(job => job.status), ['running', 'running', 'running']);
  review.cancel(id, jobs[1].id);
  assert.deepEqual(signals.map(signal => signal.aborted), [false, true, false]);
  slots[0].resolve({ sql: ascending, explanation: 'Safe explanation' });
  slots[1].resolve({ sql: descending, explanation: 'Late result' });
  slots[2].resolve({ sql: 'SELECT private_note FROM entries', explanation: 'Unapproved column' });
  const result = await complete;
  assert.deepEqual(result.jobs.map(job => job.status), ['ready', 'cancelled', 'failed']);
  const [{ id: jobId, result: { fingerprint } }] = result.jobs;
  assert.throws(() => review.read(id, jobId, fingerprint, { reviewedOnly: true }), /no longer available/);
  assert.throws(() => review.accept(id, jobId, '0'.repeat(64)), /current SQL proposal/);
  review.accept(id, jobId, fingerprint);
  assert.equal(review.read(id, jobId, fingerprint, { reviewedOnly: true }).sql, ascending);
  review.reject(id, jobId, fingerprint);
  assert.throws(() => review.read(id, jobId, fingerprint), /no longer available/);
  review.invalidate();
  assert.ok(review.snapshot().jobs.every(job => job.status === 'stale' && !job.request && !job.result));
  await assert.rejects(review.start(), /already/);
});

test('closing or switching the scope aborts all active proposals and ignores late responses', async () => {
  const proposed = deferred(), signals = [];
  const review = createSqlProposalReview(prepareSqlProposalBatch(base), { infer: (_draft, { signal }) => {
    signals.push(signal);
    return proposed.promise;
  } });
  const running = review.start();
  review.invalidate();
  assert.ok(signals.every(signal => signal.aborted));
  proposed.resolve({ sql: ascending, explanation: 'Late response' });
  const state = await running;
  assert.ok(state.jobs.every(job => job.status === 'stale' && !job.result));
});

test('actual panel handlers bind approval to displayed SQL and never run it on the database', async t => {
  const seen = [], prompts = [ ...requests, '' ], documents = [], states = [], notices = [];
  const server = http.createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    seen.push(JSON.parse(data));
    const input = JSON.parse(seen.at(-1).messages[1].content);
    const sql = input.request === requests[0] ? ascending : descending;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ sql, explanation: '<script>ordinary text</script>' }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
  let open, message, disposed, changeScope, approveStart = false;
  const subscription = { dispose() {} };
  const panel = { webview: { postMessage: value => states.push(value), onDidReceiveMessage(listener) { message = listener; return subscription; } },
    onDidDispose(listener) { disposed = listener; return subscription; }, dispose() { disposed(); }, reveal() {} };
  const vscode = {
    ViewColumn: { Active: 1, Beside: 2 },
    commands: { registerCommand(_id, callback) { open = callback; return subscription; } },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: key => ({ endpoint, model })[key] }),
      onDidChangeConfiguration: () => subscription, async openTextDocument(doc) { documents.push(doc); return doc; } },
    window: {
      createWebviewPanel: () => panel,
      showInputBox: async () => prompts.shift(),
      showQuickPick: async values => values.slice(0, 1),
      async showInformationMessage(title, options, action) {
        notices.push({ title, options, action });
        return action === 'Start Proposals' && !approveStart ? undefined : action;
      },
      showErrorMessage: async () => {},
      showTextDocument: async () => {}
    }
  };
  const context = { subscriptions: [] };
  registerSqlProposalReview(context, vscode, { liveCatalogSnapshot: () => catalog,
    onDidChangeDatabase(listener) { changeScope = listener; return subscription; } });
  t.after(() => panel.dispose());
  open();
  assert.ok(panel.webview.html.includes("default-src 'none'"));
  assert.ok(!panel.webview.html.includes('entries'));
  async function until(check) {
    for (let attempt = 0; attempt < 100 && !check(); attempt++) await delay(20);
    assert.ok(check());
  }
  message({ type: 'start' });
  await until(() => notices.length && !states.at(-1).preparing);
  assert.equal(seen.length, 0);
  const preview = JSON.parse(notices[0].options.detail);
  assert.deepEqual(preview.requests, requests);
  approveStart = true;
  prompts.push(...requests, '');
  message({ type: 'start' });
  await until(() => states.at(-1)?.state?.jobs.every(job => job.status === 'ready'));
  assert.equal(seen.length, 2);
  const { id, jobs } = states.at(-1).state;
  const [first] = jobs;
  const selected = { reviewId: id, jobId: first.id, fingerprint: first.result.fingerprint };
  message({ type: 'open', ...selected });
  assert.equal(documents.length, 0);
  message({ type: 'accept', ...selected });
  await until(() => states.at(-1).state.jobs[0].status === 'reviewed');
  assert.equal(notices.at(-1).options.detail, first.result.sql);
  message({ type: 'open', ...selected });
  await until(() => documents.length === 1);
  assert.deepEqual(documents[0], { language: 'sql',
    content: '-- Reviewed local proposal for mysql schema book.\n' + first.result.sql + '\n' });
  changeScope();
  message({ type: 'open', ...selected });
  assert.ok(states.at(-1).state.invalidated);
  assert.equal(documents.length, 1);
});
