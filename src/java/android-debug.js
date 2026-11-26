'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { inside } = require('./workbench-model');
const { independentJavaExecutable } = require('./debug-runtime');
const { createAdb, connectAdbJdwp, androidTools, qualified, loopback } = require('./android-adb');

const identifier = /^[A-Za-z][A-Za-z0-9_]{0,95}$/u;
const maxApkSize = 256 * 1024 * 1024;
const helperName = 'AndroidBreakpoint.java';

async function fingerprint(file, root, limit, includeText) {
  if (!path.isAbsolute(file || '')) throw Error('Choose a physical file in the opened Android workspace.');
  const real = await fsp.realpath(file);
  const before = await fsp.lstat(file, { bigint: true });
  if ((root && !inside(root, real)) || path.relative(file, real) || !before.isFile() || before.size > BigInt(limit)) {
    throw Error('Choose a bounded physical file inside the Android workspace.');
  }
  const hash = createHash('sha256'), parts = [];
  let size = 0;
  for await (const chunk of fs.createReadStream(real)) {
    if ((size += chunk.length) > limit) throw Error('The reviewed Android input exceeded its size limit.');
    hash.update(chunk);
    if (includeText) parts.push(chunk);
  }
  const after = await fsp.lstat(file, { bigint: true });
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs ||
      before.size !== after.size || BigInt(size) !== before.size) throw Error('The reviewed Android input changed while being read.');
  return { file: real, sha256: hash.digest('hex'),
    ...(includeText && { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) }) };
}

function kotlinLocation(file, source, line) {
  const base = path.basename(file, '.kt');
  const matches = [...source.matchAll(/^\s*package[ \t]+([A-Za-z][\w.]*)[ \t]*;?[ \t]*$/gmu)];
  const pkg = matches.length === 1 ? matches[0][1] : '';
  const type = pkg + '.' + base;
  if (path.extname(file) !== '.kt' || !identifier.test(base) || !qualified.test(type) || type.length > 220 ||
      !Number.isSafeInteger(line) || line < 1 || line > 9999999 || !source.split(/\r?\n/u)[line - 1]?.trim()) {
    throw Error('Choose a nonempty saved Kotlin line in a conventionally named packaged class.');
  }
  return { className: type, fileName: base + '.kt', line };
}

async function singleRelay(transport, verify) {
  const server = net.createServer({ pauseOnConnect: true });
  let client, peer, stopped = false, timer;
  function close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    client?.destroy();
    peer?.destroy();
    if (server.listening) server.close();
  }
  server.on('connection', async socket => {
    if (stopped || client) return socket.destroy();
    client = socket;
    server.close();
    socket.once('close', close);
    socket.once('error', close);
    try {
      await verify();
      if (stopped) return;
      const connected = await transport();
      if (stopped) return connected.destroy();
      peer = connected;
      peer.once('error', close);
      peer.once('close', close);
      await verify();
      if (stopped || peer.destroyed || socket.destroyed) return close();
      clearTimeout(timer);
      socket.pipe(peer);
      peer.pipe(socket);
      socket.resume();
    } catch { close(); }
  });
  const localPort = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopback, () => { server.off('error', reject); resolve(server.address().port); });
  });
  server.once('error', close);
  timer = setTimeout(close, 25000);
  timer.unref();
  return { host: loopback, localPort, close };
}

