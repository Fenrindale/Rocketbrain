'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { captureLocalDirectory, directoryPath, nameOf } = require('./directory-snapshot');
const { captureRemoteDirectory } = require('./remote-snapshot');
const { previewText } = require('./reviewed-file');

function digestState(snapshot) {
  return new Map([...snapshot.entries].map(([name, entry]) => [name, entry.sha256]));
}
const currentHash = (side, name) => side.entries.get(name)?.sha256 ?? null;
const previousHash = (side, name) => side.get(name) ?? null;
const delta = (prior, next) => prior === next ? 'unchanged' : prior === null ? 'added' : next === null ? 'deleted' : 'modified';
const location = side => row => side.entries.has(row) ? {
  sha256: currentHash(side, row), bytes: side.entries.get(row).bytes.length,
} : null;

function compareSnapshot(baseline, local, remote) {
  const names = new Set([...baseline.local.keys(), ...baseline.remote.keys(), ...local.entries.keys(), ...remote.entries.keys()]);
  const keys = new Map();
  const blockers = new Set([...local.skipped, ...remote.skipped].map(item => item.name.normalize('NFC').toLowerCase()));
  return [...names].sort((a, b) => a.localeCompare(b)).map(name => {
    const key = name.normalize('NFC').toLowerCase();
    if (keys.has(key) && keys.get(key) !== name) throw Error('The local and remote folder have ambiguous case or normalized names.');
    keys.set(key, name);
    const here = currentHash(local, name), there = currentHash(remote, name);
    const localChange = delta(previousHash(baseline.local, name), here);
    const remoteChange = delta(previousHash(baseline.remote, name), there);
    const localChanged = localChange !== 'unchanged', remoteChanged = remoteChange !== 'unchanged';
    let direction;
    if (blockers.has(key)) direction = 'type-conflict';
    else if (here === there) direction = 'aligned';
    else if (localChanged && remoteChanged) direction = 'conflict';
    else if (localChanged) direction = 'local';
    else if (remoteChanged) direction = 'remote';
    else direction = 'baseline-difference';
    return { name, direction, localChange, remoteChange, local: location(local)(name), remote: location(remote)(name),
      canReviewUpload: here !== null && ['local','baseline-difference'].includes(direction) };
  });
}

