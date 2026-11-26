'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { openTunnel } = require('../src/db/connection-tunnel');
const { normalizeProfile } = require('../src/db/connection-profiles');
const { connectionHtml, promptProfileCredentials } = require('../src/db/connection-profiles-vscode');
const { browserRuntime } = require('./helpers/browser-runtime');
const { createSshCredentialFixture, waitFor } = require('./helpers/ssh-credentials-fixture');

const bogusPin = 'SHA256:' + createHash('sha256').update('owned wrong test pin').digest('base64').slice(0, -1);
const profile = ssh => ({ id: '00000000-0000-4000-8000-000000000001', name:'Pinned', host:'127.0.0.1',
  port:3306, user:'db', database:'app', tls:{mode:'disabled'}, ssh });

async function owned(t, options) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-ssh-auth-test-'));
  const tcp = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
  await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve); });
  const destination = { host:'127.0.0.1', port:tcp.address().port };
  const fixture = await createSshCredentialFixture(folder, destination, options);
  t.after(async () => { await fixture.close(); await new Promise(resolve => tcp.close(resolve)); await fs.rmdir(folder); });
  return { fixture, destination };
}

async function roundTrip(endpoint) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    socket.once('error', reject);
    socket.once('connect', () => socket.write('one round-trip'));
    socket.setTimeout(4000, () => socket.destroy(Error('Owned SSH forwarding stalled.')));
    socket.once('data', message => {
      socket.destroy();
      try { assert.equal(message.toString(), 'one round-trip'); resolve(); }
      catch (error) { reject(error); }
    });
  });
}

test('pinned SSH password and encrypted key forward through one owned host and stop', {timeout:20000}, async t => {
  const { fixture, destination } = await owned(t);
  for (const [ssh, credential] of [[fixture.passwordProfile, fixture.password], [fixture.keyProfile, fixture.passphrase]]) {
    const tunnel = await openTunnel(ssh, destination, { credential });
    assert.equal(tunnel.endpoint.host, '127.0.0.1');
    assert.equal(tunnel.pid, undefined);
    try { await roundTrip(tunnel.endpoint); }
    finally { await tunnel.dispose(); }
    await assert.rejects(roundTrip(tunnel.endpoint), { code: 'ECONNREFUSED' });
    await waitFor(() => fixture.clients.size === 0 && fixture.sockets.size === 0, 'Owned SSH resources remained reachable.');
  }
  assert.equal(fixture.count.password, 1);
  assert.equal(fixture.count.publickey, 2);
  assert.equal(fixture.count.other, 0);
  assert.equal(fixture.count.forward, 2);
});

test('credentials are withheld before pin verification and rejected credentials do not fall back', {timeout:20000}, async t => {
  const { fixture, destination } = await owned(t);
  const wrongHost = { ...fixture.passwordProfile, hostFingerprint: bogusPin };
  await assert.rejects(openTunnel(wrongHost, destination, { credential:fixture.password }), /host-key verification failed/);
  assert.equal(fixture.count.password + fixture.count.publickey + fixture.count.other, 0);
  await assert.rejects(openTunnel(fixture.passwordProfile, destination, { credential:'wrong' }), /rejected/);
  assert.equal(fixture.count.password, 1);
  const connections = fixture.count.connections;
  await assert.rejects(openTunnel(fixture.keyProfile, destination, { credential:'wrong' }), /could not be unlocked/);
  await assert.rejects(openTunnel({ ...fixture.keyProfile, privateKeyPath: fixture.systemProfile.privateKeyPath }, destination,
    { credential:fixture.passphrase }), /passphrase-protected OpenSSH private key/);
  assert.equal(fixture.count.connections, connections);
  assert.equal(fixture.count.publickey + fixture.count.other + fixture.count.forward, 0);
  await waitFor(() => fixture.clients.size === 0, 'Rejected SSH connections did not close.');
});

