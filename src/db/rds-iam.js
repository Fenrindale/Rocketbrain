'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const tls = require('node:tls');

const kind = 'aws-rds-iam';
const profileName = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/;
const regionName = /^[a-z]{2}(?:-[a-z0-9]+){1,4}-[1-9]\d?$/;
const endpointLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dbUsername = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,127}$/;
const maxOutputBytes = 32 * 1024;
const commandTimeout = 12000;
const handshakeTimeout = 18000;

function fail(message) {
  return Object.assign(new Error(message), { code: 'ROCKETBRAIN_RDS_IAM' });
}

function validEndpoint(host, region) {
  if (typeof host !== 'string' || !regionName.test(region) || host.length > 253) return false;
  const suffix = '.' + region + (region.startsWith('cn-') ? '.rds.amazonaws.com.cn' : '.rds.amazonaws.com');
  if (!host.endsWith(suffix)) return false;
  const labels = host.slice(0, -suffix.length).split('.');
  return labels.length === 2 && labels.every(label => endpointLabel.test(label)) && !labels[1].startsWith('proxy-');
}

function normalizeRdsIam(auth, { allowUnconfigured = false } = {}) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).some(key =>
    !['kind', 'region', 'source', 'profile'].includes(key)) || auth.kind !== kind ||
    typeof auth.region !== 'string' || !regionName.test(auth.region)) {
    throw fail('Choose AWS RDS IAM authentication and a valid AWS region.');
  }
  const { region, source, profile } = auth;
  if (allowUnconfigured && source === undefined && profile === undefined) return { kind, region };
  if (source === 'environment' && profile === undefined) return { kind, region, source };
  if (source === 'profile' && typeof profile === 'string' && profileName.test(profile)) return { kind, region, source, profile };
  throw fail('Select AWS environment credentials or enter an explicit AWS CLI profile name.');
}

function validateRdsIamRoute({ host, user, transport, ssh, port = 3306, auth }, ssl) {
  if (!validEndpoint(host, auth.region) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof user !== 'string' || !dbUsername.test(user)) throw fail('Use the actual AWS RDS instance or cluster endpoint, region, port and database user.');
  if (transport || ssh || !ssl || ssl.rejectUnauthorized === false || ssl.verifyIdentity === false ||
      ssl.serverName && ssl.serverName !== host || ssl.cert || ssl.key) {
    throw fail('AWS RDS IAM requires direct TCP with verified TLS for the exact database endpoint.');
  }
}

function credentialEnvironment(auth, environment) {
  const env = { ...environment, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '2' };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith('AWS_ENDPOINT_URL') || ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'].includes(name) ||
      auth.source === 'profile' && ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN'].includes(name)) {
      delete env[key];
    }
  }
  if (auth.source === 'environment' && (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)) {
    throw fail('Provide AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment that launched VS Code.');
  }
  return env;
}

function validateToken(token, { host, port = 3306, user, auth }, now = Date.now()) {
  const invalid = () => fail('AWS CLI did not return a fresh token for the selected RDS database endpoint.');
  if (typeof token !== 'string' || Buffer.byteLength(token) > maxOutputBytes || !token.startsWith(`${host}:${port}/?`) || /[^\x21-\x7e]/.test(token)) {
    throw invalid();
  }
  let parsed;
  try { parsed = new URL('https://' + token); } catch { throw invalid(); }
  const query = parsed.searchParams;
  const known = ['Action', 'DBUser', 'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires',
    'X-Amz-Security-Token', 'X-Amz-Signature', 'X-Amz-SignedHeaders'];
  const keys = [...query.keys()];
  const date = query.get('X-Amz-Date') ?? '';
  const issued = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(date);
  const signedAt = issued && Date.parse(`${issued[1]}-${issued[2]}-${issued[3]}T${issued[4]}:${issued[5]}:${issued[6]}Z`);
  const credential = (query.get('X-Amz-Credential') ?? '').split('/');
  if (parsed.hash || parsed.pathname !== '/' || keys.some(key => !known.includes(key)) || new Set(keys).size !== keys.length ||
      query.get('Action') !== 'connect' || query.get('DBUser') !== user || query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
      query.get('X-Amz-Expires') !== '900' || query.get('X-Amz-SignedHeaders') !== 'host' ||
      !/^[a-f0-9]{64}$/.test(query.get('X-Amz-Signature') ?? '') || credential.length !== 5 || !credential[0] ||
      credential[1] !== date.slice(0, 8) || credential[2] !== auth.region || credential[3] !== 'rds-db' ||
      credential[4] !== 'aws4_request' || !Number.isFinite(signedAt) || Math.abs(now - signedAt) > 120000) throw invalid();
  return token;
}