function createDeploymentWatch({ webdav, isTrusted = () => true, onChange = () => {}, pollMs = 10000, durationMs = 600000 } = {}) {
  let active;
  let disposed = false;

  function trusted() {
    if (disposed || !isTrusted()) throw Error('Open a trusted workspace to review deployment changes.');
  }
  function record(id) {
    trusted();
    if (!id || active?.id !== id) throw Error('Open an active deployment change review.');
    return active;
  }
  function view(session) {
    const { id, input, revision, baselineTime, observedAt, rows, status, failure, skipped } = session;
    return structuredClone({ id, revision, baselineTime, observedAt, protocol: input.protocol, route: input.label,
      localDirectory: input.localDirectory, remoteDirectory: input.remoteDirectory, rows, status, failure, skipped });
  }
  function notify(session) {
    if (active === session && session.rows) onChange(view(session));
  }

  function stop() {
    if (!active) return;
    const session = active;
    active = undefined;
    session.controller.abort(Error('The deployment change review has stopped.'));
    clearTimeout(session.pollTimer);
    clearTimeout(session.expiryTimer);
    session.input.credential = undefined;
  }

  function schedule(session) {
    clearTimeout(session.pollTimer);
    if (active !== session || !session.poll || session.status !== 'monitoring') return;
    session.pollTimer = setTimeout(() => {
      if (active === session) void refresh(session.id).catch(() => {});
    }, pollMs);
    session.pollTimer.unref?.();
  }

  async function capture(session) {
    const { input, controller } = session;
    const attempt = new AbortController();
    const signal = AbortSignal.any([controller.signal, attempt.signal]);
    const exclusions = input.protocol === 'webdav' ? input.profile.exclusions ?? [] : [];
    const [local, remote] = await Promise.all([
      captureLocalDirectory(input.workspaceRoot, input.localDirectory, {
        excluded: name => exclusions.some(rule => path.posix.matchesGlob(name, rule)), signal,
      }),
      captureRemoteDirectory({ ...input, directory: input.remoteDirectory }, signal, webdav),
    ]).finally(() => attempt.abort());
    record(session.id);
    const identity = JSON.stringify([local.identity, remote.identity]);
    if (session.identity !== undefined && session.identity !== identity) throw Error('The mapped deployment route changed. Open a new review.');
    const anchor = session.baseline ?? { local: digestState(local), remote: digestState(remote) };
    const rows = compareSnapshot(anchor, local, remote);
    session.identity = identity;
    session.baseline = anchor;
    session.baselineTime ??= new Date().toISOString();
    session.observedAt = new Date().toISOString();
    session.local = local;
    session.remote = remote;
    session.skipped = { local: local.skipped, remote: remote.skipped };
    session.rows = rows;
    session.status = session.poll ? 'monitoring' : 'ready';
    session.failure = undefined;
    session.revision++;
    notify(session);
    return view(session);
  }

  function refresh(id) {
    const session = record(id);
    if (session.pending) return session.pending;
    session.pending = (async () => {
      try { return await capture(session); }
      catch (error) {
        if (active === session) {
          session.status = 'paused';
          session.failure = error.message;
          notify(session);
        }
        throw error;
      } finally {
        session.pending = undefined;
        schedule(session);
      }
    })();
    return session.pending;
  }

  async function start(input) {
    trusted();
    const localDirectory = directoryPath(input.localDirectory), remoteDirectory = directoryPath(input.remoteDirectory);
    if (!['sftp','ftps','webdav'].includes(input.protocol) || !input.profile || typeof input.label !== 'string') {
      throw Error('Choose one configured remote deployment route.');
    }
    stop();
    const session = { id: randomUUID(), revision: 0, poll: input.poll === true, controller: new AbortController(),
      input: { protocol: input.protocol, profile: structuredClone(input.profile), label: input.label,
        workspaceRoot: input.workspaceRoot, localDirectory, remoteDirectory, credential: input.credential } };
    active = session;
    session.expiryTimer = setTimeout(() => {
      if (active !== session) return;
      session.status = 'stopped';
      notify(session);
      stop();
    }, durationMs);
    session.expiryTimer.unref?.();
    try { return await refresh(session.id); }
    catch (error) { if (active === session) stop(); throw error; }
  }

  function reset(id) {
    const session = record(id);
    if (session.pending || session.status === 'paused') throw Error('Refresh both deployment folders before resetting the baseline.');
    session.baseline = { local: digestState(session.local), remote: digestState(session.remote) };
    session.baselineTime = session.observedAt;
    session.rows = compareSnapshot(session.baseline, session.local, session.remote);
    session.revision++;
    notify(session);
    return view(session);
  }

  function selected(id, revision, filename) {
    const session = record(id);
    if (session.revision !== revision) throw Error('Choose a file from the latest observed deployment changes.');
    const name = nameOf(filename);
    const row = session.rows?.find(item => item.name === name);
    if (!row) throw Error('Choose a file listed in the deployment review.');
    return { session, row };
  }

  function diff(id, revision, filename) {
    const { session, row } = selected(id, revision, filename);
    const present = entry => !entry ? '' : previewText(entry.bytes) ??
      'Binary or large file · ' + entry.bytes.length + ' bytes · SHA-256 ' + entry.sha256 + '\n';
    return { row: structuredClone(row), local: present(session.local.entries.get(row.name)), remote: present(session.remote.entries.get(row.name)) };
  }

  function uploadInput(id, revision, filename) {
    const { session, row } = selected(id, revision, filename);
    if (session.pending || session.status === 'paused' || !row.canReviewUpload) {
      throw Error('Choose an observed local change before opening a fresh upload review.');
    }
    return { selection: structuredClone(row), route: structuredClone(session.input), observedLocalRoot: session.local.root };
  }

  return { start, refresh, reset, diff, uploadInput, view: id => view(record(id)), stop, dispose() { stop(); disposed = true; } };
}

module.exports = { createDeploymentWatch };
