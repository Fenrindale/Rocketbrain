'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash, randomBytes } = require('node:crypto');
const { agentSelection, prepareAgentIdentity } = require('../src/db/connection-ssh-agent');
const { normalizeProfile } = require('../src/db/connection-profiles');
const { connectionHtml } = require('../src/db/connection-profiles-vscode');
const { browserRuntime } = require('./helpers/browser-runtime');

const windowsPipe = '\\\\.\\pipe\\rocketbrain-owned-agent';

test('explicit agent profiles admit only a local endpoint and separate public-key selection', () => {
  assert.deepEqual(agentSelection({ endpoint: windowsPipe, publicKeyPath: 'C:/temp/identity.pub' }, 'win32'),
    { endpoint: windowsPipe, publicKeyPath: 'C:/temp/identity.pub' });
  assert.throws(() => agentSelection({ endpoint: '\\\\remote\\pipe\\agent', publicKeyPath: 'C:/temp/id.pub' }, 'win32'), /local Windows named pipe/);
  assert.throws(() => agentSelection({ endpoint: windowsPipe, publicKeyPath: '\\\\remote\\keys\\id.pub' }, 'win32'), /local absolute/);
  assert.throws(() => agentSelection({ endpoint: '/tmp/owned.sock', publicKeyPath: 'relative.pub' }, 'linux'), /local absolute/);
  assert.throws(() => agentSelection({ endpoint: 'ssh.example:3000', publicKeyPath: '/tmp/id.pub' }, 'linux'), /Unix socket/);
  assert.throws(() => agentSelection({ endpoint: windowsPipe, publicKeyPath: 'C:/temp/id.pub', passphrase: '' }, 'win32'), /one OpenSSH/);
  const profile = { name: 'DB', host: '127.0.0.1', user: 'reader', database: 'test' };
  const ssh = { host: '127.0.0.1', user: 'reader', knownHostsPath: path.resolve('known_hosts') };
  const selection = { endpoint: process.platform === 'win32' ? windowsPipe : '/tmp/owned.sock', publicKeyPath: path.resolve('id.pub') };
  assert.deepEqual(normalizeProfile({ ...profile, ssh: { ...ssh, agent: selection } }).ssh.agent, selection);
  assert.throws(() => normalizeProfile({ ...profile, ssh: { ...ssh, privateKeyPath: path.resolve('id'), agent: selection } }), /either a selected SSH agent/);
  assert.equal(normalizeProfile({ ...profile, ssh }).ssh.privateKeyPath, '');
});

test('the child receives a copied public identity and chosen locally scoped agent, with prompt-free options and cleanup', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-test-agent-key-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const endpoint = process.platform === 'win32' ? windowsPipe + randomBytes(4).toString('hex') : path.join(folder, 'agent.sock');
  let listener;
  if (process.platform !== 'win32') {
    listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(endpoint, resolve); });
    t.after(() => new Promise(resolve => listener.close(resolve)));
  }
  const key = Buffer.alloc(51);
  key.writeUInt32BE(11, 0);
  key.write('ssh-ed25519', 4, 'ascii');
  key.writeUInt32BE(32, 15);
  randomBytes(32).copy(key, 19);
  const selected = path.join(folder, 'identity.pub');
  await fs.writeFile(selected, 'ssh-ed25519 ' + key.toString('base64') + ' private-comment\n');
  const parentEnv = process.env.SSH_AUTH_SOCK;
  const prepared = await prepareAgentIdentity({ endpoint, publicKeyPath: selected });
  const temp = prepared.options.at(-1);
  try {
    assert.equal(prepared.env.SSH_AUTH_SOCK, endpoint);
    assert.equal(process.env.SSH_AUTH_SOCK, parentEnv);
    assert.notEqual(temp, selected);
    assert.ok(prepared.options.includes('IdentitiesOnly=yes'));
    assert.ok(prepared.options.includes('PreferredAuthentications=publickey'));
    assert.equal(await fs.readFile(temp, 'utf8'), 'ssh-ed25519 ' + key.toString('base64') + '\n');
    assert.equal(prepared.fingerprint, 'SHA256:' + createHash('sha256').update(key).digest('base64url').replaceAll('-', '+').replaceAll('_', '/'));
  } finally { await prepared.dispose(); }
  await assert.rejects(fs.stat(temp), { code: 'ENOENT' });
  await fs.writeFile(selected, '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  await assert.rejects(prepareAgentIdentity({ endpoint, publicKeyPath: selected }), /one OpenSSH Ed25519 public key/);
});

const browser = browserRuntime();
test('the connection form sends an explicit agent selection and keeps distinct SSH modes', { skip: browser.skip, timeout: 30000 }, async t => {
  const chromium = await browser.chromium.launch({ executablePath: browser.executablePath, headless: true });
  t.after(() => chromium.close());
  const page = await chromium.newPage();
  const submitted = [];
  await page.exposeFunction('submitSsh', request => submitted.push(request));
  await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.submitSsh(message) }); });
  await page.setContent(connectionHtml(randomBytes(24).toString('hex')));
  const model = { type: 'model', editorId: 'owned', profile: { name: 'Example', host: '127.0.0.1', port: 3306,
    user: 'reader', database: 'test', tls: { mode: 'disabled' }, ssh: null } };
  const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  await send(model);
  await page.locator('#ssh').check();
  assert.equal(await page.locator('#privateKeyPath').isVisible(), false);
  await page.locator('#sshHost').fill('127.0.0.1');
  await page.locator('#sshUser').fill('reader');
  await page.locator('#knownHostsPath').fill('C:/keys/known_hosts');
  await page.locator('#sshAuth').selectOption('selected-agent');
  assert.equal(await page.locator('#sshAgentEndpoint').isVisible(), true);
  await page.locator('#sshAgentEndpoint').fill(windowsPipe);
  await page.locator('#sshAgentPublicKeyPath').fill('C:/keys/identity.pub');
  await page.locator('[data-action=test]').click();
  assert.deepEqual(submitted.at(-1).profile.ssh.agent, { endpoint: windowsPipe, publicKeyPath: 'C:/keys/identity.pub' });
  assert.equal(Object.hasOwn(submitted.at(-1).profile.ssh, 'privateKeyPath'), false);
  await send({ type: 'result', result: { database: 'test', serverVersion: '8.4', ssh: true, sshAgentFingerprint: 'SHA256:example' } });
  assert.match(await page.locator('#status').textContent(), /SHA256:example/);
  await page.locator('#sshAuth').selectOption('key-file');
  assert.equal(await page.locator('#sshAgentEndpoint').isVisible(), false);
  await page.locator('#privateKeyPath').fill('C:/keys/private');
  await page.locator('[data-action=test]').click();
  assert.equal(Object.hasOwn(submitted.at(-1).profile.ssh, 'agent'), false);
  assert.equal(submitted.at(-1).profile.ssh.privateKeyPath, 'C:/keys/private');
});
