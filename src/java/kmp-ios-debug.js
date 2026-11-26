'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { inspectIosReview, fileDigest, bundleDigest, uuid } = require('./kmp-ios-review');

const exec = promisify(execFile);
const runtimeId = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(?:[0-9]+-){1,2}[0-9]+$/;
const deviceId = /^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-[A-Za-z0-9-]{1,45}$/;
const workerPrefix = 'ROCKETBRAIN_IOS:';
const workerStages = new Set(['interpreter-entered', 'target-opened', 'attaching', 'process-verified', 'module-verified',
  'runtime-framework-pending', 'runtime-loader-stopped', 'runtime-framework-mapped',
  'app-entry-armed', 'app-entry-verified',
  'runtime-breakpoint-resolved', 'runtime-breakpoint-pending', 'process-continue', 'process-continue-returned']);
const workerPaths = [path.join(__dirname, 'ios-debug', 'simulator_lldb.py'),
  path.join(__dirname, '../../runtime/ios-debug/simulator_lldb.py')];
const execTimedOut = error => error?.killed === true && error?.signal === 'SIGTERM' && error?.code == null;

function environment() {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LC_ALL: 'C' };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

async function systemTool() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw Error('Use a local Apple Silicon macOS extension host with Xcode to debug an arm64 iOS Simulator app.');
  }
  const env = environment();
  const selected = process.env.DEVELOPER_DIR ?? (await exec('/usr/bin/xcode-select', ['-p'], { env, timeout: 6000 })).stdout.trim();
  const developer = fs.realpathSync.native(selected);
  if (!/^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(developer)) {
    throw Error('Select an installed stock Xcode application under /Applications.');
  }
  env.DEVELOPER_DIR = developer;
  const tool = async (name, args, { timeout = 20000, signal } = {}) => {
    const binary = name.startsWith('/') ? name : '/usr/bin/xcrun';
    try {
      return (await exec(binary, name.startsWith('/') ? args : [name, ...args],
        { env, signal, timeout, maxBuffer: 3 * 1024 * 1024, encoding: 'utf8' })).stdout;
    } catch (cause) {
      if (signal?.aborted) signal.throwIfAborted();
      const operation = name === 'simctl' ? 'simctl ' + args[0] : path.basename(name);
      const measured = execTimedOut(cause) ? 'timed out after ' + timeout + ' ms' :
        'exited with ' + (cause.code ?? cause.signal ?? 'an unknown error');
      const detail = String(cause.stderr ?? '').trim().slice(0, 1200);
      throw Error(operation + ' ' + measured + (detail ? ': ' + detail : '') + '.', { cause });
    }
  };
  return { tool, env };
}

async function availableSimulators(tool) {
  const listing = JSON.parse(await tool('simctl', ['list', '-j']));
  const runtimes = listing.runtimes.filter(runtime => runtime.isAvailable && runtimeId.test(runtime.identifier))
    .map(runtime => ({ id: runtime.identifier, name: runtime.name, version: runtime.version,
      deviceIds: new Set(runtime.supportedDeviceTypes?.map(device => device.identifier) || []) }));
  const deviceTypes = listing.devicetypes.filter(device => deviceId.test(device.identifier))
    .map(device => ({ id: device.identifier, name: device.name }));
  return { runtimes, deviceTypes, devices: listing.devices };
}

function launchedPid(output, bundleId) {
  const match = /^([^:\r\n]+): ([1-9][0-9]{0,8})\s*$/.exec(output.trim());
  if (!match || match[1] !== bundleId) throw Error('Simulator did not return a PID for the approved app bundle.');
  return Number(match[2]);
}

function installedApp(id, output, root = os.homedir()) {
  const reported = output.trim();
  const devices = fs.realpathSync.native(path.join(root, 'Library', 'Developer', 'CoreSimulator', 'Devices'));
  const prefix = path.join(devices, id, 'data', 'Containers', 'Bundle', 'Application') + path.sep;
  const installed = fs.realpathSync.native(reported);
  const parts = installed.slice(prefix.length).split(path.sep);
  if (!installed.startsWith(prefix) || parts.length !== 2 || !uuid.test(parts[0]) || !parts[1].endsWith('.app')) {
    throw Error('The installed app is outside the owned simulator container.');
  }
  return installed;
}

