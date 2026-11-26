'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createRegistryPermissions, parseChallenge, reviewedReference, verifyGrant } = require('../src/docker/registry-permissions');
const { dockerEnvironment } = require('../src/docker/workbench');
const { certificates, listen, tokenFixture, profile, ownedRequest, seedManifest, signedToken,
  issuer, audience, imageMediaType, sha256 } = require('./helpers/registry-permissions-fixture');

const invoke = promisify(execFile);
const canCreateKeys = process.platform !== 'win32' || process.env.ROCKETBRAIN_REGISTRY_TEST_OPENSSL ||
  process.env.ROCKETBRAIN_REGISTRY_TEST_KEYS;
const name = 'team/reviewed-app', reference = name + ':reviewed';
const expectedScope = 'repository:' + name + ':pull,push';
const challenge = (realm, repo = name) =>
  'Bearer realm="' + realm + '",service="' + audience + '",scope="repository:' + repo + ':pull"';

test('registry review admits one exact reference and canonical Bearer challenge', () => {
  const realm = 'https://auth.example.test/token';
  const exact = { realm, service: audience };
  assert.deepEqual(reviewedReference(reference), { repository: name, manifest: 'reviewed' });
  assert.throws(() => reviewedReference('https://registry.example.test/' + reference), /repository/);
  assert.throws(() => reviewedReference('../' + reference), /repository/);
  parseChallenge(challenge(realm), exact, name);
  assert.throws(() => parseChallenge(challenge(realm) + ',realm="' + realm + '"', exact, name), /ambiguous/);
  assert.throws(() => parseChallenge(challenge(realm) + ',', exact, name), /ambiguous/);
  assert.throws(() => parseChallenge(challenge(realm, 'other/repository'), exact, name), /differs/);
  assert.throws(() => parseChallenge(challenge('https://other.example.test/token'), exact, name), /differs/);
});

test('TLS and RS256 restrict credentials and grant evidence to the reviewed endpoints and one repository',
  { skip: !canCreateKeys, timeout: 30000 }, async context => {
    const keys = await certificates(context);
    const tokens = await tokenFixture(context, keys, name);
    const manifestDigest = sha256(Buffer.from('fixture-only-identity'));
    const actualRequests = [];
    let challengedRealm = tokens.realm, moveTo;
    const origin = await listen(context, keys.tls, (request, response) => {
      actualRequests.push({ method: request.method, bearer: Boolean(request.headers.authorization) });
      if (moveTo) { response.writeHead(307, { location: moveTo }).end(); return; }
      if (!request.headers.authorization) {
        response.writeHead(401, { 'www-authenticate': challenge(challengedRealm) }).end();
        return;
      }
      response.writeHead(200, { 'Docker-Content-Digest': manifestDigest, 'Content-Type': imageMediaType }).end();
    });
    const config = profile(keys, origin, tokens.realm);
    let trusted = true;
    const client = createRegistryPermissions({ trusted: () => trusted });
    context.after(() => client.dispose());
    const review = () => client.review(config, reference);
    const check = async (credentials, input = config, ref = reference) => client.check((await client.review(input, ref)).token,
      { approved: true, credentials });
    const claims = { service: audience, issuer, repository: name, user: 'reader' };
    const token = tokens.tokenFor('reader');
    assert.deepEqual(verifyGrant(token, keys.signer, claims), { pull: true, push: false });
    assert.throws(() => verifyGrant(token, keys.signer, { ...claims, user: 'writer' }), /could not be verified/);
    assert.throws(() => verifyGrant(signedToken(keys, 'reader', name, ['pull'], { exp: 1 }), keys.signer, claims), /verified/);
    assert.throws(() => verifyGrant(signedToken(keys, 'reader', name, ['pull'], { aud: 'wrong' }), keys.signer, claims), /verified/);
    assert.throws(() => verifyGrant(signedToken(keys, 'reader', 'different/repo', ['pull']), keys.signer, claims), /verified/);
    const [head, body, signature] = token.split('.');
    const badBytes = Buffer.from(signature, 'base64url');
    badBytes[0] ^= 1;
    assert.throws(() => verifyGrant([head, body, badBytes.toString('base64url')].join('.'), keys.signer, claims), /verified/);

    const first = await review();
    assert.equal(tokens.received.length, 0);
    await assert.rejects(client.check(first.token), /Approve/);
    const allowed = await client.check(first.token, { approved: true, credentials: tokens.credentials('reader') });
    assert.deepEqual(allowed.grant, { pull: true, push: false });
    assert.equal(allowed.pull.digest, manifestDigest);
    assert.equal(allowed.push.state, 'issuer-not-granted');
    assert.ok(!JSON.stringify(allowed).includes(tokens.credentials('reader').password));
    assert.ok(!JSON.stringify(allowed).includes(token.split('.')[0]));
    await assert.rejects(client.check(first.token, { approved: true }), /Approve/);
    assert.deepEqual(actualRequests, [{ method: 'HEAD', bearer: false }, { method: 'HEAD', bearer: true }]);
    assert.deepEqual(tokens.received, [{ method: 'GET', scope: expectedScope, validAuthentication: true }]);
    assert.equal((await check({ username: 'reader', password: randomUUID() })).authentication, 'token-service-denied');
    await assert.rejects(check(tokens.credentials('reader'), { ...config, caPath: undefined }), /verified HTTPS/);
    await assert.rejects(check(tokens.credentials('reader'), config, name + '@' + sha256(Buffer.alloc(0))), /confirm/);
    const tokenRequests = tokens.received.length;
    moveTo = tokens.realm;
    await assert.rejects(check(tokens.credentials('reader')), /Bearer challenge/);
    assert.equal(tokens.received.length, tokenRequests);
    moveTo = undefined;
    challengedRealm = 'https://0.0.0.0:1/token';
    await assert.rejects(check(tokens.credentials('reader')), /differs/);
    assert.equal(tokens.received.length, tokenRequests);
    trusted = false;
    await assert.rejects(review(), /trusted open workspace/);
  });

