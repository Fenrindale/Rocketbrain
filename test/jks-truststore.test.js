'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { normalizeProfile, createConnectionProfiles } = require('../src/db/connection-profiles');
const { jksPassphrase } = require('../src/db/client-identity');
const { connectionHtml, promptProfileCredentials } = require('../src/db/connection-profiles-vscode');
const { browserRuntime } = require('./helpers/browser-runtime');

const tcp = { name: 'Owned trust profile', host: '127.0.0.1', user: 'tester', database: 'test' };
const tls = { mode: 'verify', serverName: 'database.fixture.local', serverTrust: 'jks', trustStorePath: path.resolve('root-ca.jks') };

test('JKS trust is explicit, local and independent from client identity', () => {
  const result = normalizeProfile({ ...tcp, tls: { ...tls, clientIdentity: 'pkcs12', pfxPath: path.resolve('client.p12') } });
  assert.equal(result.tls.serverTrust, 'jks');
  assert.equal(result.tls.trustStorePath, tls.trustStorePath);
  assert.equal(result.tls.clientIdentity, 'pkcs12');
  assert.throws(() => normalizeProfile({ ...tcp, tls: { ...tls, mode: 'disabled' } }), /requires verified TLS/);
  assert.throws(() => normalizeProfile({ ...tcp, tls: { ...tls, serverName: '' } }), /certificate DNS name/);
  assert.throws(() => normalizeProfile({ ...tcp, tls: { ...tls, caPath: path.resolve('another.pem') } }), /either a JKS/);
  assert.throws(() => normalizeProfile({ ...tcp, tls: { ...tls, trustStorePath: 'relative.jks' } }), /local absolute/);
  assert.throws(() => normalizeProfile({ ...tcp, tls: { ...tls, password: 'not-a-profile-field' } }), /unsupported fields/);
  assert.throws(() => jksPassphrase(undefined, true), /JKS truststore passphrase/);
  assert.throws(() => jksPassphrase('unbound', false), /Choose a JKS server truststore/);
  assert.throws(() => jksPassphrase('x'.repeat(16385), true), /under 16 KiB/);
});

test('portable JKS format retains only the trust kind and prompts separately for server and client material', async () => {
  const records = new Map();
  const manager = createConnectionProfiles({
    state: { get: (key, fallback) => records.get(key) ?? fallback, async update(key, value) { records.set(key, value); } },
    secrets: { get: async () => undefined, delete: async () => {}, store: async () => assert.fail('persistent trust secret') },
    isTrusted: () => true, connect: () => assert.fail('the unconfigured profile cannot connect'),
    createService: () => assert.fail('the unconfigured profile cannot connect')
  });
  try {
    const portable = { ...tcp, tls: { mode: 'verify', serverName: tls.serverName, serverTrust: 'jks' } };
    const template = { format: 'RocketbrainConnectionProfiles', version: 7, credentialsIncluded: false, profiles: [portable] };
    await assert.rejects(manager.importProfiles({ ...template, version: 6 }), /require format 7/);
    await assert.rejects(manager.importProfiles({ ...template, profiles: [{ ...portable, tls }] }), /Select local files/);
    await manager.importProfiles(template);
    const saved = manager.list()[0];
    assert.equal(saved.profile.tls.trustStorePath, '');
    assert.equal(manager.exportProfiles().version, 7);
    assert.deepEqual(manager.exportProfiles().profiles[0].tls, portable.tls);
    assert.deepEqual(manager.datasetProfileSource.list(), []);
    await assert.rejects(manager.connect({ id: saved.id, trustStorePassphrase: 'attempt' }), /Select a local JKS/);
    await assert.rejects(manager.datasetProfileSource.withProfile({ id: saved.id, revision: saved.revision }, () => assert.fail()),
      /without a JKS truststore passphrase/);
    const profile = { ...tcp, tls: { ...tls, clientIdentity: 'pkcs12', pfxPath: path.resolve('client.p12') } };
    const prompts = [], values = ['trust-attempt', 'key-attempt'];
    const vscode = { window: { async showInputBox(options) { prompts.push(options); return values.shift(); } } };
    const result = await promptProfileCredentials(vscode, { profile, hasSavedPassword: true });
    assert.deepEqual(result, { trustStorePassphrase: 'trust-attempt', clientIdentityPassphrase: 'key-attempt' });
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every(prompt => prompt.password && prompt.ignoreFocusOut));
    assert.match(prompts[0].prompt, /JKS truststore/u);
    assert.match(prompts[1].prompt, /Client identity/u);
    assert.equal(await promptProfileCredentials({ window: { showInputBox: async () => undefined } },
      { profile, hasSavedPassword: true }), null);
  } finally { await manager.dispose(); }
});

const browser = browserRuntime();
test('the connection editor sends JKS trust separately from PKCS#12 and clears both passphrases after submission', {
  skip: browser.skip, timeout: 30000
}, async t => {
  const chromium = await browser.chromium.launch({ executablePath: browser.executablePath, headless: true });
  t.after(() => chromium.close());
  const page = await chromium.newPage();
  const requests = [];
  await page.exposeFunction('submitTls', request => requests.push(request));
  await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.submitTls(message) }); });
  await page.setContent(connectionHtml(randomBytes(24).toString('hex')));
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  await send({ type: 'model', editorId: 'owned', profile: { ...tcp, port: 3306, color: 'none', tls: { mode: 'disabled' } } });
  await page.locator('#tls').selectOption('verify');
  await page.locator('#serverName').fill(tls.serverName);
  await page.locator('#caPath').fill('C:/legacy/ca.pem');
  await page.locator('#serverTrust').selectOption('jks');
  assert.equal(await page.locator('#caPath').isVisible(), false);
  await page.locator('#trustStorePath').fill(tls.trustStorePath);
  await page.locator('#trustStorePassphrase').fill('trust-this-attempt');
  await page.locator('#clientIdentity').selectOption('pkcs12');
  const client = path.resolve('client.p12');
  await page.locator('#pfxPath').fill(client);
  await page.locator('#clientPassphrase').fill('key-this-attempt');
  await page.locator('[data-action=test]').click();
  const request = requests.at(-1);
  assert.deepEqual(request.profile.tls, { ...tls, clientIdentity: 'pkcs12', pfxPath: client });
  assert.deepEqual([request.trustStorePassphrase, request.clientIdentityPassphrase], ['trust-this-attempt', 'key-this-attempt']);
  assert.equal(await page.locator('#trustStorePassphrase').inputValue(), '');
  assert.equal(await page.locator('#clientPassphrase').inputValue(), '');
  await send({ type: 'result', result: { database: 'test', serverVersion: '8.4', tls: true, serverTrust: 'jks' } });
  assert.match(await page.locator('#status').textContent(), /JKS CA trust/);
});
