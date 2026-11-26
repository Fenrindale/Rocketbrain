'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { X509Certificate, randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startOpenBao(bin) {
  assert.ok(path.isAbsolute(bin) && /^bao(?:\.exe)?$/i.test(path.basename(bin)));
  bin = await fs.realpath(bin);
  assert.ok((await fs.stat(bin)).isFile());
  const parent = await fs.realpath(os.tmpdir()), folder = await fs.mkdtemp(path.join(parent, 'rocketbrain-owned-openbao-'));
  const marker = path.join(folder, 'fixture-owner'), owner = randomUUID(), certs = path.join(folder, 'certificates');
  await fs.writeFile(marker, owner, { flag: 'wx' });
  await fs.mkdir(certs);
  const token = randomBytes(32).toString('base64url'), port = await freePort();
  const origin = 'https://127.0.0.1:' + port;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].includes(name.toUpperCase())));
  const child = spawn(bin, ['server', '-dev', '-dev-tls', '-dev-no-store-token', '-dev-tls-cert-dir=' + certs,
    '-dev-listen-address=127.0.0.1:' + port], { cwd: folder, shell: false, windowsHide: true, stdio: 'ignore',
    env: { ...environment, BAO_DEV_ROOT_TOKEN_ID: token } });
  let exited = false, ca, caPath;
  const closed = new Promise(resolve => {
    child.once('close', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });

  async function stop() {
    if (!exited) child.kill();
    await Promise.race([closed, pause(3500, undefined, { ref: false })]);
    assert.equal(exited, true, 'The owned OpenBao process did not stop.');
    const resolved = await fs.realpath(folder);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('rocketbrain-owned-openbao-'));
    assert.equal(await fs.readFile(marker, 'utf8'), owner);
    await fs.rm(resolved, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }

  function request(method, urlPath, value, authority = token) {
    assert.ok(urlPath.startsWith('/v1/') && !urlPath.includes('..'));
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value), 'utf8');
    return new Promise((resolve, reject) => {
      const req = https.request(origin + urlPath, { method, ca, rejectUnauthorized: true, agent: false, signal: AbortSignal.timeout(2200),
        headers: { 'X-Vault-Token': authority, ...(body && { 'Content-Type': 'application/json', 'Content-Length': body.length }) } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('error', () => reject(Error('Owned OpenBao response interrupted.')));
        response.once('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode, result: text ? JSON.parse(text) : null });
          } catch { reject(Error('Owned OpenBao returned invalid JSON.')); }
        });
      });
      req.once('error', () => reject(Error('The owned TLS OpenBao endpoint did not reply.')));
      req.end(body);
    });
  }

  try {
    const deadline = Date.now() + 12000;
    let version;
    while (!exited && !version && Date.now() < deadline) {
      const entries = await fs.readdir(certs).catch(() => []);
      for (const name of entries.filter(name => /ca.*\.pem$/i.test(name))) {
        const file = path.join(certs, name);
        try {
          const source = await fs.readFile(file);
          if (new X509Certificate(source).ca) { ca = source; caPath = file; break; }
        } catch {}
      }
      if (ca) {
        const health = await request('GET', '/v1/sys/health').catch(() => null);
        if (health?.status === 200) version = health.result?.version;
      }
      if (!version) await pause(100);
    }
    if (!version || !caPath) throw Error('The owned OpenBao TLS fixture did not initialize.');
    const mount = 'secret', secretPath = 'database/owned-' + randomBytes(6).toString('hex'), field = 'password';
    const api = '/v1/' + mount + '/data/' + secretPath;
    const other = '/v1/' + mount + '/data/database/unapproved';
    const policy = 'rocketbrain-exact-read';
    const allowed = await request('PUT', '/v1/sys/policies/acl/' + policy, { policy: 'path "' + api.slice(4) + '" { capabilities = ["read"] }' });
    assert.equal(allowed.status, 204);

    async function createToken(uses = 1) {
      const minted = await request('POST', '/v1/auth/token/create', { policies: [policy], no_default_policy: true, ttl: '3m', num_uses: uses });
      const secret = minted.result?.auth?.client_token;
      if (minted.status !== 200 || typeof secret !== 'string' || !secret) throw Error('The owned OpenBao token was not issued.');
      return secret;
    }
    async function put(password) {
      const changed = await request('POST', api, { data: { [field]: password } });
      assert.equal(changed.status, 200);
      return changed.result?.data?.version;
    }
    return { folder, origin, caPath, mount, secretPath, field, version, createToken, put,
      deniedAdjacent: authority => request('GET', other, undefined, authority).then(item => item.status === 403), stop };
  } catch (error) { await stop(); throw error; }
}

module.exports = { startOpenBao };
