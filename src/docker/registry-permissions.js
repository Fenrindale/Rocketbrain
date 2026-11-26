'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { timingSafeEqual, verify, X509Certificate, randomUUID } = require('node:crypto');

const acceptedManifests = [
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json'
];
const digest = /^sha256:[0-9a-f]{64}$/u;
const compactCharacters = /^[A-Za-z0-9_-]+$/u;
const printable = /^[\x21-\x7e]{1,160}$/u;
const timeoutMs = 10000;

function exactHttps(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^https:\/\//u.test(value) ||
      /[\\\x00-\x20\x7f]/u.test(value)) throw Error('Enter an exact HTTPS registry and token service URL.');
  let target;
  try { target = new URL(value); } catch { throw Error('Enter a valid HTTPS registry or token service URL.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash ||
      !/^(?:\/[A-Za-z0-9_.~/-]*)$/u.test(target.pathname) || /(?:\/\.\.?)(?:\/|$)/u.test(value)) {
    throw Error('Use an HTTPS URL without embedded credentials, query, fragment or path traversal.');
  }
  return target;
}

function registryProfile(input) {
  const { id, origin, realm, service, issuer, signerPath, caPath } = input || {};
  const registry = exactHttps(origin), tokenService = exactHttps(realm);
  if (registry.pathname !== '/' || tokenService.pathname === '/' || !printable.test(service ?? '') ||
      !printable.test(issuer ?? '') || typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,48}$/u.test(id) ||
      typeof signerPath !== 'string' || !path.isAbsolute(signerPath) ||
      caPath !== undefined && (typeof caPath !== 'string' || !path.isAbsolute(caPath))) {
    throw Error('Set the registry origin, token endpoint, audience, issuer and absolute public signer certificate path.');
  }
  return { id, origin: registry.origin, realm: tokenService.href, service, issuer, signerPath, caPath };
}

function reviewedReference(input) {
  if (typeof input !== 'string' || input.length > 385) throw Error('Choose a repository and explicit tag or SHA-256 digest.');
  const match = /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})|@(?<hash>sha256:[0-9a-f]{64}))$/u.exec(input);
  if (!match || match.groups.repository.length > 255) throw Error('Choose a repository and explicit tag or SHA-256 digest.');
  return { repository: match.groups.repository, manifest: match.groups.hash ?? match.groups.tag };
}

async function publicCertificate(file) {
  try {
    const real = await fs.realpath(file);
    if (path.relative(real, path.resolve(file))) throw Error();
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 32768) throw Error();
      const bytes = Buffer.allocUnsafe(32769);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        if (offset > 32768) throw Error();
      }
      const observed = bytes.subarray(0, offset).toString('ascii');
      if (!/^\s*-----BEGIN CERTIFICATE-----[\r\nA-Za-z0-9+/=]+-----END CERTIFICATE-----\s*$/u.test(observed)) throw Error();
      if (path.relative(await fs.realpath(file), real)) throw Error();
      return new X509Certificate(observed);
    } finally { await handle.close(); }
  } catch { throw Error('Choose one readable, physical PEM public certificate.'); }
}

function parseChallenge(value, profile, repository) {
  if (typeof value !== 'string' || value.length > 4096 || !/^Bearer +/iu.test(value)) {
    throw Error('The registry did not provide a supported Bearer challenge.');
  }
  let input = value.replace(/^Bearer +/iu, '');
  const entries = new Map();
  while (input) {
    const match = /^(realm|service|scope)="([^"\\\x00-\x1f\x7f]{1,1024})"(?:, +|,|$)/u.exec(input);
    if (!match || entries.has(match[1]) || match[0].length === input.length && match[0].trimEnd().endsWith(',')) {
      throw Error('The registry provided an ambiguous Bearer challenge.');
    }
    entries.set(match[1], match[2]);
    input = input.slice(match[0].length);
  }
  if (entries.get('realm') !== profile.realm || entries.get('service') !== profile.service ||
      entries.get('scope') !== 'repository:' + repository + ':pull') {
    throw Error('The registry challenge differs from the reviewed token service, audience or repository.');
  }
}

