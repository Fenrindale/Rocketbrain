'use strict';

const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID, X509Certificate } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { fail, cancelled, local } = require('./workbench-model');
const { contextPattern, MAX_WAR_BYTES } = require('./jakarta-war');
const { hashArchive } = require('./jakarta-tomcat');
const { createManagerHistory, contextRows, listedVersion, publicVersion, managedActions } = require('./jakarta-manager-history');

const MAX_RESPONSE = 256 * 1024;
const MAX_CA = 128 * 1024;
const MAX_APPS = 512;
const PLAN_MS = 2 * 60 * 1000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => !path.relative(left, right);

function managerOrigin(value) {
  let url;
  try {
    if (typeof value === 'string' && value.length <= 512 && !/[\s\u0000-\u001f\u007f]/u.test(value)) url = new URL(value);
  } catch { /* The validation below gives a stable error. */ }
  if (url?.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw fail('Use the exact HTTPS origin of the approved Tomcat Manager server, without a path or credentials.');
  }
  return url.origin;
}

function managerContext(value) {
  const context = typeof value === 'string' ? value.replace(/^\//u, '') : '';
  if (!contextPattern.test(context) || context === 'manager' || context === 'host-manager') {
    throw fail('Use one named Tomcat application context with lowercase letters, digits or hyphens.');
  }
  return '/' + context;
}

function credentials(username, password) {
  if (typeof username !== 'string' || !username || username.length > 120 || /[:\u0000-\u001f\u007f]/u.test(username) ||
      typeof password !== 'string' || !password || password.length > 1024 || /[\u0000-\u001f\u007f]/u.test(password)) {
    throw fail('Enter a valid Tomcat Manager username and password for this attempt.');
  }
  return 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64');
}

async function authority(caFile) {
  if (caFile === undefined) return {};
  const file = path.resolve(local(caFile));
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CA || !samePath(await fsp.realpath(file), file)) {
    throw fail('Choose a bounded physical certificate authority PEM.');
  }
  const handle = await fsp.open(file, 'r');
  let bytes;
  try {
    const opened = await handle.stat();
    if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw fail('The selected certificate file changed.');
    bytes = Buffer.alloc(MAX_CA + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_CA || bytesRead !== stat.size) throw fail('The selected certificate file changed.');
    bytes = bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const ca = bytes.toString('utf8');
  const certs = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) || [];
  if (!certs.length || certs.length > 8 || ca.replaceAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, '').trim()) {
    throw fail('The selected PEM must contain only certificate authority certificates.');
  }
  try {
    if (certs.some(cert => !new X509Certificate(cert).ca)) throw Error('The PEM includes a non-CA certificate.');
  }
  catch { throw fail('The selected certificate authority PEM is invalid.'); }
  return { ca, caSha256: sha256(bytes), caFile: file };
}

