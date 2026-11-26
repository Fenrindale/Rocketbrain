'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash, X509Certificate} = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');
const {parseArgs} = require('node:util');
const mysql = require('mysql2');
const {createConnectionProfiles, normalizeProfile} = require('../src/db/connection-profiles');
const {MysqlService} = require('../src/db/mysql');
const {connectionSecurity} = require('../src/db/connection-security');
const {mintRdsIamToken, validateToken, verifiedSocket} = require('../src/db/rds-iam');
const {mintAzureMysqlEntraToken} = require('../src/db/azure-mysql-entra');

const format = 'RocketbrainOwnedCloudMySqlFixture-v1';
const approval = 'owned-cloud-fixture-read-only';
const query = 'SELECT CURRENT_USER(), DATABASE(), CONNECTION_ID(), nonce FROM rocketbrain_live_auth_proof WHERE fixture_id = 1 LIMIT 2';
const deadlineLimit = 20 * 60 * 1000;
const tokenGrace = 5000;
const reconnectBudget = 45000;
const tlsVersions = new Set(['TLSv1.2', 'TLSv1.3']);

class ProofFailure extends Error {
  constructor(stage) {
    super(stage);
    this.stage = stage;
  }
}

function requireProof(condition, stage) {
  if (!condition) throw new ProofFailure(stage);
}

function exactObject(value, required, optional = []) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function ordinaryFile(file, size) {
  requireProof(typeof file === 'string' && path.isAbsolute(file) && !/^[/\\]{2}/u.test(file) &&
    (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/u.test(file)), 'fixture-path');
  const stat = fs.lstatSync(file, {throwIfNoEntry: false});
  requireProof(stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= size &&
    path.relative(file, fs.realpathSync(file)) === '', 'fixture-path');
  const bytes = fs.readFileSync(file);
  requireProof(bytes.length === stat.size, 'fixture-path');
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

function parseFixture(input, readFile = ordinaryFile) {
  requireProof(exactObject(input, ['format', 'approval', 'host', 'user', 'database', 'auth', 'caPath', 'wrongCaPath', 'nonce'], ['port']) &&
    input.format === format && input.approval === approval && typeof input.nonce === 'string' && /^[a-f0-9]{32,64}$/u.test(input.nonce) &&
    typeof input.database === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(input.database), 'fixture-contract');
  const provider = input.auth?.kind;
  requireProof(provider === 'aws-rds-iam' || provider === 'azure-mysql-entra', 'fixture-contract');
  if (provider === 'aws-rds-iam') requireProof(input.auth.source === 'profile', 'fixture-contract');
  const profile = normalizeProfile({
    name: 'Owned cloud authentication proof', host: input.host, port: input.port, user: input.user,
    database: input.database, auth: input.auth,
    tls: {mode: 'verify', serverName: input.host, caPath: input.caPath}
  });
  requireProof(profile.host === input.host && profile.user === input.user && profile.database === input.database,
    'fixture-contract');
  const ca = readFile(input.caPath, 2 * 1024 * 1024);
  const wrongCa = readFile(input.wrongCaPath, 2 * 1024 * 1024);
  const blocks = wrongCa.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) || [];
  requireProof(blocks.length === 1 && wrongCa.trim() === blocks[0], 'fixture-trust');
  const wrongRoot = new X509Certificate(blocks[0]);
  const approved = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) || [];
  requireProof(wrongRoot.ca && wrongRoot.checkIssued(wrongRoot) && wrongRoot.verify(wrongRoot.publicKey) &&
    approved.length > 0 && !approved.some(pem => {
      const trusted = new X509Certificate(pem);
      return trusted.fingerprint256 === wrongRoot.fingerprint256 || trusted.publicKey.equals(wrongRoot.publicKey);
    }), 'fixture-trust');
  return {provider, profile, ca, wrongCa, nonce: input.nonce};
}

function options(args, now = Date.now()) {
  let values, tokens;
  try {
    ({values, tokens} = parseArgs({args, tokens: true, options: {
      fixture: {type: 'string'}, 'with-rds-expiry': {type: 'boolean'}, deadline: {type: 'string'}
    }}));
  } catch { throw new ProofFailure('usage'); }
  requireProof(values.fixture && path.isAbsolute(values.fixture) && tokens.every(token => token.kind === 'option') &&
    new Set(tokens.map(token => token.name)).size === tokens.length, 'usage');
  const requested = values['with-rds-expiry'] === true;
  requireProof(requested === Boolean(values.deadline), 'expiry-approval');
  const deadline = requested ? Date.parse(values.deadline) : now + 120000;
  if (requested) requireProof(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(values.deadline) &&
    Number.isFinite(deadline) && new Date(deadline).toISOString().replace('.000Z', 'Z') === values.deadline &&
    deadline - now >= 16 * 60000 && deadline - now <= deadlineLimit, 'expiry-approval');
  return {fixture: values.fixture, requested, deadline};
}

