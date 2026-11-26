'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { execute } = require('./testing/provision');
const { inside } = require('./workbench-model');

const loopback = '127.0.0.1';
const serialPattern = /^emulator-[1-9][0-9]{3,4}$/u;
const numberToken = /^[1-9][0-9]{0,9}$/u;
const qualified = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const hexSha = /^[0-9a-f]{64}$/u;
const lines = text => text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
function one(items, message) {
  if (items.length !== 1) throw Error(message);
  return items[0];
}

function apkBadging(output) {
  const records = lines(output);
  const pkg = one(records.filter(row => row.startsWith('package: ')), 'The APK manifest package is missing or ambiguous.');
  const packageName = /^package: name='([^']+)'/u.exec(pkg)?.[1];
  if (!qualified.test(packageName || '') || packageName.length > 220 || /(?:^|\s)split=/u.test(pkg) ||
      records.filter(row => row === 'application-debuggable').length !== 1) {
    throw Error('Choose one standalone debuggable Android APK.');
  }
  const launcher = one(records.filter(row => row.startsWith('launchable-activity: ')), 'Choose an APK with one launchable activity.');
  const activity = /^launchable-activity: name='([^']+)'/u.exec(launcher)?.[1];
  if (!qualified.test(activity || '') || activity.length > 220) throw Error('The APK launcher identity is unsupported.');
  return { packageName, activity };
}

function emulatorDevices(output) {
  const records = lines(output), devices = [];
  if (records.shift() !== 'List of devices attached' || records.length > 128) throw Error('Unexpected ADB device inventory.');
  for (const record of records) {
    const [serial, state, ...metadata] = record.split(/\s+/u);
    if (!serialPattern.test(serial) || state !== 'device') continue;
    const transport = metadata.filter(part => part.startsWith('transport_id:')).map(part => part.slice(13));
    if (transport.length === 1 && numberToken.test(transport[0])) devices.push({ serial, transportId: transport[0] });
  }
  if (new Set(devices.map(row => row.serial)).size !== devices.length ||
      new Set(devices.map(row => row.transportId)).size !== devices.length) throw Error('ADB reported ambiguous emulator transport identities.');
  return devices;
}

function processStartedAt(text, pid) {
  const end = text.lastIndexOf(') ');
  if (end < 0 || !text.startsWith(pid + ' (') || !numberToken.test(pid)) return undefined;
  const start = text.slice(end + 2).trim().split(/\s+/u)[19];
  return /^[1-9][0-9]{0,19}$/u.test(start || '') ? start : undefined;
}

