'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { once, EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const { createSshJavaMapping } = require('./ssh-java-mapping');
const { workspacePath, packageName } = require('../java/workbench-model');

const loopback = '127.0.0.1';
const preparedLine = Buffer.from('ROCKETBRAIN_JDWP_PREPARED\n');
const readyLine = Buffer.from('ROCKETBRAIN_JDWP_READY\n');
const sourceBytes = 256 * 1024;

async function localSnapshot(root, selected) {
  const workspace = workspacePath(root, [root]);
  const file = workspacePath(selected, [workspace], { directory: false });
  if (!file.endsWith('.java') || path.relative(selected, file)) throw Error('Choose a physical saved local Java source.');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(sourceBytes)) throw Error('Choose a saved Java source up to 256 KiB.');
    const data = Buffer.alloc(Number(stat.size) + 1);
    let used = 0;
    while (used < data.length) {
      const { bytesRead } = await handle.read(data, used, data.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const current = await fs.lstat(file, { bigint: true });
    if (stat.size !== BigInt(used) || current.dev !== stat.dev || current.ino !== stat.ino ||
        current.mtimeNs !== stat.mtimeNs || current.size !== stat.size || path.relative(file, await fs.realpath(file))) {
      throw Error('The saved local Java source changed while reading it.');
    }
    const bytes = data.subarray(0, used);
    const parsed = packageName(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof parsed !== 'string') throw Error('Choose a Java source with a valid package declaration.');
    const relative = path.relative(workspace, file).split(path.sep);
    const declared = parsed ? parsed.split('.') : [];
    const firstPackage = relative.length - declared.length - 1;
    if (firstPackage < 0 || declared.some((part, index) => part !== relative[firstPackage + index])) {
      throw Error('The local source path must match its Java package.');
    }
    return { workspace, file, remoteFile: '/' + relative.join('/'),
      sourceRoot: path.join(workspace, ...relative.slice(0, firstPackage)),
      sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

async function matchingSource(peer, root, file) {
  const local = await localSnapshot(root, file);
  createSshJavaMapping(peer.root).toRemote(local.remoteFile);
  const remote = await peer.read(local.remoteFile);
  if (remote.sha256 !== local.sha256) throw Error('Save the exact same Java source at the corresponding local and SSH paths.');
  return local;
}

function relayReady(child, marker) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const unavailable = () => settled(Error('The SSH host did not confirm the reviewed JVM and established socket.'));
    const timeout = setTimeout(unavailable, 25000);
    function settled(error) {
      clearTimeout(timeout);
      child.stdout.off('data', receive);
      child.off('close', unavailable);
      child.off('error', unavailable);
      if (error) reject(error);
      else resolve();
    }
    function receive(chunk) {
      if (data.length + chunk.length > marker.length) return unavailable();
      data = Buffer.concat([data, chunk]);
      if (!marker.subarray(0, data.length).equals(data)) return unavailable();
      if (data.length === marker.length) {
        child.stdout.pause();
        settled();
      }
    }
    child.stderr.resume();
    child.once('close', unavailable);
    child.once('error', unavailable);
    child.stdout.on('data', receive);
    child.stdout.resume();
  });
}

async function openSingleJdwpRelay(child, validateSource) {
  const events = new EventEmitter();
  const server = net.createServer();
  let client, waitTimer, closing, invalid = false;
  const ended = once(child, 'close');
  void ended.catch(() => {});

  function close() {
    if (closing) return closing;
    invalid = true;
    clearTimeout(waitTimer);
    closing = (async () => {
      client?.destroy();
      const listener = new Promise(resolve => server.close(() => resolve()));
      child.stdin.end();
      const force = setTimeout(() => child.kill(), 2200);
      try { await Promise.allSettled([listener, ended]); }
      finally { clearTimeout(force); events.emit('closed'); events.removeAllListeners(); }
    })();
    return closing;
  }

  child.once('close', () => { void close(); });
  child.once('error', () => { void close(); });
  try {
    await relayReady(child, preparedLine);
    await validateSource();
    if (invalid) throw Error('The reviewed SSH debug channel closed.');
    server.on('connection', async socket => {
      if (invalid || client) return socket.destroy();
      client = socket;
      clearTimeout(waitTimer);
      server.close();
      socket.setNoDelay(true);
      socket.on('error', () => { void close(); });
      socket.on('close', () => { void close(); });
      try {
        const ready = relayReady(child, readyLine);
        child.stdin.write('1');
        await ready;
        if (invalid) return;
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
      } catch { void close(); }
    });
    const localPort = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, loopback, () => { server.off('error', reject); resolve(server.address().port); });
    });
    server.on('error', () => { void close(); });
    if (invalid) throw Error('The reviewed SSH debug channel closed.');
    waitTimer = setTimeout(() => { void close(); }, 20000);
    waitTimer.unref();
    return { host: loopback, localPort, close,
      isClosed: () => invalid,
      onClose(listener) {
        if (invalid) queueMicrotask(listener);
        else events.once('closed', listener);
        return { dispose() { events.off('closed', listener); } };
      } };
  } catch (error) {
    await close();
    throw error;
  }
}

function createSshJavaDebug({ current, trusted, saved }) {
  let pending;
  let opening = false;

  function check(peer) {
    trusted();
    if (!peer || peer !== current()) throw Error('Open the verified SSH workspace again.');
  }

  return {
    async review(peer, root, request) {
      check(peer);
      saved(request.file);
      const source = await matchingSource(peer, root, request.file);
      const remote = await peer.inspectProcess('debug', request);
      check(peer);
      const token = randomUUID();
      pending = { token, peer, source, remote, expires: Date.now() + 85000 };
      return { ...remote, token, sourceFile: source.file, remoteFile: source.remoteFile, sourceRoot: source.sourceRoot };
    },
    async open(peer, root, confirmation) {
      check(peer);
      if (confirmation?.allowSshJavaDebug !== true || !pending || pending.token !== confirmation.token ||
          typeof confirmation.sourceFile !== 'string' || path.relative(pending.source.file, confirmation.sourceFile) ||
          pending.peer !== peer || pending.expires <= Date.now() || path.relative(pending.source.workspace, root)) {
        throw Error('Approve the current SSH Java debug review.');
      }
      const review = pending;
      pending = undefined;
      if (opening) throw Error('Wait for the reviewed SSH Java debug channel.');
      opening = true;
      let relay;
      try {
        saved(review.source.file);
        const now = await matchingSource(peer, root, review.source.file);
        if (now.sha256 !== review.source.sha256) throw Error('The Java source changed after review.');
        check(peer);
        const child = await peer.openProcess('debug', { token: review.remote.token, allowRemoteProcess: true });
        relay = await openSingleJdwpRelay(child, async () => {
          check(peer);
          saved(review.source.file);
          const latest = await matchingSource(peer, root, review.source.file);
          if (latest.sha256 !== review.source.sha256) throw Error('The reviewed SSH debug source changed.');
        });
        check(peer);
        return { ...relay, id: randomUUID(), sourceFile: review.source.file, sourceRoot: review.source.sourceRoot,
          remoteRoot: peer.root, pid: review.remote.pid, startedAt: review.remote.startedAt };
      } catch (error) {
        await relay?.close();
        throw error;
      } finally { opening = false; }
    },
    clear() { pending = undefined; }
  };
}

module.exports = { createSshJavaDebug, localSnapshot, openSingleJdwpRelay };