function expiresAt(token, profile, now) {
  validateToken(token, profile, now);
  const params = new URL('https://' + token).searchParams;
  const date = params.get('X-Amz-Date');
  const iso = date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/u, '$1-$2-$3T$4:$5:$6Z');
  return Date.parse(iso) + Number(params.get('X-Amz-Expires')) * 1000;
}

function readOnlyMemoryProfile({verifyService, runConsole}) {
  const values = new Map();
  return createConnectionProfiles({
    state: {get: (key, fallback) => values.get(key) ?? fallback, async update(key, value) {values.set(key, value);}},
    secrets: {async get() {return undefined;}, async delete() {}, async store() {throw new ProofFailure('secret-storage');}},
    isTrusted: () => true,
    getActiveProfile: () => undefined,
    createService: verifyService,
    openProfileConsole: runConsole
  });
}

function intendedAccount(account, user) {
  if (typeof account !== 'string') return false;
  const suffix = account.lastIndexOf('@');
  return suffix > 0 && account.slice(0, suffix) === user;
}

function verifyProfile(result, {profile, ca}) {
  const digest = createHash('sha256').update(ca).digest('hex');
  requireProof(result.connected && result.tls && tlsVersions.has(result.tlsPeer?.protocol) &&
    result.tlsPeer.hostname === profile.host && result.tlsPeer.caMaterialSha256 === digest &&
    typeof result.cipher === 'string' && result.cipher.length && result.database === profile.database &&
    intendedAccount(result.currentUser, profile.user), 'live-profile');
  return result.tlsPeer.protocol;
}

async function verifyNonce(service, record, identity) {
  const result = await service.query(query, {maxRows: 2, timeoutMs: 10000});
  const [row] = result.rows || [];
  requireProof(result.rows?.length === 1 && !result.truncated && Array.isArray(row) && row.length === 4 &&
    intendedAccount(row[0], record.profile.user) && row[1] === record.profile.database &&
    identity.readOnly && String(row[2]) === String(identity.connectionId) && row[3] === record.nonce, 'live-read');
}

function checkPrepared(config, record) {
  requireProof(config.host === record.profile.host && config.port === record.profile.port &&
    config.user === record.profile.user && config.database === record.profile.database && config.readOnly === true &&
    config.ssl?.ca === record.ca && config.ssl.serverName === config.host && !config.password &&
    !config.transport && !config.ssh && JSON.stringify(config.auth) === JSON.stringify(record.profile.auth), 'fixture-drift');
}

function expectWireFailure(config, wrongCa, expired, signal, createConnection = mysql.createConnection) {
  requireProof(!signal.aborted, 'deadline');
  const {options: secure} = connectionSecurity(wrongCa ? {...config, ssl: {...config.ssl, ca: wrongCa}} : config);
  return new Promise((resolve, reject) => {
    let offered = false, stopped = false;
    const connection = createConnection({
      ...secure, port: config.port, user: config.user, database: config.database,
      password: '', connectTimeout: 5000, flags: '-LOCAL_FILES', multipleStatements: false,
      authPlugins: {mysql_clear_password: ({connection}) => () => {
        if (!expired || offered || signal.aborted || !verifiedSocket(connection.stream, config.host) ||
            Date.now() < expired.allowedAfter) throw new ProofFailure('wire-guard');
        offered = true;
        return Buffer.from(expired.value + '\0', 'utf8');
      }}
    });
    const stop = () => finish(new ProofFailure('deadline'));
    const phase = expired ? 'live-expired-token' : 'live-wrong-root';
    const timer = setTimeout(() => finish(new ProofFailure(phase)), 12000);
    function finish(error) {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      connection.destroy();
      if (error instanceof ProofFailure) reject(error);
      else if (expired && offered && error?.code === 'ER_ACCESS_DENIED_ERROR' ||
          !expired && !offered && ['HANDSHAKE_SSL_ERROR', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error?.code)) resolve();
      else reject(new ProofFailure(phase));
    }
    connection.on('error', finish);
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop();
    else {
      try {connection.connect(finish);}
      catch (error) {finish(error);}
    }
  });
}

