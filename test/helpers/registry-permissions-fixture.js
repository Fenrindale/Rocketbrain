'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomBytes, randomUUID, sign, X509Certificate } = require('node:crypto');

const invoke = promisify(execFile);
const issuer = 'rocketbrain-owned-issuer';
const audience = 'rocketbrain-owned-registry';
const imageMediaType = 'application/vnd.oci.image.manifest.v1+json';
const sha256 = body => 'sha256:' + createHash('sha256').update(body).digest('hex');

async function temporary(context) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'rb-registry-permissions-'));
  context.after(async () => {
    const target = await fs.realpath(folder);
    assert.equal(target, folder);
    assert.equal(path.dirname(target), parent);
    assert.match(path.basename(target), /^rb-registry-permissions-/u);
    await fs.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  });
  return folder;
}

async function certificates(context) {
  const directory = await temporary(context);
  const openssl = process.env.ROCKETBRAIN_REGISTRY_TEST_OPENSSL || 'openssl';
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'certificate.pem');
  if (process.env.ROCKETBRAIN_REGISTRY_TEST_KEYS) {
    const generated = process.env.ROCKETBRAIN_REGISTRY_TEST_KEYS;
    await fs.copyFile(path.join(generated, 'key.pem'), key);
    await fs.copyFile(path.join(generated, 'certificate.pem'), cert);
  } else {
    await invoke(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=rocketbrain-registry-fixture', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout', key, '-out', cert], { timeout: 12000, windowsHide: true });
  }
  const tls = { key: await fs.readFile(key), cert: await fs.readFile(cert) };
  return { directory, key, cert, tls, signer: new X509Certificate(tls.cert) };
}

async function listen(context, options, handler) {
  const server = https.createServer(options, handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  return 'https://127.0.0.1:' + server.address().port;
}

function signedToken(keys, subject, repository, actions, claims = {}) {
  const time = Math.floor(Date.now() / 1000);
  const encoded = item => Buffer.from(JSON.stringify(item)).toString('base64url');
  const header = encoded({ alg: 'RS256', typ: 'JWT', x5c: [keys.signer.raw.toString('base64')] });
  const body = encoded({ iss: issuer, sub: subject, aud: audience, iat: time, nbf: time, exp: time + 240,
    jti: randomUUID(), access: actions.length ? [{ type: 'repository', name: repository, actions }] : [], ...claims });
  return header + '.' + body + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + body), keys.tls.key).toString('base64url');
}

async function tokenFixture(context, keys, repository) {
  const byAccount = new Map([
    ['reader', { password: randomBytes(18).toString('base64url'), actions: ['pull'] }],
    ['writer', { password: randomBytes(18).toString('base64url'), actions: ['pull', 'push'] }],
    ['visitor', { password: randomBytes(18).toString('base64url'), actions: [] }]
  ]);
  const credentials = username => ({ username, password: byAccount.get(username).password });
  const tokenFor = username => signedToken(keys, username, repository, byAccount.get(username)?.actions || []);
  const received = [];
  const origin = await listen(context, keys.tls, (request, response) => {
    const target = new URL(request.url, 'https://fixture.invalid');
    const scope = 'repository:' + repository + ':pull,push';
    const header = request.headers.authorization;
    const subject = [...byAccount.entries()].find(([user, item]) =>
      header === 'Basic ' + Buffer.from(user + ':' + item.password).toString('base64'))?.[0];
    received.push({ method: request.method, scope: target.searchParams.get('scope'), validAuthentication: Boolean(subject) });
    if (request.method !== 'GET' || target.pathname !== '/token' || target.searchParams.size !== 2 ||
        target.searchParams.get('service') !== audience || target.searchParams.get('scope') !== scope) {
      response.writeHead(400).end();
      return;
    }
    if (header && !subject) { response.writeHead(401).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: tokenFor(subject || '') }));
  });
  return { realm: origin + '/token', received, credentials, tokenFor };
}

function profile(keys, origin, realm) {
  return { id: 'owned', origin, realm, issuer, service: audience, signerPath: keys.cert, caPath: keys.cert };
}

function ownedRequest(origin, input, keys, { method = 'GET', token, contentType, body } = {}) {
  const url = new URL(input, origin);
  assert.equal(url.origin, origin);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      ca: keys.tls.cert, method, agent: false, signal: AbortSignal.timeout(8000),
      headers: {
        accept: imageMediaType,
        ...(token && { authorization: 'Bearer ' + token }),
        ...(body && { 'content-length': body.length }),
        ...(contentType && { 'content-type': contentType })
      }
    }, response => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function seedManifest(origin, keys, tokens, repository) {
  const uploads = '/v2/' + repository + '/blobs/uploads/';
  const denied = await ownedRequest(origin, uploads, keys, { method: 'POST', token: tokens.tokenFor('reader') });
  assert.equal(denied.status, 401);
  const token = tokens.tokenFor('writer');
  const upload = await ownedRequest(origin, uploads, keys, { method: 'POST', token });
  assert.equal(upload.status, 202);
  const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } }));
  const configHash = sha256(config);
  const location = new URL(upload.headers.location, origin);
  assert.equal(location.origin, origin);
  assert.ok(location.pathname.startsWith(uploads));
  location.searchParams.set('digest', configHash);
  const blob = await ownedRequest(origin, location, keys, { method: 'PUT', token, contentType: 'application/octet-stream', body: config });
  assert.equal(blob.status, 201);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: imageMediaType,
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configHash, size: config.length }, layers: [] }));
  const published = await ownedRequest(origin, '/v2/' + repository + '/manifests/reviewed', keys,
    { method: 'PUT', token, contentType: imageMediaType, body: manifest });
  assert.equal(published.status, 201);
  assert.equal(published.headers['docker-content-digest'], sha256(manifest));
  return sha256(manifest);
}

module.exports = { certificates, listen, tokenFixture, profile, ownedRequest, seedManifest,
  signedToken, issuer, audience, imageMediaType, sha256 };