function section(value) {
  if (!compactCharacters.test(value)) throw Error();
  const raw = Buffer.from(value, 'base64url');
  if (raw.toString('base64url') !== value) throw Error();
  return raw;
}

function verifyGrant(token, certificate, { service, issuer, repository, user }, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 12288) throw Error();
    const parts = token.split('.');
    if (parts.length !== 3) throw Error();
    const [header, claims] = parts.slice(0, 2).map(part => JSON.parse(section(part).toString('utf8')));
    const key = certificate.publicKey;
    if (header.alg !== 'RS256' || Object.hasOwn(header, 'crit') || key.asymmetricKeyType !== 'rsa' ||
        key.asymmetricKeyDetails.modulusLength < 2048 ||
        now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo) ||
        !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, section(parts[2]))) throw Error();
    const seconds = Math.floor(now / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || claims.sub !== user || audience.length !== 1 || audience[0] !== service ||
        !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) ||
        claims.exp <= seconds || claims.iat > seconds + 30 || claims.exp <= claims.iat || claims.exp - claims.iat > 3600 ||
        claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds + 30) ||
        !Array.isArray(claims.access) || claims.access.length > 1) throw Error();
    const one = claims.access[0];
    const actions = one ? one.actions : [];
    if (claims.access.length && (!one || one.type !== 'repository' || one.name !== repository ||
        !Array.isArray(actions) || actions.length > 2 || new Set(actions).size !== actions.length ||
        actions.some(action => !['pull', 'push'].includes(action)))) throw Error();
    return { pull: actions.includes('pull'), push: actions.includes('push') };
  } catch { throw Error('The token grant could not be verified for the reviewed signer, account, audience and repository.'); }
}

