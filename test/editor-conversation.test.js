'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const { digest } = require('../src/ai/editor-conversation');
const { conversationHost } = require('./helpers/editor-conversation-host');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-editor-conversation-'));
  const requests = [];
  const state = { respond: response => response.end(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Observed answer' } }]
  })) };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.setHeader('Content-Type', 'application/json');
    state.respond(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const settings = { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions', model: 'sample-model' };
  const host = conversationHost(root, settings);
  const { file } = host.vscode.Uri;
  const anchor = file(path.join(root, 'Endpoint.java'));
  const other = file(path.join(root, 'Facts.java'));
  const omitted = file(path.join(root, 'Excluded.java'));
  const contents = ['class Endpoint { String route() { return Facts.MARKER; } }', 'class Facts { static String MARKER = "한글"; }'];
  await Promise.all([
    fs.writeFile(anchor.fsPath, contents[0]), fs.writeFile(other.fsPath, contents[1]),
    fs.writeFile(omitted.fsPath, 'UNSELECTED-FILE-MARKER')
  ]);
  host.openFile(anchor);
  host.inputs.files = [anchor, other];
  host.inputs.question = 'What does the endpoint return?';
  t.after(async () => {
    host.conversation.dispose();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { host, anchor, other, root, requests, state, settings, contents };
}

test('registered workspace conversation commands send exactly the reviewed saved files and approved history', async t => {
  const { host, anchor, requests, contents } = await setup(t);
  const first = await host.invoke('startConversation');
  const review = host.review(first.uri);
  assert.equal(requests.length, 0);
  assert.deepEqual(review.context.map(row => row.path), ['Endpoint.java', 'Facts.java']);
  assert.deepEqual(review.context.map(row => row.sha256), contents.map(digest));
  assert.equal(review.payloadSha256, digest(JSON.stringify(review.request)));
  assert.ok(review.request.messages[1].content.includes('한글'));
  assert.ok(!JSON.stringify(review).includes('UNSELECTED-FILE-MARKER'));
  assert.ok(!JSON.stringify(review).includes(anchor.fsPath.replaceAll('\\', '\\\\')));
  host.inputs.approve = false;
  await host.invoke('sendConversation');
  assert.equal(requests.length, 0);
  host.inputs.approve = true;
  const sent = await host.invoke('sendConversation');
  assert.equal(sent.turn, 1);
  assert.match(host.transcript(sent.uri), /Observed answer/);
  assert.deepEqual(requests[0], review.request);
  await assert.rejects(host.conversation.send(first.sessionId, first.reviewId, { confirmed: true }), /unsent request/);

  host.openFile(anchor);
  host.inputs.question = 'Which earlier question did I ask?';
  const second = await host.invoke('continueConversation');
  const next = host.review(second.uri);
  assert.notEqual(second.reviewId, first.reviewId);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(requests.length, 1);
  assert.deepEqual(next.context, review.context);
  assert.deepEqual(next.request.messages.slice(-3), [
    { role: 'user', content: 'What does the endpoint return?' },
    { role: 'assistant', content: 'Observed answer' },
    { role: 'user', content: host.inputs.question }
  ]);
  const continued = await host.invoke('sendConversation');
  assert.equal(continued.turn, 2);
  assert.deepEqual(requests[1], next.request);
  assert.match(host.transcript(continued.uri), /Turn 1[\s\S]*Turn 2/);
  await host.invoke('closeConversation');
  assert.match(host.transcript(continued.uri), /closed/);
});

test('changed saved bytes, dirty buffers, model identity and invalid file selection stop a reviewed request', async t => {
  const { host, anchor, other, requests, settings, contents } = await setup(t);
  await assert.rejects(host.conversation.send('id', 'review', { confirmed: false }), /Confirm/);
  assert.throws(() => host.conversation.start(anchor, [anchor, anchor], 'Duplicate'), /distinct/);
  assert.throws(() => host.conversation.start(anchor, [anchor, host.vscode.Uri.file(path.dirname(anchor.fsPath) + '-outside.java')], 'Outside'), /same workspace/);
  const review = await host.invoke('startConversation');
  await fs.writeFile(other.fsPath, 'class Facts {}');
  await assert.rejects(host.invoke('sendConversation'), /saved context file changed/);
  assert.throws(() => host.conversation.continueTurn(review.sessionId, 'Continue'), /saved context file changed/);
  await fs.writeFile(other.fsPath, contents[1]);
  host.openFile(anchor);
  await host.invoke('startConversation');
  host.vscode.workspace.textDocuments.push({ uri: other, isDirty: true });
  await assert.rejects(host.invoke('sendConversation'), /Save all selected/);
  host.vscode.workspace.textDocuments.length = 0;
  host.openFile(anchor);
  const newTarget = await host.invoke('startConversation');
  settings.model = 'different-model';
  await assert.rejects(host.invoke('sendConversation'), /model changed/);
  assert.match(host.transcript(newTarget.uri), /closed/);
  assert.equal(requests.length, 0);
});

test('cancellation and changes in flight discard the model answer and keep it out of later prompts', async t => {
  const { host, anchor, other, requests, state, contents } = await setup(t);
  const draft = await host.invoke('startConversation');
  const abort = new AbortController();
  host.inputs.signal = abort.signal;
  const entered = Promise.withResolvers();
  state.respond = () => entered.resolve();
  const pending = assert.rejects(host.invoke('sendConversation'), /cancelled/);
  await entered.promise;
  abort.abort();
  await pending;
  host.inputs.signal = undefined;

  host.openFile(anchor);
  host.inputs.question = 'A different question';
  const second = await host.invoke('continueConversation');
  const next = host.review(second.uri);
  assert.equal(next.request.messages.length, 3);
  const waiting = Promise.withResolvers();
  state.respond = response => waiting.resolve(response);
  const changing = assert.rejects(host.invoke('sendConversation'), /saved context file changed/);
  const response = await waiting.promise;
  await fs.writeFile(other.fsPath, 'class Facts { String changed; }');
  response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Stale answer' } }] }));
  await changing;
  await fs.writeFile(other.fsPath, contents[1]);
  const third = host.conversation.continueTurn(draft.sessionId, 'Try again');
  assert.equal(host.review(third.uri).request.messages.length, 3);
  assert.equal(requests.length, 2);
});