test('cancellation closes a stalled authentication before any local forwarding is opened', {timeout:15000}, async t => {
  const { fixture, destination } = await owned(t, { stall:true });
  const controller = new AbortController();
  const result = assert.rejects(openTunnel(fixture.passwordProfile, destination,
    { credential:fixture.password, cancellation:controller.signal }), /cancelled/);
  try { await waitFor(() => fixture.count.password === 1, 'Owned SSH server did not receive the attempted password.'); }
  finally { controller.abort(); }
  await result;
  await waitFor(() => fixture.clients.size === 0, 'The aborted SSH connection remained open.');
  assert.equal(fixture.count.forward, 0);
});

test('profiles separate SSH secrets, known_hosts, key files and pinned password modes', async () => {
  const endpoint = { host:'127.0.0.1', port:2222, user:'tunnel' };
  const passwordMode = { ...endpoint, authentication:'password', hostFingerprint:bogusPin };
  assert.deepEqual(normalizeProfile(profile(passwordMode)).ssh, passwordMode);
  for (const mixed of [
    { ...passwordMode, password:'do-not-save' }, { ...passwordMode, privateKeyPath:path.resolve('identity') },
    { ...passwordMode, knownHostsPath:path.resolve('known_hosts') }, { ...passwordMode, hostFingerprint:'SHA256:example' },
    { ...passwordMode, agent:{} }, { ...passwordMode, authentication:'encrypted-key' }
  ]) assert.throws(() => normalizeProfile(profile(mixed)), /SSH|unsupported fields/);
  const prompts = [];
  const answer = await promptProfileCredentials({ window:{ async showInputBox(options){ prompts.push(options); return 'attempt'; } } },
    { profile:normalizeProfile(profile(passwordMode)), hasSavedPassword:true });
  assert.deepEqual(answer, { sshCredential:'attempt' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /SSH password/);
  assert.equal(prompts[0].password, true);
  assert.equal(await promptProfileCredentials({ window:{ async showInputBox(){} } },
    { profile:normalizeProfile(profile(passwordMode)), hasSavedPassword:true }), null);
});

const browser = browserRuntime();
test('the editor keeps SSH credentials outside the profile and clears them after mode changes and submission',
  { skip:browser.skip, timeout:30000 }, async t => {
    const chromium = await browser.chromium.launch({ executablePath:browser.executablePath, headless:true });
    t.after(() => chromium.close());
    const page = await chromium.newPage();
    const submitted = [];
    await page.exposeFunction('submitSsh', request => submitted.push(request));
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage:message => window.submitSsh(message) }); });
    await page.setContent(connectionHtml(randomBytes(24).toString('hex')));
    const send = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const { id, ...common } = profile(null);
    await send({ type:'model', editorId:id, profile:common });
    await page.locator('#ssh').check();
    await page.locator('#sshHost').fill('127.0.0.1');
    await page.locator('#sshUser').fill('test');
    await page.locator('#sshAuth').selectOption('password');
    assert.equal(await page.locator('#knownHostsPath').isVisible(), false);
    assert.equal(await page.locator('#privateKeyPath').isVisible(), false);
    assert.equal(await page.locator('#sshCredential').getAttribute('type'), 'password');
    await page.locator('#sshHostFingerprint').fill(bogusPin);
    await page.locator('#sshCredential').fill('synthetic password');
    await page.locator('[data-action=test]').click();
    assert.equal(submitted.at(-1).sshCredential, 'synthetic password');
    assert.equal(submitted.at(-1).profile.ssh.hostFingerprint, bogusPin);
    assert.ok(!JSON.stringify(submitted.at(-1).profile).includes('synthetic password'));
    assert.equal(await page.locator('#sshCredential').inputValue(), '');
    await send({ type:'result', result:{ database:'app', serverVersion:'8.4', ssh:true } });
    await page.locator('#sshCredential').fill('discard on mode change');
    await page.locator('#sshAuth').selectOption('encrypted-key');
    assert.equal(await page.locator('#sshCredential').inputValue(), '');
    assert.equal(await page.locator('#privateKeyPath').isVisible(), true);
    assert.match(await page.locator('#ssh-credential-label').textContent(), /passphrase/);
    await page.locator('#sshAuth').selectOption('default-agent');
    assert.equal(await page.locator('#knownHostsPath').isVisible(), true);
    assert.equal(await page.locator('#sshCredential').isVisible(), false);
  });