async function verifyProcess(tool, pid, executable, signal) {
  const value = String(pid);
  const [owner, identity, files] = await Promise.all([
    tool('/bin/ps', ['-p', value, '-o', 'uid='], { signal }),
    tool('/bin/ps', ['-p', value, '-o', 'lstart='], { signal }),
    tool('/usr/sbin/lsof', ['-nP', '-a', '-p', value, '-d', 'txt', '-Fn'], { signal })
  ]);
  if (owner.trim() !== String(process.getuid()) || !identity.trim() || !files.split(/\r?\n/).includes('n' + executable)) {
    throw Error('The simulator PID does not own the exact installed executable.');
  }
  return identity.trim();
}

function startWorker({ env }, config, observe) {
  const worker = workerPaths.find(file => fs.existsSync(file));
  if (!worker) throw Error('The Rocketbrain simulator LLDB session worker is missing.');
  // Xcode LLDB hosts its bundled interpreter, avoiding an unrelated Python ABI or user startup script.
  const script = 'script import os; p=os.environ["ROCKETBRAIN_IOS_WORKER"]; exec(compile(open(p, "rb").read(), p, "exec"))';
  const child = spawn('/usr/bin/xcrun', ['lldb', '--no-lldbinit', '--batch', '-o', script], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ROCKETBRAIN_IOS_WORKER: worker,
      ROCKETBRAIN_IOS_PLAN: JSON.stringify(config) }
  });
  let buffer = '', diagnostics = '', result, failed, lastStage = 'spawned';
  const waiters = new Map();
  const events = new Map();
  function rejectAll(error) {
    failed ||= error;
    for (const waiter of waiters.values()) waiter.reject(failed);
    waiters.clear();
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { diagnostics = (diagnostics + value).slice(-2500); });
  child.stdin.on('error', rejectAll);
  child.on('error', rejectAll);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', value => {
    buffer += value;
    if (buffer.length > 128 * 1024) {
      child.kill();
      return rejectAll(Error('The Xcode LLDB session exceeded its output limit.'));
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith(workerPrefix)) continue;
      let item;
      try { item = JSON.parse(line.slice(workerPrefix.length)); }
      catch { child.kill(); return rejectAll(Error('Xcode LLDB returned malformed session data.')); }
      if (item.event === 'error') {
        rejectAll(Error('Xcode LLDB: ' + String(item.message).slice(0, 1200)));
        continue;
      }
      if (item.event === 'phase' && workerStages.has(item.stage)) {
        lastStage = item.stage;
        observe('lldb-' + item.stage);
        continue;
      }
      if (item.event === 'framework' && Array.isArray(item.modules) && item.modules.length <= 8 && line.length <= 10000) {
        observe('lldb-framework-observation', { fileAddress: item.fileAddress, modules: item.modules });
        continue;
      }
      if (!['ready', 'stopped', 'continued'].includes(item.event) || events.has(item.event)) continue;
      events.set(item.event, item);
      waiters.get(item.event)?.resolve(item);
      waiters.delete(item.event);
    }
  });
  const done = new Promise(resolve => child.once('close', code => {
    result = code; rejectAll(Error('Xcode LLDB exited (' + code + ') after ' + lastStage + '. ' + diagnostics.trim())); resolve();
  }));
  function expect(event, timeout) {
    if (events.has(event)) return Promise.resolve(events.get(event));
    if (failed) return Promise.reject(failed);
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = Error('Xcode LLDB timed out waiting for ' + event + ' after ' + lastStage + '. ' + diagnostics.trim());
        error.iosTimeoutAt = Date.now();
        child.kill();
        rejectAll(error);
      }, timeout);
      waiters.set(event, { resolve, reject });
    }).finally(() => { clearTimeout(timer); waiters.delete(event); });
  }
  function write(command) {
    if (failed) throw failed;
    child.stdin.write(command + '\n');
  }
  return {
    expect, write,
    async stop() {
      if (result === undefined) child.kill();
      await done;
    }
  };
}

