'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { startStructuredBridge } = require('../src/ai/acp-structured-bridge');

test('the temporary loopback bridge sends one exact approved source and schema to the configured model', async () => {
  const payloads = [];
  const model = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"example":"fixture"}' } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const target = { endpoint: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: 'fixture-model' };
  const prompt = 'Use only this reviewed synthetic schema';
  const schema = { type: 'object', required: ['example'], additionalProperties: false, properties: { example: { type: 'string' } } };
  const bridge = await startStructuredBridge(target, { prompt, schema, name: 'owned_schema' });
  const call = (input, key = bridge.key) => fetch(bridge.baseURL + '/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  try {
    const body = { model: target.model, stream: true, tools: [{ type: 'unreviewed' }], messages: [
      { role: 'system', content: 'Follow the latest reviewed request literally. Extra unapproved data.' },
      { role: 'user', content: [{ type: 'text', text: prompt }] }
    ] };
    assert.equal((await call(body, 'not-authorized')).status, 404);
    assert.equal((await call({ ...body, model: 'not-approved' })).status, 422);
    assert.equal((await call({ ...body, messages: [{ role: 'user', content: prompt }] })).status, 422);
    assert.equal(payloads.length, 0);
    const accepted = await call(body);
    assert.equal(accepted.status, 200);
    const output = await accepted.text();
    assert.match(output, /"finish_reason":"stop"/);
    assert.match(output, /data: \[DONE\]/);
    assert.equal((await call(body)).status, 422);
    assert.equal(payloads.length, 1);
    const [sent] = payloads;
    assert.deepEqual(sent.response_format.json_schema, { name: 'owned_schema', schema, strict: true });
    assert.equal(sent.messages[1].content, prompt);
    assert.ok(!JSON.stringify(sent).includes('unapproved'));
    assert.ok(!Object.hasOwn(sent, 'tools'));
    assert.equal(sent.stream, false);
  } finally {
    await bridge.close();
    const closed = new Promise(resolve => model.close(resolve));
    model.closeAllConnections();
    await closed;
  }
});