test('actual Docker Distribution enforces private manifest pull and upload grants for owned accounts', {
  skip: process.env.ROCKETBRAIN_DOCKER_REGISTRY_PERMISSION_TEST !== '1', timeout: 220000
}, async context => {
  assert.equal(process.platform, 'linux');
  const owner = randomUUID(), repository = 'rocketbrain/permission-' + owner;
  const keys = await certificates(context);
  const tokens = await tokenFixture(context, keys, repository);
  const docker = args => invoke('docker', ['--context', 'default', ...args],
    { env: dockerEnvironment(), timeout: 85000, maxBuffer: 1024 * 1024 });
  const endpoint = (await docker(['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
  assert.match(endpoint, /^unix:\/\/\//u);
  let id;
  const client = createRegistryPermissions();
  try {
    id = (await docker(['run', '--detach', '--rm', '--name', 'rb-registry-permission-' + owner,
      '--label', 'rocketbrain.verification=' + owner, '--publish', '127.0.0.1::5000',
      '--mount', 'type=bind,src=' + keys.directory + ',dst=/owned-keys,readonly',
      '--env', 'REGISTRY_HTTP_TLS_CERTIFICATE=/owned-keys/certificate.pem',
      '--env', 'REGISTRY_HTTP_TLS_KEY=/owned-keys/key.pem',
      '--env', 'REGISTRY_HTTP_RELATIVEURLS=true', '--env', 'REGISTRY_AUTH=token',
      '--env', 'REGISTRY_AUTH_TOKEN_REALM=' + tokens.realm, '--env', 'REGISTRY_AUTH_TOKEN_SERVICE=' + audience,
      '--env', 'REGISTRY_AUTH_TOKEN_ISSUER=' + issuer, '--env', 'REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE=/owned-keys/certificate.pem',
      'registry:3.0.0'])).stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/u);
    const location = (await docker(['port', id, '5000/tcp'])).stdout.trim();
    assert.match(location, /^127\.0\.0\.1:\d{1,5}$/u);
    const origin = 'https://' + location;
    const url = '/v2/' + repository + '/manifests/reviewed';
    let privateChallenge;
    for (let attempt = 0; attempt < 45 && !privateChallenge; attempt++) {
      const reply = await ownedRequest(origin, url, keys, { method: 'HEAD' }).catch(() => undefined);
      if (reply?.status === 401) privateChallenge = reply.headers['www-authenticate'];
      else await delay(250);
    }
    assert.ok(privateChallenge, 'The owned registry must require a TLS Bearer challenge.');
    parseChallenge(privateChallenge, { realm: tokens.realm, service: audience }, repository);
    const manifest = await seedManifest(origin, keys, tokens, repository);
    const config = profile(keys, origin, tokens.realm);
    const verify = async (credentials, ref = repository + ':reviewed') => client.check(
      (await client.review(config, ref)).token, { approved: true, credentials });
    const reader = await verify(tokens.credentials('reader'));
    const writer = await verify(tokens.credentials('writer'), repository + '@' + manifest);
    const visitor = await verify(tokens.credentials('visitor'));
    const anonymous = await verify();
    assert.deepEqual(reader.grant, { pull: true, push: false });
    assert.equal(reader.pull.state, 'manifest-readable');
    assert.equal(reader.pull.digest, manifest);
    assert.deepEqual(writer.grant, { pull: true, push: true });
    assert.equal(writer.push.state, 'issuer-granted');
    assert.equal(writer.pull.digest, manifest);
    for (const item of [visitor, anonymous]) {
      assert.deepEqual(item.grant, { pull: false, push: false });
      assert.equal(item.pull.state, 'registry-denied');
    }
    const bad = await verify({ username: 'reader', password: randomUUID() });
    assert.equal(bad.authentication, 'token-service-denied');
    assert.ok(tokens.received.every(item => item.method === 'GET' && item.scope === 'repository:' + repository + ':pull,push'));
    const result = { sourceCommit: process.env.GITHUB_SHA || null, runtime: 'Distribution 3.0.0',
      engine: (await docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim(),
      tlsPeerVerified: true, issuerSignatureVerified: true, readOnlyPull: true, writerGrant: true, noGrantDenied: true,
      anonymousDenied: true, incorrectCredentialsDenied: true, exactDigest: manifest, exactRepositoryScope: true,
      independentReaderUploadDenied: true, independentWriterUploadAndManifestSucceeded: true, applicationChecksAreReadOnly: true };
    const receipt = process.env.ROCKETBRAIN_DOCKER_REGISTRY_PERMISSION_RECEIPT;
    if (receipt) await fs.writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    context.diagnostic(JSON.stringify(result));
  } finally {
    client.dispose();
    if (id) {
      const observed = (await docker(['container', 'inspect', '--format', '{{index .Config.Labels "rocketbrain.verification"}}', id])).stdout.trim();
      assert.equal(observed, owner);
      await docker(['container', 'stop', id]);
    }
  }
});