function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function watchAndroidBreakpoint(java, helper, relay, source, outcome) {
  const child = spawn(java, ['--add-modules', 'jdk.jdi', '--source', '25', helper, String(relay.localPort),
    source.className, source.fileName, String(source.line)],
  { cwd: path.dirname(helper), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = gate(), hit = gate(), resumed = gate(), done = gate();
  let state = 'starting', line = '', failure, closing;
  const timer = setTimeout(() => { fail(Error('The owned Android source session expired.')); child.kill(); }, 150000);
  timer.unref();
  const startup = setTimeout(() => { if (state === 'starting') { fail(Error('Android JDWP did not attach through the reviewed relay.')); child.kill(); } }, 30000);
  startup.unref();
  function fail(error) {
    failure ||= error;
    ready.reject(error);
    hit.reject(error);
    resumed.reject(error);
  }
  function record(message) {
    if (message.startsWith('ERROR ')) return fail(Error(message.slice(6, 350)));
    if (state === 'starting' && (message === 'WAITING' || message === 'READY')) {
      state = 'waiting';
      ready.resolve();
      return;
    }
    if (state === 'waiting' && message === 'READY') return;
    if (state === 'waiting' && message.startsWith('STOP ')) {
      const values = JSON.parse(message.slice(5));
      if (!Array.isArray(values) || values.length < 1 || values.length > 32 ||
          values.some(row => !/^[A-Za-z_][A-Za-z0-9_]{0,95}$/u.test(row?.name || '') ||
            !/^(boolean|byte|char|short|int|long|float|double)$/u.test(row.type || '') ||
            typeof row.value !== 'string' || !/^[0-9A-Za-z.+-]{1,80}$/u.test(row.value))) throw Error('Invalid Android primitive local values.');
      state = 'stopped';
      hit.resolve(values);
      return;
    }
    if (state === 'resuming' && message === 'CONTINUED') {
      state = 'continued';
      resumed.resolve();
      return;
    }
    throw Error('Unexpected Android JDI helper response.');
  }
  child.stdout.setEncoding('utf8').on('data', chunk => {
    line += chunk;
    if (line.length > 32 * 1024) { fail(Error('Android debugger output exceeded its bound.')); return child.kill(); }
    try {
      for (let next; (next = line.indexOf('\n')) >= 0;) {
        record(line.slice(0, next).trimEnd());
        line = line.slice(next + 1);
      }
    } catch (error) { fail(error); child.kill(); }
  });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.once('error', error => fail(error));
  child.once('close', code => {
    relay.close();
    clearTimeout(timer);
    clearTimeout(startup);
    if (state !== 'continued' && !failure) fail(Error('The Android debug session ended before continuation.'));
    done.resolve();
    outcome(state === 'continued' && code === 0 ? undefined : failure || Error('The Android debugger exited.'));
  });
  return {
    ready: ready.promise, hit: hit.promise,
    async resume() {
      if (state !== 'stopped') throw Error('Wait for the reviewed Android breakpoint before continuing.');
      state = 'resuming';
      child.stdin.end('continue\n');
      await resumed.promise;
    },
    close() {
      if (!closing) closing = (async () => {
        child.stdin.end('cancel\n');
        relay.close();
        const kill = setTimeout(() => child.kill(), 1600);
        try { await done.promise; }
        finally { clearTimeout(kill); }
      })();
      return closing;
    }
  };
}

async function helperPath() {
  for (const candidate of [path.join(__dirname, 'android-debug', helperName),
    path.join(__dirname, '../../runtime/android-debug', helperName)]) {
    const stat = await fsp.lstat(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat?.isFile()) return candidate;
  }
  throw Error('The independent Android breakpoint observer is missing.');
}

function createAndroidDebug({ trusted, saved = () => {}, getTools, openAdb = createAdb,
  connect = connectAdbJdwp, startObserver = watchAndroidBreakpoint, observerFile = helperPath } = {}) {
  const reviews = new Map();
  let active, disposed = false;

  function assertTrusted() {
    trusted();
    if (disposed) throw Error('The Android debug workbench is closed.');
  }

  async function toolSetup() {
    const config = await getTools();
    const tools = await androidTools(config.sdk, config.buildTools, config.port);
    const java = independentJavaExecutable(path.join(config.javaHome || '', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    const stamps = await Promise.all([tools.adb, tools.aapt2, java].map(file => fingerprint(file, null, 64 * 1024 * 1024)));
    return { ...tools, java, identity: JSON.stringify([tools.port, ...stamps]) };
  }

  async function devices() {
    assertTrusted();
    return openAdb(await toolSetup()).devices();
  }

  async function review({ root, apk, file, line, serial }) {
    assertTrusted();
    if (!path.isAbsolute(root || '') || path.extname(apk || '').toLowerCase() !== '.apk') throw Error('Choose a local Android workspace and a published APK.');
    root = await fsp.realpath(root);
    saved(file);
    const tools = await toolSetup(), adb = openAdb(tools);
    const [artifact, source, device] = await Promise.all([fingerprint(apk, root, maxApkSize),
      fingerprint(file, root, 1024 * 1024, true), adb.observe(serial)]);
    const location = kotlinLocation(source.file, source.text, line);
    const metadata = await adb.inspect(artifact.file);
    if (await adb.present(device, metadata.packageName)) throw Error('This package already exists on the selected emulator. Use a clean deployment target.');
    const token = randomUUID(), expires = Date.now() + 90000;
    for (const [id, item] of reviews) if (item.expires <= Date.now()) reviews.delete(id);
    if (reviews.size >= 12) reviews.delete(reviews.keys().next().value);
    reviews.set(token, { root, artifact, source: { file: source.file, sha256: source.sha256, ...location }, device, metadata, tools, expires });
    return Object.freeze({ token, apk: artifact.file, apkSha256: artifact.sha256, source: source.file, sourceLine: line,
      className: location.className, packageName: metadata.packageName, activity: metadata.activity, serial: device.serial, avd: device.avd });
  }

  async function start(token, allowAndroidInstall) {
    assertTrusted();
    if (allowAndroidInstall !== true) throw Error('Approve the reviewed temporary APK install on the selected Android emulator.');
    const record = reviews.get(token);
    reviews.delete(token);
    if (!record || record.expires < Date.now() || active) throw Error('Review the current Android APK again after stopping any active session.');
    const { root, artifact, source, device, metadata, tools } = record;
    const controller = new AbortController(), ownership = { controller };
    active = ownership;
    const adb = openAdb(tools);
    let stage, scratchParent, identity, observer, relay, base, cleaned, started = false, phase = 'preparing';

    async function verifyInputs() {
      assertTrusted();
      if (controller.signal.aborted) throw Error('The Android debug session was stopped.');
      saved(source.file);
      const [apk, kt] = await Promise.all([fingerprint(artifact.file, root, maxApkSize),
        fingerprint(source.file, root, 1024 * 1024)]);
      if (apk.sha256 !== artifact.sha256 || kt.sha256 !== source.sha256) throw Error('The reviewed APK or Kotlin source changed.');
    }
    function close() {
      if (!cleaned) cleaned = (async () => {
        controller.abort();
        try {
          await observer?.close();
          relay?.close();
          if (base) {
            await adb.verify(device);
            if (await adb.installed(device, metadata.packageName, artifact.sha256) !== base) {
              throw Error('The Android installation identity changed and was left in place.');
            }
            await adb.uninstall(device, metadata.packageName);
          }
        } finally {
          try {
            if (stage) {
              const real = await fsp.realpath(stage), current = await fsp.lstat(real, { bigint: true });
              if (real !== stage || path.dirname(real) !== scratchParent || !path.basename(real).startsWith('rb-android-debug-') ||
                  current.dev !== identity.dev || current.ino !== identity.ino) throw Error('The Android debug staging identity changed.');
              await fsp.rm(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            }
          } finally { if (active === ownership) active = undefined; }
        }
      })();
      return cleaned;
    }
    ownership.stop = () => { controller.abort(); return ownership.result?.catch(() => {}).then(close) || close(); };
    ownership.result = (async () => {
      try {
        if ((await toolSetup()).identity !== tools.identity) throw Error('The reviewed Android SDK or Java runtime changed.');
        await Promise.all([verifyInputs(), adb.verify(device)]);
        if (await adb.present(device, metadata.packageName)) throw Error('The reviewed Android package now already exists.');
        scratchParent = await fsp.realpath(os.tmpdir());
        stage = await fsp.mkdtemp(path.join(scratchParent, 'rb-android-debug-'));
        identity = await fsp.lstat(stage, { bigint: true });
        const retained = path.join(stage, 'reviewed.apk');
        await fsp.copyFile(artifact.file, retained, fs.constants.COPYFILE_EXCL);
        if ((await fingerprint(retained, stage, maxApkSize)).sha256 !== artifact.sha256) throw Error('The retained APK changed before install.');
        const selected = await adb.inspect(retained);
        if (selected.packageName !== metadata.packageName || selected.activity !== metadata.activity) throw Error('The retained APK activity changed.');
        await adb.verify(device);
        if (controller.signal.aborted) throw Error('The Android debug session was stopped.');
        await adb.install(device, retained);
        base = await adb.installed(device, metadata.packageName, artifact.sha256);
        await adb.verify(device);
        await adb.launch(device, metadata);
        let target;
        const end = Date.now() + 20000;
        while (!target && Date.now() < end && !controller.signal.aborted) {
          target = await adb.appProcess(device, metadata.packageName);
          if (!target) await delay(350);
        }
        if (!target) throw Error('The owned Android app did not advertise a debuggable ART process.');
        const verifyTarget = async () => {
          await Promise.all([verifyInputs(), adb.verify(device)]);
          if (await adb.installed(device, metadata.packageName, artifact.sha256) !== base) throw Error('The owned Android app path changed.');
          const current = await adb.appProcess(device, metadata.packageName);
          if (current?.pid !== target.pid || current.startedAt !== target.startedAt) throw Error('The reviewed Android app PID or start time changed.');
        };
        relay = await singleRelay(() => connect(tools.port, device.transportId, target.pid), verifyTarget);
        const helper = path.join(stage, helperName);
        await fsp.copyFile(await observerFile(), helper, fs.constants.COPYFILE_EXCL);
        observer = startObserver(tools.java, helper, relay, source, error => {
          if (error && started && phase !== 'closed') void close().catch(() => {});
        });
        await observer.ready;
        phase = 'waiting';
        const stopped = observer.hit.then(async locals => {
          await verifyTarget();
          phase = 'stopped';
          return { source: source.file, className: source.className, line: source.line, locals };
        }).catch(error => { if (started && phase !== 'closed') void close().catch(() => {}); throw error; });
        void stopped.catch(() => {});
        started = true;
        return {
          host: relay.host, localPort: relay.localPort, packageName: metadata.packageName, pid: target.pid,
          waitForStop: () => stopped,
          async resume() {
            if (phase !== 'stopped') throw Error('The reviewed Android source is not paused.');
            phase = 'resuming';
            try { await verifyTarget(); await observer.resume(); phase = 'continued'; }
            catch (error) { await close(); throw error; }
          },
          async close() { phase = 'closed'; await close(); }
        };
      } catch (error) { await close(); throw error; }
    })();
    return ownership.result;
  }

  return { devices, review, start, async stop() { await active?.stop(); }, async dispose() {
    disposed = true;
    reviews.clear();
    await active?.stop();
  } };
}

module.exports = { createAndroidDebug, kotlinLocation, singleRelay, watchAndroidBreakpoint };
