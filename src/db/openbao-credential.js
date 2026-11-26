'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { createHash, X509Certificate } = require('node:crypto');
const { readClientPem } = require('./client-identity');

const kind = 'openbao-kv2';
const maxBytes = 64 * 1024;
const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
const label = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const part = /^[a-z0-9_][a-z0-9_.-]{0,79}$/i;
const tokenPattern = /^[a-z0-9._~-]{1,2048}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const caBlocks = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const allowed = ['kind', 'origin', 'mount', 'secretPath', 'field', 'caPath', 'caSha256'];
const fail = (suffix, message) => Object.assign(Error(message), { code: 'ROCKETBRAIN_OPENBAO_' + suffix });
const ordinary = value => value && typeof value === 'object' && !Array.isArray(value);

function usesOpenBao(profile) { return profile?.auth?.kind === kind; }

function endpoint(value) {
  if (typeof value !== 'string' || value.length > 320 || !scheme.test(value) || /[\s\\]/.test(value)) {
    throw fail('INPUT', 'Enter the exact OpenBao HTTP or HTTPS origin.');
  }
  let url;
  try { url = new URL(value); }
  catch { throw fail('INPUT', 'Enter the exact OpenBao HTTP or HTTPS origin.'); }
  const host = url.hostname;
  if (!host || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(net.isIP(host.replace(/^\[|\]$/g, '')) || host.split('.').every(segment => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(segment)))) {
    throw fail('INPUT', 'Enter one OpenBao server origin with no user information or path.');
  }
  if (url.protocol === 'https:') return url.origin;
  if (/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value)) return url.origin;
  throw fail('INPUT', 'Use verified HTTPS for OpenBao or explicit numeric loopback for a local test server.');
}

function localCa(value) {
  return typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/^[\\/]{2}|[\0\r\n]/.test(value);
}

function normalizeOpenBao(value, { allowUnconfigured = false } = {}) {
  if (!ordinary(value) || value.kind !== kind || Object.keys(value).some(key => !allowed.includes(key))) {
    throw fail('INPUT', 'Enter an OpenBao KV v2 reference with no embedded credentials.');
  }
  if (allowUnconfigured && Object.keys(value).length === 1) return { kind };
  const origin = endpoint(value.origin);
  const { mount, secretPath, field, caPath, caSha256 } = value;
  if (typeof mount !== 'string' || !label.test(mount) || typeof field !== 'string' || !label.test(field) ||
      typeof secretPath !== 'string' || secretPath.length > 320 || !secretPath.split('/').every(segment => part.test(segment))) {
    throw fail('INPUT', 'Enter one KV v2 mount, one relative secret path and one password field.');
  }
  if (caPath !== undefined || caSha256 !== undefined) {
    if (!origin.startsWith('https://') || !localCa(caPath) || typeof caSha256 !== 'string' || !digestPattern.test(caSha256)) {
      throw fail('INPUT', 'Review the local OpenBao CA file for this exact HTTPS origin.');
    }
    return { kind, origin, mount, secretPath, field, caPath, caSha256 };
  }
  return { kind, origin, mount, secretPath, field };
}

function reviewedEndpoint(auth) { return auth.origin + '/v1/' + auth.mount + '/data/' + auth.secretPath; }

async function openBaoCa(caPath) {
  const invalid = () => fail('TLS', 'Choose a local PEM bundle of up to eight public OpenBao CA certificates.');
  if (!localCa(caPath)) throw invalid();
  try {
    const source = await readClientPem(caPath), entries = source.match(caBlocks);
    if (Buffer.byteLength(source) > maxBytes || !entries?.length || entries.length > 8 ||
        source.replace(caBlocks, '').trim() || entries.some(entry => !new X509Certificate(entry).ca)) throw invalid();
    return { entries, sha256: createHash('sha256').update(source, 'utf8').digest('hex') };
  } catch { throw invalid(); }
}

async function inspectOpenBaoCa(file) { return (await openBaoCa(file)).sha256; }

async function readPasswordResponse(response, field) {
  if (response.statusCode !== 200) {
    response.destroy();
    if (response.statusCode === 401 || response.statusCode === 403) throw fail('DENIED', 'OpenBao denied this exact credential read.');
    if (response.statusCode >= 300 && response.statusCode < 400) throw fail('REDIRECT', 'OpenBao redirected the request. Review the intended server address.');
    throw fail('READ', 'OpenBao did not return the configured credential.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw fail('READ', 'The OpenBao credential response exceeded its size limit.');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('READ', 'OpenBao returned an invalid credential response.'); }
  const values = result?.data?.data, metadata = result?.data?.metadata;
  const secret = ordinary(values) && Object.hasOwn(values, field) ? values[field] : undefined;
  if (typeof secret !== 'string' || !secret || secret.includes('\0') || Buffer.byteLength(secret) > 16384 ||
      !Number.isSafeInteger(metadata?.version) || metadata.version < 1 || metadata.destroyed !== false || metadata.deletion_time !== '') {
    throw fail('READ', 'The configured OpenBao password field or version is unavailable.');
  }
  return secret;
}

async function readOpenBaoPassword(input, token, signal) {
  const auth = normalizeOpenBao(input);
  if (typeof token !== 'string' || !tokenPattern.test(token)) {
    throw fail('TOKEN', 'Enter the scoped OpenBao token for this connection attempt.');
  }
  const url = new URL(reviewedEndpoint(auth));
  let ca;
  if (auth.caPath) {
    const observed = await openBaoCa(auth.caPath);
    if (observed.sha256 !== auth.caSha256) throw fail('TLS', 'The OpenBao CA file changed. Review it in the profile editor.');
    ca = observed.entries;
  }
  const deadline = AbortSignal.any([AbortSignal.timeout(6500), ...(signal ? [signal] : [])]);
  try {
    return await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.get(url, { signal: deadline, agent: false, ...(url.protocol === 'https:' && {
        rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca && { ca })
      }), headers: { Accept: 'application/json', 'Cache-Control': 'no-store', 'X-Vault-Token': token } },
      response => { void readPasswordResponse(response, auth.field).then(resolve, reject); });
      request.once('error', reject);
    });
  } catch (error) {
    if (deadline.aborted) throw fail('CANCELLED', 'The OpenBao credential read was cancelled or timed out.');
    if (typeof error.code === 'string' && error.code.startsWith('ROCKETBRAIN_OPENBAO_')) throw error;
    throw fail('READ', 'OpenBao could not verify or read the credential from this exact endpoint.');
  }
}

module.exports = { usesOpenBao, normalizeOpenBao, reviewedEndpoint, inspectOpenBaoCa, readOpenBaoPassword };