async function verifyCloudFixture(record, run, {
  serviceFactory = (config, deps) => new MysqlService(config, deps),
  rds = mintRdsIamToken, azure = mintAzureMysqlEntraToken, wire = expectWireFailure,
  now = Date.now, wait = sleep
} = {}) {
  requireProof(!run.requested || record.provider === 'aws-rds-iam', 'expiry-approval');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, run.deadline - now()));
  const {signal} = controller;
  let stage = 'live-profile', protocol;
  let opened = false;
  const verifyService = config => {
    checkPrepared(config, record);
    return serviceFactory(config);
  };
  async function runConsole(config) {
    requireProof(!opened && !signal.aborted, 'deadline');
    opened = true;
    checkPrepared(config, record);
    let minted = 0;
    let expired;
    const deps = record.provider === 'aws-rds-iam' ? {
      async mintIamToken(target, opts) {
        const token = await rds(target, opts);
        if (++minted === 1 && run.requested) {
          const allowedAfter = expiresAt(token, record.profile, now()) + tokenGrace;
          requireProof(allowedAfter + reconnectBudget < run.deadline, 'expiry-deadline');
          expired = {value: token, allowedAfter};
        }
        return token;
      }
    } : {
      async mintAzureToken(target, opts) {
        const response = await azure(target, opts);
        minted++;
        return response;
      }
    };
    const service = serviceFactory(config, deps);
    const close = () => service.cancel('default');
    signal.addEventListener('abort', close, {once: true});
    try {
      stage = 'live-read';
      const first = await service.openSession('default', {readOnly: true});
      requireProof(first.connected && first.connectionId != null && minted === 1, stage);
      await verifyNonce(service, record, first);
      stage = 'live-wrong-root';
      await wire(config, record.wrongCa, undefined, signal);
      if (run.requested) {
        stage = 'live-expired-token';
        requireProof(expired && expired.allowedAfter + reconnectBudget < run.deadline, 'expiry-deadline');
        const remaining = expired.allowedAfter - now();
        if (remaining > 0) await wait(remaining, undefined, {signal});
        requireProof(!signal.aborted && now() >= expired.allowedAfter, stage);
        await wire(config, undefined, expired, signal);
        expired = undefined;
      }
      stage = 'live-reconnect';
      const next = await service.reconnect('default');
      requireProof(!signal.aborted && next.connected && next.connectionId != null &&
        String(next.connectionId) !== String(first.connectionId) && minted === 2, stage);
      await verifyNonce(service, record, next);
      return {provider: record.provider, outcome: 'verified', authenticatedAccountMatches: true,
        fixtureSchemaRead: true, verifiedTls: protocol, wrongRootRejected: true, freshPhysicalConnection: true,
        credentialAcquisitionPerConnection: true, expiredRdsTokenRejected: run.requested ? true : 'not-requested'};
    } finally {
      expired = undefined;
      signal.removeEventListener('abort', close);
      await service.dispose();
    }
  }
  const profiles = readOnlyMemoryProfile({verifyService, runConsole});
  const closeProfiles = () => void profiles.dispose();
  signal.addEventListener('abort', closeProfiles, {once: true});
  try {
    requireProof(run.deadline > now(), 'deadline');
    protocol = verifyProfile(await profiles.test({profile: record.profile}), record);
    const saved = await profiles.save({profile: record.profile, verify: false});
    requireProof(!saved.hasSavedPassword, 'secret-storage');
    return await profiles.openDedicatedConsole({id: saved.id, revision: saved.revision});
  } catch (error) {
    throw error instanceof ProofFailure ? error : new ProofFailure(signal.aborted ? 'deadline' : stage);
  } finally {
    signal.removeEventListener('abort', closeProfiles);
    clearTimeout(timer);
    await profiles.dispose();
  }
}

async function command(args) {
  let stage = 'usage', provider;
  try {
    const run = options(args);
    stage = 'fixture-contract';
    const record = parseFixture(JSON.parse(ordinaryFile(run.fixture, 16384)));
    provider = record.provider;
    const result = await verifyCloudFixture(record, run);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const reason = error instanceof ProofFailure ? error.stage : stage;
    process.stdout.write(JSON.stringify({outcome: 'unverified', ...(provider && {provider}), stage: reason}) + '\n');
    process.exitCode = provider ? 1 : 2;
  }
}

if (require.main === module) void command(process.argv.slice(2));

module.exports = {format, approval, options, parseFixture, verifyCloudFixture, expiresAt, expectWireFailure};
