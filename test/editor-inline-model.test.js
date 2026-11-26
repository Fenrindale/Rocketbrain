'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { inlineContext, requestInlineModel } = require('../src/ai/editor-model');
const { inlineWorkstation } = require('./helpers/editor-inline-host');

const answer = (insertion, options = {}) => ({ choices: [
  { finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ insertion }) }, ...options }
] });

test('inline context takes only bounded adjacent source without breaking UTF-16 pairs', () => {
  const prefix = 'hidden' + '😺' + 'x'.repeat(1599);
  const suffix = 'z'.repeat(399) + '😺hidden';
  const snippet = inlineContext(prefix + suffix, prefix.length, 'java');
  assert.deepEqual(snippet, { language: 'java', prefix: 'x'.repeat(1599), suffix: 'z'.repeat(399) });
  assert.throws(() => inlineContext('😺', 1, 'java'), /character boundary/);
  assert.throws(() => inlineContext('a'.repeat(512 * 1024 + 1), 1, 'java'), /text limit/);
});

test('inline model accepts one structured insertion and sends only the approved fields', async () => {
  const scope = { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'owned' };
  const source = { language: 'java', prefix: 'return ', suffix: ';', file: 'private-file.java' };
  const request = async (_target, body) => {
    assert.deepEqual(JSON.parse(body.messages[1].content), { language: 'java', prefix: 'return ', suffix: ';' });
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.max_tokens, 96);
    return answer('42');
  };
  assert.equal(await requestInlineModel(scope, source, { request }), '42');
  assert.equal(await requestInlineModel(scope, source, { request: async () => answer('42;') }), '42');
  for (const value of ['', ';', '```java\n42\n```']) {
    assert.equal(await requestInlineModel(scope, source, { request: async () => answer(value) }), '');
  }
  await assert.rejects(requestInlineModel(scope, source, { request: async () => answer('42', { finish_reason: 'length' }) }),
    /complete insertion/);
  await assert.rejects(requestInlineModel(scope, { ...source, prefix: 'a'.repeat(1601) }, { request }), /exceeds its limits/);
  await assert.rejects(requestInlineModel({ ...scope, endpoint: 'http://192.0.2.1:1234/v1/chat/completions' }, source, { request }), /loopback/);
});

test('registered inline provider requires active file consent and suppresses stale or cancelled proposals', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-inline-model-'));
  const file = path.join(root, 'Answer.java');
  const prefix = '// concealed-head\n' + '/'.repeat(1600) + '\nclass Answer { int answer() { return ';
  const suffix = '; } }\n' + ' '.repeat(400) + 'concealed-tail';
  await fs.writeFile(file, prefix + suffix, { flag: 'wx' });
  const records = [];
  let reply, received;
  const server = createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const value of request) parts.push(value);
      records.push(JSON.parse(Buffer.concat(parts)));
      received?.();
      if (reply) await reply;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer('42')));
    } catch { /* Cancellation can close the owned test socket. */ }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions', model: 'owned' };
  const host = inlineWorkstation(root, file, prefix + suffix, settings);
  host.setCursor(prefix.length);
  t.after(async () => {
    host.codeModel.dispose();
    await new Promise(resolve => server.close(resolve));
    await fs.unlink(file);
    await fs.rmdir(root);
  });
  assert.deepEqual(await host.complete(), []);
  host.vscode.window.approve = false;
  assert.equal(await host.invoke('enableInline'), false);
  assert.deepEqual(await host.complete(), []);
  assert.equal(records.length, 0);
  host.vscode.window.approve = true;
  assert.equal(await host.invoke('enableInline'), true);
  assert.match(host.prompts.at(-1).detail, /Answer\.java/);
  const [suggestion] = await host.complete();
  assert.equal(suggestion.insertText, '42');
  assert.equal(suggestion.range.start.offset, prefix.length);
  assert.equal(suggestion.range.isEmpty, true);
  assert.equal(host.document.getText(), prefix + suffix);
  for (const marker of ['concealed-head', 'concealed-tail', 'Answer.java']) assert.ok(!JSON.stringify(records).includes(marker));

  let release;
  reply = new Promise(resolve => { release = resolve; });
  const requestReceived = new Promise(resolve => { received = resolve; });
  const stale = host.complete();
  await requestReceived;
  host.document.version++;
  host.emit('text', { document: host.document });
  release();
  assert.deepEqual(await stale, []);
  settings.model = 'changed';
  assert.deepEqual(await host.complete(), []);
  host.emit('close', host.document);
  settings.model = 'owned';
  assert.deepEqual(await host.complete(), []);
  let grant;
  const approval = host.codeModel.inline.approve(host.document, () => new Promise(resolve => { grant = resolve; }));
  await host.invoke('disableInline');
  grant(true);
  await assert.rejects(approval, /scope again/);
  assert.deepEqual(await host.complete(), []);
  assert.equal(records.length, 2);
});
