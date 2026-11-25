'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const { requestEditorModel, contextMessages, modelText, snapshotLocalEdit, applyLocalEditToText } = require('../src/ai/editor-model');

test('local model request carries the chosen source and returns the reviewed code block', async () => {
  const records = [];
  const server = http.createServer(async (request, response) => {
    const parts = [];
    for await (const piece of request) parts.push(piece);
    records.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(parts)) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '```java\nreturn 43;\n```' } }] }));
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  try {
    const answer = await requestEditorModel({ endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'owned-code',
      intent: 'Return 43', selection: 'return 42;', language: 'java', action: 'edit' });
    assert.equal(answer, 'return 43;');
    assert.equal(records.length, 1);
    assert.equal(records[0].method, 'POST');
    assert.equal(records[0].url, '/v1/chat/completions');
    assert.equal(records[0].body.model, 'owned-code');
    assert.equal(records[0].body.stream, false);
    const data = JSON.parse(records[0].body.messages.at(-1).content);
    assert.deepEqual(data, { question: 'Return 43', language: 'java', selectedSource: 'return 42;' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('snapshot edits reject unrelated source changes and retain text outside the selected range', () => {
  const original = 'class Test { int compute() { return 42; } }';
  const start = original.indexOf('return');
  const snap = snapshotLocalEdit(original, start, start + 'return 42;'.length);
  assert.equal(applyLocalEditToText(snap, original, 'return 43;'), original.replace('42', '43'));
  assert.throws(() => applyLocalEditToText(snap, original + '\n', 'return 43;'), /changed after review/);
  assert.throws(() => snapshotLocalEdit(original, 8, 4), /valid source range/);
});

test('incomplete answers and excessive source are rejected', () => {
  assert.throws(() => modelText({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, 'edit'), /complete answer/);
  assert.throws(() => contextMessages({ intent: 'inspect', selection: 'x'.repeat(13 * 1024), language: 'java', action: 'explain' }), /selection/);
});