function managerRequest({ origin, authorization, ca, pin, command, context, version, archive, update, signal }) {
  const url = new URL('/manager/text/' + command, origin);
  if (context) url.searchParams.set('path', context);
  if (version) url.searchParams.set('version', version);
  if (update) url.searchParams.set('update', 'true');
  const headers = { Authorization: authorization, Accept: 'text/plain', 'Accept-Language': 'en' };
  if (archive) Object.assign(headers, { 'Content-Type': 'application/octet-stream', 'Content-Length': archive.size });
  return new Promise((resolve, reject) => {
    let fingerprint;
    const request = https.request(url, { method: archive ? 'PUT' : 'GET', signal, headers, agent: false, ca,
      rejectUnauthorized: true, minVersion: 'TLSv1.2',
      checkServerIdentity(host, certificate) {
        const mismatch = tls.checkServerIdentity(host, certificate);
        if (mismatch) return mismatch;
        fingerprint = certificate.raw && sha256(certificate.raw);
        if (!fingerprint || pin && fingerprint !== pin) return fail('The reviewed Tomcat TLS certificate changed.');
      }
    }, response => {
      const parts = [];
      let bytes = 0;
      response.on('data', part => {
        bytes += part.length;
        if (bytes > MAX_RESPONSE) request.destroy(fail('Tomcat Manager returned too much data.'));
        else parts.push(part);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode === 401 || response.statusCode === 403) throw fail('Tomcat Manager denied access for this attempt.');
          if (response.statusCode !== 200 || !/^text\/plain(?:;|$)/iu.test(response.headers['content-type'] || '') || !fingerprint) {
            throw fail('Tomcat Manager did not return a verified text response.');
          }
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
          resolve({ text, fingerprint });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(fail('The Tomcat Manager request timed out.')), 30000);
    request.once('close', () => clearTimeout(timer));
    request.once('error', error => reject(error.code === 'ROCKETBRAIN_JAVA_WORKBENCH' ? error :
      fail('Tomcat Manager TLS or connection verification failed.')));
    if (archive) void pipeline(fs.createReadStream(archive.file), request).catch(reject);
    else request.end();
  });
}

function parseList(text) {
  const [header, ...lines] = text.trimEnd().split(/\r?\n/u);
  if (!/^OK - Listed applications for virtual host \[[^\]\r\n]+\]$/u.test(header) || lines.length > MAX_APPS) {
    throw fail('Tomcat Manager did not return a bounded application list.');
  }
  const items = [];
  for (const line of lines) {
    const entry = /^(\/[^:\u0000-\u001f\u007f]*):(running|stopped):(\d{1,10}):([^\u0000-\u001f\u007f]{1,4096})$/u.exec(line);
    if (!entry) throw fail('Tomcat Manager returned an unsupported application list.');
    items.push({ context: entry[1], state: entry[2], sessions: Number(entry[3]), location: entry[4] });
  }
  return items;
}

function visibleApp(item) {
  const { context, state, sessions } = item, version = publicVersion(item);
  return { context, state, sessions, ...(version && { version }) };
}
function appAt(list, context) {
  const choices = contextRows(list, context);
  if (choices.length > 1 || choices.length && (choices[0].context !== context || listedVersion(choices[0]) !== undefined)) {
    throw fail('This context uses multiple or parallel deployments. Choose one ordinary context.');
  }
  return choices[0];
}

function targetIdentity(item) {
  return item && JSON.stringify([item.context, item.state, item.location]);
}

async function withStagedWar(artifact, digest, work) {
  if (!artifact) return work();
  const parent = await fsp.realpath(os.tmpdir());
  const directory = await fsp.mkdtemp(path.join(parent, 'rb-manager-war-'));
  const identity = await fsp.lstat(directory, { bigint: true });
  const release = async () => {
    const current = await fsp.realpath(directory), stat = await fsp.lstat(current, { bigint: true });
    if (!samePath(current, directory) || !samePath(path.dirname(current), parent) ||
        !path.basename(current).startsWith('rb-manager-war-') || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw fail('The owned Manager upload directory changed before cleanup.');
    }
    await fsp.rm(current, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  };
  let retained = false;
  try {
    const file = path.join(directory, 'reviewed.war');
    await hashArchive(artifact, { expectedSha256: digest, destination: file });
    return await work({ file, size: artifact.size }, () => {
      retained = true;
      return { artifact: { file, size: artifact.size, name: artifact.name }, release };
    });
  } finally {
    if (!retained) await release();
  }
}

function createTomcatManager() {
  let disposed = false, mutating, closing;
  const plans = new Map(), attempts = new Set();
  const history = createManagerHistory();
  function approved(allowed, cancellation) {
    if (disposed || allowed !== true) throw fail('Explicitly approve access to the selected Tomcat Manager endpoint.');
    if (cancelled(cancellation)) throw fail('The Tomcat Manager operation was cancelled.');
  }

  async function attempt(cancellation, work) {
    const controller = new AbortController(), abort = () => controller.abort();
    const subscription = cancellation?.onCancellationRequested?.(abort);
    cancellation?.addEventListener?.('abort', abort, { once: true });
    attempts.add(controller);
    if (cancelled(cancellation) || disposed) abort();
    try { return await work(controller.signal); }
    finally {
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort', abort);
      attempts.delete(controller);
    }
  }

  async function list(settings, signal, pin) {
    const result = await managerRequest({ ...settings, command: 'list', signal, pin });
    const applications = parseList(result.text);
    const virtualHost = result.text.split(/\r?\n/u, 1)[0].slice('OK - Listed applications for virtual host ['.length, -1);
    return { fingerprint: result.fingerprint, virtualHost, applications };
  }

  async function observe({ origin, username, password, caFile, allowManagerAccess, cancellation } = {}) {
    approved(allowManagerAccess, cancellation);
    const endpoint = managerOrigin(origin), auth = credentials(username, password), { ca } = await authority(caFile);
    const found = await attempt(cancellation, signal => list({ origin: endpoint, authorization: auth, ca }, signal));
    return { origin: endpoint, certificateSha256: found.fingerprint, applications: found.applications.map(visibleApp) };
  }

  async function review({ origin, username, password, caFile, action, context, artifact, allowManagerAccess, cancellation } = {}) {
    approved(allowManagerAccess, cancellation);
    const managed = managedActions.has(action);
    if (!managed && !['deploy', 'update', 'undeploy'].includes(action)) throw fail('Choose one supported Tomcat Manager action.');
    if (action !== 'undeploy' && action !== 'restore' &&
        (!artifact?.file || !Number.isSafeInteger(artifact.size) || artifact.size < 4 || artifact.size > MAX_WAR_BYTES)) {
      throw fail('Select the Maven WAR artifact to review.');
    }
    const target = managerContext(context), endpoint = managerOrigin(origin), auth = credentials(username, password);
    const verified = await authority(caFile);
    const observed = await attempt(cancellation, signal => list({ origin: endpoint, authorization: auth, ca: verified.ca }, signal));
    const tracked = managed && history.inspect({ action, origin: endpoint, context: target, username,
      certificateSha256: observed.fingerprint, caSha256: verified.caSha256, virtualHost: observed.virtualHost }, observed.applications);
    const baseline = managed ? undefined : appAt(observed.applications, target);
    if (!managed && (action === 'deploy' ? baseline : !baseline)) {
      throw fail(action === 'deploy' ? 'This context already exists. Review an update explicitly.' : 'The selected context is no longer listed.');
    }
    const current = baseline || (tracked?.current && observed.applications.find(item =>
      item.context === target && item.location === tracked.current.location));
    const sourceArtifact = action === 'restore' ? tracked.previous.artifact : action === 'undeploy' ? undefined : artifact;
    if (tracked?.current) await hashArchive(tracked.current.artifact, { expectedSha256: tracked.current.sha256 });
    if (tracked && action !== 'restore') history.verifyCapacity(sourceArtifact.size);
    const uploadedSha256 = sourceArtifact && await hashArchive(sourceArtifact, { expectedSha256: tracked?.previous?.sha256 });
    if (action === 'track-update' && uploadedSha256 === tracked.current.sha256) {
      throw fail('Select a WAR with different bytes from the latest tracked deployment.');
    }
    approved(allowManagerAccess, cancellation);
    const plan = { id: randomUUID(), origin: endpoint, context: target, action,
      certificateSha256: observed.fingerprint, expiresAt: Date.now() + PLAN_MS,
      application: current && visibleApp(current), ...(sourceArtifact && { artifact: sourceArtifact.name, uploadedSha256 }),
      ...(tracked && { nextRevision: tracked.nextRevision, retainedVersions: tracked.revisions.map(revision => revision.version),
        ...(tracked.current && { currentVersion: tracked.current.version, currentSha256: tracked.current.sha256 }),
        ...(tracked.previous && { restoreFromVersion: tracked.previous.version }) }) };
    for (const [id, entry] of plans) if (Date.now() >= entry.plan.expiresAt) plans.delete(id);
    if (plans.size >= 8) plans.delete(plans.keys().next().value);
    plans.set(plan.id, { plan, username, caFile: verified.caFile, caSha256: verified.caSha256,
      baseline: targetIdentity(baseline), artifact: sourceArtifact && { ...sourceArtifact }, tracked });
    return structuredClone(plan);
  }

  async function execute({ reviewId, username, password, allowExecute, cancellation } = {}) {
    approved(allowExecute, cancellation);
    const entry = plans.get(reviewId);
    if (!entry || entry.plan.expiresAt <= Date.now() || entry.username !== username) {
      throw fail('Review the current Tomcat target and WAR again before executing.');
    }
    if (mutating) throw fail('Wait for the current Tomcat Manager operation to finish.');
    const authorization = credentials(username, password);
    const { plan, tracked } = entry, { origin, certificateSha256: pin, action, context, uploadedSha256 } = plan;
    plans.delete(reviewId);
    let finished;
    mutating = new Promise(resolve => { finished = resolve; });
    try {
      const { ca, caSha256 } = await authority(entry.caFile);
      if (caSha256 !== entry.caSha256) throw fail('The reviewed Tomcat certificate authority changed.');
      const settings = { origin, authorization, ca };
      return await attempt(cancellation, signal => withStagedWar(entry.artifact, uploadedSha256, async (archive, retain) => {
        if (tracked?.current) await hashArchive(tracked.current.artifact, { expectedSha256: tracked.current.sha256 });
        if (tracked && action !== 'restore') history.verifyCapacity(archive.size);
        const before = await list(settings, signal, pin);
        if (tracked) history.beforeUpload(tracked, before);
        else if (entry.baseline !== targetIdentity(appAt(before.applications, context))) {
          throw fail('The reviewed application state changed. Review the Tomcat context again.');
        }
        approved(allowExecute, signal);
        if (Date.now() >= plan.expiresAt) throw fail('The Tomcat deployment review expired before execution.');
        // The server checks listed contexts, so allocate a fresh doc base only at upload.
        const version = tracked && 'rb' + String(tracked.nextRevision).padStart(3, '0') + '-' + randomUUID().replaceAll('-', '');
        const receipt = { origin, action, context, ...(uploadedSha256 && { uploadedSha256 }), ...(version && { version }) };
        const unconfirmed = reason => {
          if (tracked) history.invalidate(tracked);
          return { ...receipt, state: 'unconfirmed', reason };
        };
        try {
          const command = action === 'undeploy' ? 'undeploy' : 'deploy';
          const result = await managerRequest({ ...settings, signal, pin, command, context, version, archive, update: action === 'update' });
          const verb = command === 'deploy' ? 'Deployed' : 'Undeployed';
          const displayPath = version ? context + '##' + version : context;
          if (result.text.trimEnd() !== `OK - ${verb} application at context path [${displayPath}]`) {
            return unconfirmed('manager-response');
          }
          const after = await list(settings, signal, pin);
          if (tracked) {
            const found = history.confirm(tracked, version, after, uploadedSha256, action === 'restore' ? undefined : retain);
            if (!found) {
              return unconfirmed('application-state');
            }
            return { ...receipt, state: 'confirmed', application: visibleApp(found) };
          }
          const found = appAt(after.applications, context);
          if (action === 'undeploy' ? found : found?.state !== 'running') {
            return unconfirmed('application-state');
          }
          return { ...receipt, state: 'confirmed', ...(found && { application: visibleApp(found) }) };
        } catch {
          return unconfirmed('response-lost-or-unverifiable');
        }
      }));
    } finally { mutating = undefined; finished(); }
  }

  return { observe, review, execute, dispose() {
    if (closing) return closing;
    disposed = true;
    plans.clear();
    for (const attempt of attempts) attempt.abort();
    closing = Promise.resolve(mutating).then(() => history.dispose());
    return closing;
  } };
}

module.exports = { createTomcatManager, managerOrigin, managerContext, parseList };