async function androidTools(sdkDirectory, buildTools, port = 5037) {
  if (!path.isAbsolute(sdkDirectory || '') || !/^\d{2}\.\d+\.\d+$/u.test(buildTools || '') ||
      !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Configure a local Android SDK, build-tools revision and ADB port.');
  const sdk = await fs.realpath(sdkDirectory);
  async function binary(...parts) {
    const name = parts.at(-1);
    if (process.platform === 'win32') parts[parts.length - 1] = name + '.exe';
    const file = path.join(sdk, ...parts), real = await fs.realpath(file), stat = await fs.lstat(file);
    if (!inside(sdk, real) || path.relative(file, real) || !stat.isFile() || stat.size > 64 * 1024 * 1024) {
      throw Error('Use physical executables from the selected Android SDK.');
    }
    return real;
  }
  return { adb: await binary('platform-tools', 'adb'), aapt2: await binary('build-tools', buildTools, 'aapt2'), port };
}

function createAdb(tools, exec = execute) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:ANDROID_SERIAL|ANDROID_ADB_SERVER_ADDRESS|ANDROID_ADB_SERVER_PORT|ADB_SERVER_SOCKET)$/iu.test(key)));
  async function command(program, args, settings = {}) {
    const out = await exec(program, args, { env, timeoutMs: 7000, maxOutputBytes: 384 * 1024, ...settings });
    if (out.timedOut || out.cancelled || out.output.includes('[Output limit reached')) throw Error('The bounded Android SDK command did not finish.');
    return out;
  }
  const invoke = (args, settings) => command(tools.adb, ['-H', loopback, '-P', String(tools.port), ...args], settings);
  async function checked(args, message, settings) {
    const out = await invoke(args, settings);
    if (out.code !== 0) throw Error(message);
    return out.output.trim();
  }
  async function devices() {
    return emulatorDevices(await checked(['devices', '-l'], 'Cannot read the local ADB emulator inventory.'));
  }
  const transport = (device, args) => ['-t', device.transportId, ...args];
  async function observe(serial) {
    if (!serialPattern.test(serial || '')) throw Error('Select a local Android emulator.');
    const device = one((await devices()).filter(item => item.serial === serial), 'The selected local Android emulator is no longer online.');
    const tr = args => transport(device, args);
    const [qemu, user, boot, avd] = await Promise.all([
      checked(tr(['shell', 'getprop', 'ro.kernel.qemu']), 'Cannot verify the emulator kernel.'),
      checked(tr(['shell', 'am', 'get-current-user']), 'Cannot verify the active Android user.'),
      checked(tr(['shell', 'cat', '/proc/sys/kernel/random/boot_id']), 'Cannot verify the emulator boot identity.'),
      checked(['-s', serial, 'emu', 'avd', 'name'], 'Cannot verify the selected emulator AVD.')
    ]);
    const reply = lines(avd);
    if (qemu !== '1' || user !== '0' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(boot) ||
        reply.length !== 2 || reply[1] !== 'OK' || !/^[\w.-]{1,120}$/u.test(reply[0]) ||
        !(await devices()).some(item => item.serial === serial && item.transportId === device.transportId)) {
      throw Error('Choose the same locally connected Android AVD booted as user 0.');
    }
    return { ...device, avd: reply[0], boot };
  }
  async function verify(device) {
    const current = await observe(device.serial);
    if (current.boot !== device.boot || current.avd !== device.avd || current.transportId !== device.transportId) {
      throw Error('The selected Android emulator or its transport changed. Review it again.');
    }
  }
  async function inspect(apk) {
    const result = await command(tools.aapt2, ['dump', 'badging', apk]);
    if (result.code !== 0) throw Error('Cannot read APK badging with Android SDK AAPT2.');
    return apkBadging(result.output);
  }
  async function present(device, packageName) {
    if (!qualified.test(packageName || '')) throw Error('Invalid reviewed APK package.');
    const found = lines(await checked(transport(device, ['shell', 'pm', 'list', 'packages', '-u', '--user', '0', packageName]),
      'Cannot verify installed packages on the selected emulator.'));
    if (found.some(record => !/^package:[A-Za-z][A-Za-z0-9_.]*$/u.test(record))) throw Error('Unexpected installed package inventory.');
    return found.includes('package:' + packageName);
  }
  async function installed(device, packageName, digest) {
    if (!qualified.test(packageName || '') || !hexSha.test(digest || '')) throw Error('Invalid reviewed APK identity.');
    const found = lines(await checked(transport(device, ['shell', 'pm', 'path', '--user', '0', packageName]),
      'The installed APK identity is unavailable.'));
    const file = one(found, 'Choose a single base APK without installed splits.').slice(8);
    if (found[0] !== 'package:' + file || !/^\/data\/app\/[A-Za-z0-9_/=~.+-]+\/base\.apk$/u.test(file) ||
        file.split('/').some(segment => segment === '.' || segment === '..')) throw Error('Unexpected installed base APK path.');
    const result = await checked(transport(device, ['shell', 'run-as', packageName, 'sha256sum', file]),
      'The installed debuggable base APK could not be read with its own app UID.');
    if (result !== digest + '  ' + file) throw Error('The installed APK no longer matches the reviewed bytes.');
    return file;
  }
  async function appProcess(device, packageName) {
    const result = await invoke(transport(device, ['shell', 'pidof', packageName]));
    const pid = result.output.trim();
    if (result.code !== 0 || !numberToken.test(pid)) return undefined;
    const tr = args => transport(device, args);
    const [observed, jdwp] = await Promise.all([
      invoke(tr(['shell', 'run-as', packageName, 'cat', '/proc/' + pid + '/stat'])),
      activeJdwp(tools.port, device.transportId)
    ]);
    const startedAt = observed.code === 0 && processStartedAt(observed.output, pid);
    if (!startedAt || !jdwp.includes(pid)) return undefined;
    return { pid, startedAt };
  }
  return {
    observe, verify, inspect, present, installed, appProcess, devices,
    async install(device, apk) {
      // Android's shell installer replaces packages by default. -R is the actual no-replacement switch.
      const result = await checked(transport(device, ['install', '--no-streaming', '--no-incremental', '-R', '--user', '0', apk]),
        'Android refused to install a fresh APK without replacement.', { timeoutMs: 90000 });
      if (lines(result).at(-1) !== 'Success') throw Error('The emulator did not confirm the new APK installation.');
    },
    async launch(device, apk) {
      const result = await checked(transport(device, ['shell', 'am', 'start', '--user', '0', '-n', apk.packageName + '/' + apk.activity]),
        'Android refused to launch the reviewed activity.');
      if (!/^Starting: Intent /mu.test(result) || /^(?:Error|Warning):/mu.test(result)) throw Error('The reviewed Android activity did not start.');
    },
    async uninstall(device, packageName) {
      const result = await checked(transport(device, ['uninstall', '--user', '0', packageName]), 'The owned APK could not be removed.');
      if (result !== 'Success') throw Error('The emulator did not confirm the owned APK cleanup.');
    }
  };
}