async function observeInstalledContainer(tool, id, bundleId, signal, observe) {
  const args = ['get_app_container', id, bundleId, 'app'];
  try { return await tool('simctl', args, { signal, timeout: 75000 }); }
  catch (error) {
    // A busy new simulator can briefly time out during its first app-container lookup.
    // Re-observe only the same read; the approved installation is never repeated.
    if (signal.aborted || !execTimedOut(error.cause)) throw error;
    observe('read-container-retry');
    await delay(500, undefined, { signal });
    return tool('simctl', args, { signal, timeout: 35000 });
  }
}

function createKmpIosDebug({ trust = () => {}, saved = () => {}, tools = systemTool,
  openWorker = startWorker, observe: observer } = {}) {
  const observe = observer || (() => {});
  let active, pending;
  function validate(record) {
    trust();
    saved(record.review.source);
    record.review.validate();
    record.abort.signal.throwIfAborted();
  }
  async function review(input) {
    trust();
    saved(input.source);
    pending = undefined;
    const system = await tools();
    const availability = await availableSimulators(system.tool);
    const runtime = availability.runtimes.find(item => item.id === input.runtime);
    if (!runtime || !runtime.deviceIds.has(input.device) || !availability.deviceTypes.some(item => item.id === input.device)) {
      throw Error('Choose a supported pair from the installed iOS simulator runtimes and iPhone device types.');
    }
    const snapshot = await inspectIosReview(input, system.tool);
    pending = { token: randomUUID(), review: snapshot, system, runtime: input.runtime, device: input.device,
      abort: new AbortController() };
    const { validate: _, ...publicReview } = snapshot;
    return { ...publicReview, token: pending.token, runtime: input.runtime, device: input.device };
  }
  async function cleanup(record) {
    let workerFailure;
    try {
      try { await record.worker?.stop(); }
      catch (error) { workerFailure = error; }
      if (record.id) {
        const tool = record.system.tool;
        await tool('simctl', ['terminate', record.id, record.review.bundleId], { timeout: 20000 }).catch(() => {});
        await tool('simctl', ['shutdown', record.id], { timeout: 35000 }).catch(() => {});
        await tool('simctl', ['delete', record.id], { timeout: 35000 });
        const listing = await availableSimulators(tool);
        if (Object.values(listing.devices).flat().some(item => item.udid === record.id)) {
          throw Error('The owned iOS simulator remains registered after cleanup.');
        }
        record.id = undefined;
        observe('owned-device-deleted');
      }
      if (record === active) active = undefined;
    } finally {
      if (record.scratch) fs.rmSync(record.scratch, { recursive: true, force: true });
    }
    if (workerFailure) throw workerFailure;
  }
  function close(record) {
    record.abort.abort();
    return record.closing ||= Promise.resolve(record.setup).catch(() => {}).then(() => cleanup(record)).catch(error => {
      record.closing = undefined;
      throw error;
    });
  }
  async function launch(record) {
    validate(record);
    const { tool } = record.system, { signal } = record.abort;
    const snapshot = record.review;
    record.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-ios-'));
    const staged = path.join(record.scratch, path.basename(snapshot.app));
    fs.cpSync(snapshot.app, staged, { recursive: true, errorOnExist: true, force: false });
    const symbols = path.join(record.scratch, path.basename(snapshot.symbols));
    fs.copyFileSync(snapshot.symbols, symbols, fs.constants.COPYFILE_EXCL);
    if (bundleDigest(staged) !== snapshot.appSha256 || fileDigest(symbols) !== snapshot.symbolsSha256) {
      throw Error('The retained iOS app or Kotlin dSYM changed during staging.');
    }
    // Allow create to complete on cancellation and retain the exact UUID before teardown.
    const previous = await availableSimulators(tool);
    signal.throwIfAborted();
    const id = (await tool('simctl', ['create', 'Rocketbrain ' + randomUUID(), record.device, record.runtime])).trim();
    if (!uuid.test(id) || Object.values(previous.devices).flat().some(item => item.udid === id)) {
      throw Error('CoreSimulator did not return a fresh owned device UUID.');
    }
    record.id = id;
    observe('owned-device-created');
    signal.throwIfAborted();
    await tool('simctl', ['boot', id], { signal, timeout: 45000 });
    await tool('simctl', ['bootstatus', id, '-b'], { signal, timeout: 240000 });
    observe('owned-device-booted');
    await tool('simctl', ['install', id, staged], { signal, timeout: 65000 });
    observe('owned-app-installed');
    const installed = installedApp(id, await observeInstalledContainer(tool, id, snapshot.bundleId, signal, observe));
    const executable = path.join(installed, path.relative(snapshot.app, snapshot.executable));
    const framework = path.join(installed, path.relative(snapshot.app, snapshot.framework));
    if (fileDigest(executable) !== snapshot.executableSha256 || fileDigest(framework) !== snapshot.frameworkSha256) {
      throw Error('Simulator installed a different app executable or framework.');
    }
    observe('installed-executable-and-framework-verified');
    validate(record);
    let launchOutput;
    try {
      launchOutput = await tool('simctl', ['launch', '--wait-for-debugger', id, snapshot.bundleId],
        { signal, timeout: 90000 });
    } catch (error) {
      if (!signal.aborted) {
        try { await observe('debuggee-launch-refused', id); } catch { /* Preserve the original launch failure. */ }
      }
      throw error;
    }
    const pid = launchedPid(launchOutput, snapshot.bundleId);
    observe('debuggee-launched');
    const processIdentity = await verifyProcess(tool, pid, executable, signal);
    validate(record);
    if (await verifyProcess(tool, pid, executable, signal) !== processIdentity) throw Error('The reviewed simulator process changed.');
    observe('owned-pid-verified');
    const worker = record.worker = openWorker(record.system, { executable, framework, symbols, pid,
      appUuid: snapshot.appUuid, entryFileAddress: snapshot.entryFileAddress,
      frameworkUuid: snapshot.frameworkUuid, frameworkSha256: snapshot.frameworkSha256,
      source: snapshot.source, line: snapshot.line, reportMappings: Boolean(observer) }, observe);
    const stopOnCancel = () => { void worker.stop().catch(() => {}); };
    signal.addEventListener('abort', stopOnCancel, { once: true });
    try { await worker.expect('ready', 95000); }
    finally { signal.removeEventListener('abort', stopOnCancel); }
    observe('lldb-breakpoint-bound');
    signal.throwIfAborted();
    let stopped = false, continued = false;
    return { id, pid, bundleId: snapshot.bundleId,
      async waitForStop() {
        try {
          const pause = await worker.expect('stopped', 55000);
          validate(record);
          if (pause.source !== snapshot.source || pause.line !== snapshot.line || !Array.isArray(pause.locals)) {
            throw Error('Xcode LLDB did not stop in the reviewed Kotlin source.');
          }
          stopped = true;
          return pause;
        } catch (error) {
          if (!signal.aborted) {
            try { await observe('source-stop-unobserved', { id: record.id, timeoutAt: error.iosTimeoutAt }); }
            catch { /* Preserve the debugger failure. */ }
          }
          await close(record);
          throw error;
        }
      },
      async resume() {
        validate(record);
        if (!stopped || continued) throw Error('Continue is allowed once at the reviewed Kotlin breakpoint.');
        continued = true;
        worker.write('continue');
        await worker.expect('continued', 18000);
      },
      stop: () => close(record)
    };
  }
  return {
    async devices() { trust(); return availableSimulators((await tools()).tool); },
    review,
    async start(token, approved) {
      trust();
      if (active) throw Error('Stop the current owned iOS simulator session first.');
      if (approved !== true || !pending || pending.token !== token) throw Error('Approve the exact reviewed iOS simulator launch.');
      const record = active = pending;
      pending = undefined;
      record.setup = launch(record);
      try { return await record.setup; }
      catch (error) {
        if (!record.abort.signal.aborted && record.worker && record.id) {
          try { await observe('source-stop-unobserved', { id: record.id, timeoutAt: error.iosTimeoutAt }); }
          catch { /* Keep the exact LLDB failure. */ }
        }
        await close(record);
        throw error;
      }
    },
    stop: () => active ? close(active) : Promise.resolve(),
    dispose() { pending = undefined; return this.stop(); }
  };
}

module.exports = { createKmpIosDebug, availableSimulators, launchedPid, installedApp, observeInstalledContainer };