function requestHttps(url, { method, headers, ca, signal, bodyLimit = 0 }) {
  return new Promise((resolve, reject) => {
    const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let completed = false;
    function fail() {
      if (completed) return;
      completed = true;
      reject(Error(signal?.aborted ? 'The registry permission check was cancelled.' :
        'The verified HTTPS registry or token service could not be reached within its limits.'));
    }
    const req = https.request(url, { method, headers, signal: abort, agent: false, rejectUnauthorized: true,
      minVersion: 'TLSv1.2', maxHeaderSize: 8192, ...(ca && { ca }) }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', data => {
        size += data.length;
        if (size > bodyLimit) { fail(); req.destroy(); }
        else chunks.push(data);
      });
      response.once('error', fail);
      response.once('aborted', fail);
      response.once('end', () => {
        if (completed) return;
        completed = true;
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    req.once('error', fail);
    req.end();
  });
}

function approvedCredentials(supplied) {
  if (supplied === undefined) return { user: '', authorization: undefined };
  const { username, password } = supplied ?? {};
  if (typeof username !== 'string' || !username || username.length > 160 || /[:\x00-\x1f\x7f]/u.test(username) ||
      typeof password !== 'string' || !password || Buffer.byteLength(password) > 4096 || /[\x00-\x1f\x7f]/u.test(password)) {
    throw Error('Enter the reviewed registry account and a bounded password or access token.');
  }
  return { user: username, authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') };
}

function readObservation(response, manifest) {
  if (response.status === 401 || response.status === 403) return { state: 'registry-denied', status: response.status };
  if (response.status === 404) return { state: 'manifest-not-observed', status: 404 };
  const value = response.headers['docker-content-digest'];
  const type = response.headers['content-type']?.split(';', 1)[0];
  if (response.status !== 200 || typeof value !== 'string' || !digest.test(value) || !acceptedManifests.includes(type) ||
      digest.test(manifest) && manifest !== value) throw Error('The registry did not confirm the reviewed manifest digest.');
  return { state: 'manifest-readable', status: 200, digest: value, mediaType: type };
}

function sameCertificate(before, after) {
  return before.raw.length === after.raw.length && timingSafeEqual(before.raw, after.raw);
}

function createRegistryPermissions({ trusted = () => true, request = requestHttps } = {}) {
  const plans = new Map();
  const pending = new Set();
  let closed = false;
  function requireTrust() {
    if (closed || !trusted()) throw Error('Use the registry permission check from a trusted open workspace.');
  }
  async function load(profile) {
    const signer = await publicCertificate(profile.signerPath);
    const ca = profile.caPath ? await publicCertificate(profile.caPath) : undefined;
    return { signer, ca };
  }
  return {
    async review(profileInput, selected) {
      requireTrust();
      const profile = registryProfile(profileInput), target = reviewedReference(selected);
      const { signer, ca } = await load(profile);
      requireTrust();
      plans.clear();
      const token = randomUUID();
      plans.set(token, { profile, target, signer, ca, expires: Date.now() + 90000 });
      return { token, profile: profile.id, registry: profile.origin, realm: profile.realm,
        issuer: profile.issuer, audience: profile.service, ...target, signerSha256: signer.fingerprint256,
        ...(ca && { tlsCaSha256: ca.fingerprint256 }), actions: ['pull', 'push'] };
    },
    async check(token, { approved, credentials, signal } = {}) {
      requireTrust();
      const plan = plans.get(token);
      if (approved !== true || !plan || Date.now() >= plan.expires) throw Error('Approve a current registry permission review first.');
      plans.delete(token);
      const { profile, target } = plan;
      const { user, authorization } = approvedCredentials(credentials);
      const current = await load(profile);
      requireTrust();
      if (!sameCertificate(plan.signer, current.signer) || plan.ca && !sameCertificate(plan.ca, current.ca)) {
        throw Error('The reviewed registry signer or TLS CA changed. Review the connection again.');
      }
      const controller = new AbortController();
      pending.add(controller);
      const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const manifestUrl = new URL('/v2/' + target.repository + '/manifests/' + target.manifest, profile.origin);
      const ca = current.ca?.toString();
      const headers = { Accept: acceptedManifests.join(', ') };
      const scope = 'repository:' + target.repository + ':pull,push';
      const summary = { registry: profile.origin, ...target, scope,
        authenticatedAccount: Boolean(authorization), signerSha256: current.signer.fingerprint256 };
      try {
        const initial = await request(manifestUrl, { method: 'HEAD', headers, ca, signal: cancellation });
        requireTrust();
        if (initial.status !== 401) throw Error('Choose a manifest with an authenticated Registry v2 Bearer challenge.');
        parseChallenge(initial.headers['www-authenticate'], profile, target.repository);
        const tokenUrl = new URL(profile.realm);
        tokenUrl.searchParams.set('service', profile.service);
        tokenUrl.searchParams.set('scope', scope);
        const exchange = await request(tokenUrl, { method: 'GET', ca, signal: cancellation, bodyLimit: 32768,
          headers: { Accept: 'application/json', ...(authorization && { Authorization: authorization }) } });
        requireTrust();
        if ([401, 403].includes(exchange.status)) return { ...summary, authentication: 'token-service-denied', status: exchange.status };
        if (exchange.status !== 200) throw Error('The reviewed token service did not issue a usable signed grant.');
        let bearer;
        try {
          const payload = JSON.parse(exchange.body.toString('utf8'));
          if (payload.token && payload.access_token && payload.token !== payload.access_token) throw Error();
          bearer = payload.token ?? payload.access_token;
        } catch { throw Error('The reviewed token service returned an unsupported response.'); }
        const grant = verifyGrant(bearer, current.signer, { ...profile, ...target, user });
        const observed = await request(manifestUrl, { method: 'HEAD', ca, signal: cancellation,
          headers: { ...headers, Authorization: 'Bearer ' + bearer } });
        requireTrust();
        return { ...summary, authentication: 'signed-grant', grant, pull: readObservation(observed, target.manifest),
          push: { state: grant.push ? 'issuer-granted' : 'issuer-not-granted' } };
      } finally {
        pending.delete(controller);
      }
    },
    dispose() {
      closed = true;
      plans.clear();
      for (const controller of pending) controller.abort();
    }
  };
}

module.exports = { createRegistryPermissions, parseChallenge, requestHttps, reviewedReference, verifyGrant };