function readExact(socket, size) {
  if (!size) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    function clean() {
      socket.off('readable', read);
      socket.off('close', closed);
      socket.off('error', closed);
    }
    function closed() { clean(); reject(Error('The local ADB JDWP transport closed.')); }
    function read() {
      const received = socket.read(size);
      if (!received) return;
      clean();
      resolve(received);
    }
    if (socket.destroyed) return closed();
    socket.on('readable', read);
    socket.once('close', closed);
    socket.once('error', closed);
    read();
  });
}

async function openAdbService(port, transportId, command) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !numberToken.test(transportId || '')) {
    throw Error('Invalid reviewed Android JDWP route.');
  }
  const socket = net.createConnection({ host: loopback, port });
  socket.on('error', () => {});
  const timer = setTimeout(() => socket.destroy(Error('ADB JDWP connection timed out.')), 7000);
  try {
    await once(socket, 'connect');
    for (const service of ['host:transport-id:' + transportId, command]) {
      socket.write(service.length.toString(16).padStart(4, '0') + service, 'ascii');
      if ((await readExact(socket, 4)).toString('ascii') !== 'OKAY') throw Error('Local ADB refused the selected Android JDWP route.');
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally { clearTimeout(timer); }
}

async function connectAdbJdwp(port, transportId, pid) {
  if (!numberToken.test(pid || '')) throw Error('Invalid reviewed Android JDWP route.');
  return openAdbService(port, transportId, 'jdwp:' + pid);
}

async function activeJdwp(port, transportId) {
  const socket = await openAdbService(port, transportId, 'track-jdwp');
  const timer = setTimeout(() => socket.destroy(), 5000);
  try {
    // ADB tracks JDWP continuously. Read its first length-prefixed list without waiting for EOF.
    const length = (await readExact(socket, 4)).toString('ascii');
    if (!/^[0-9a-f]{4}$/iu.test(length) || Number.parseInt(length, 16) > 16 * 1024) {
      throw Error('The Android JDWP process list exceeded its bounds.');
    }
    const entries = lines((await readExact(socket, Number.parseInt(length, 16))).toString('utf8'));
    if (entries.some(pid => !numberToken.test(pid))) throw Error('Unexpected Android JDWP process identity.');
    return entries;
  } finally { clearTimeout(timer); socket.destroy(); }
}

module.exports = { androidTools, createAdb, connectAdbJdwp, activeJdwp, apkBadging, emulatorDevices, processStartedAt, qualified, loopback };
