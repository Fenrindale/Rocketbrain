'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { normalizeOpenBao, readOpenBaoPassword, reviewedEndpoint } = require('../src/db/openbao-credential');
const { normalizeProfile } = require('../src/db/connection-profiles');
const { promptProfileCredentials } = require('../src/db/connection-profiles-vscode');

const base = { kind: 'openbao-kv2', origin: 'https://bao.example.test:8200', mount: 'kv', secretPath: 'databases/project', field: 'password' };

test('OpenBao references normalize one exact destination and forbid embedded credentials', () => {
  const normalized = normalizeOpenBao({ ...base, origin: base.origin + '/' });
  assert.deepEqual(normalized, base);
  assert.equal(reviewedEndpoint(normalized), 'https://bao.example.test:8200/v1/kv/data/databases/project');
  for (const changed of [{ origin: 'http://example.test:8200' }, { origin: 'http://127.1:8200' }, { origin: 'https://account@bao.example.test' },
    { origin: 'https://bao.example.test/namespace' }, { origin: 'https://bao.example.test?version=2' }, { origin: 'https://bao.example.test#path' },
    { mount: 'secret/data' }, { secretPath: 'directory/../other' }, { secretPath: 'directory%2fother' }, { secretPath: '/absolute' },
    { field: 'secret/key' }, { password: 'synthetic-auth-input' }, { token: 'synthetic-auth-input' }]) {
    assert.throws(() => normalizeOpenBao({ ...base, ...changed }), { code: 'ROCKETBRAIN_OPENBAO_INPUT' });
  }
  assert.deepEqual(normalizeOpenBao({ kind: base.kind }, { allowUnconfigured: true }), { kind: base.kind });
  const profile = normalizeProfile({ name: 'Managed fixture', host: '127.0.0.1', port: 3306, user: 'fixture', database: 'app', auth: base });
  assert.deepEqual(profile.auth, base);
});

test('OpenBao request sends one scoped token and rejects redirects and cancellation', async () => {
  const observed = [];
  let onStarted;
  const started = new Promise(resolve => { onStarted = resolve; });
  const server = http.createServer((request, response) => {
    observed.push({ url: request.url, method: request.method, authority: Boolean(request.headers['x-vault-token']) });
    if (request.url === '/v1/kv/data/databases/project') {
      response.writeHead(302, { Location: '/offscope' }); response.end();
    } else if (request.url === '/v1/kv/data/databases/cancel') onStarted();
    else response.end('{}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const local = { ...base, origin: 'http://127.0.0.1:' + server.address().port };
    await assert.rejects(readOpenBaoPassword(local, 'synthetic-opaque-input'), { code: 'ROCKETBRAIN_OPENBAO_REDIRECT' });
    assert.deepEqual(observed, [{ url: '/v1/kv/data/databases/project', method: 'GET', authority: true }]);
    const controller = new AbortController();
    const pending = readOpenBaoPassword({ ...local, secretPath: 'databases/cancel' }, 'synthetic-opaque-input', controller.signal);
    pending.catch(() => {});
    await started;
    controller.abort();
    await assert.rejects(pending, { code: 'ROCKETBRAIN_OPENBAO_CANCELLED' });
    assert.equal(observed.length, 2);
  } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
});

test('OpenBao connection prompts only for the transient authority and shows the exact path', async () => {
  const calls = [], profile = { name: 'Managed fixture', tls: { mode: 'disabled' }, auth: base };
  const vscode = { window: { async showInputBox(options) { calls.push(options); return 'synthetic-opaque-input'; } } };
  assert.deepEqual(await promptProfileCredentials(vscode, { profile, hasSavedPassword: false }), { openBaoToken: 'synthetic-opaque-input' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].password, true);
  assert.match(calls[0].prompt, /https:\/\/bao\.example\.test:8200\/v1\/kv\/data\/databases\/project/);
  assert.equal(await promptProfileCredentials({ window: { showInputBox: async () => undefined } }, { profile }), null);
});