async function mintRdsIamToken(target, { signal, environment = process.env } = {}) {
  const { host, port = 3306, user } = target;
  const auth = normalizeRdsIam(target.auth);
  if (!validEndpoint(host, auth.region) || typeof user !== 'string' || !dbUsername.test(user) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw fail('The RDS IAM token target is invalid.');
  }
  const env = credentialEnvironment(auth, environment);
  const args = ['rds', 'generate-db-auth-token', '--hostname', host, '--port', String(port), '--username', user,
    '--region', auth.region, '--no-cli-pager', '--no-cli-auto-prompt'];
  if (auth.source === 'profile') args.push('--profile', auth.profile);
  if (signal?.aborted) throw fail('The AWS RDS IAM connection was cancelled.');
  const stdout = await new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], settled = false;
    const executable = process.platform === 'win32' ? 'aws.exe' : 'aws';
    const child = spawn(executable, args, { env, cwd: path.dirname(process.execPath), shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'] });
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) { chunks = []; if (child.exitCode === null) child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks, bytes).toString('utf8').trim());
    }
    const cancel = () => finish(fail('The AWS RDS IAM connection was cancelled.'));
    const timer = setTimeout(() => finish(fail('AWS CLI timed out while generating the RDS IAM token.')), commandTimeout);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) finish(fail('AWS CLI returned too much authentication output.'));
      else chunks.push(chunk);
    });
    child.once('error', error => finish(fail(error.code === 'ENOENT' ? 'Install AWS CLI v2 on the machine running the extension.' :
      'AWS CLI could not start for RDS IAM authentication.')));
    child.once('close', code => finish(code === 0 ? undefined : fail('AWS CLI could not generate the RDS IAM token. Check the selected credential source.')));
  });
  return validateToken(stdout, { host, port, user, auth });
}

function verifiedSocket(socket, host) {
  return socket instanceof tls.TLSSocket && socket.encrypted && socket.authorized && !socket.destroyed &&
    !tls.checkServerIdentity(host, socket.getPeerCertificate());
}

function createRdsIamHandshake(target, mint = mintRdsIamToken) {
  let requested = false, sent = false, error;
  const mysql_clear_password = ({ connection }) => async () => {
    const socket = connection.stream;
    const cancelled = new AbortController();
    const close = () => cancelled.abort();
    try {
      if (requested || !verifiedSocket(socket, target.host)) throw fail('The RDS token can only be sent once over verified TLS for the exact endpoint.');
      requested = true;
      socket.once('close', close);
      const token = validateToken(await mint(target, { signal: cancelled.signal }), target);
      if (!verifiedSocket(socket, target.host) || cancelled.signal.aborted) throw fail('The verified RDS TLS connection closed before authentication.');
      sent = true;
      return Buffer.from(token + '\0', 'utf8');
    } catch (failure) {
      error = failure?.code === 'ROCKETBRAIN_RDS_IAM' ? fail(failure.message) : fail('The RDS IAM authentication token is unavailable.');
      // mysql2 mutates the plugin error object. Keep only our own sanitized copy.
      throw fail(error.message);
    } finally { socket?.off('close', close); }
  };
  return { options: { password: '', authPlugins: { mysql_clear_password } }, sent: () => sent, error: () => error };
}

module.exports = { kind, validEndpoint, normalizeRdsIam, validateRdsIamRoute, mintRdsIamToken, validateToken, createRdsIamHandshake, handshakeTimeout };
