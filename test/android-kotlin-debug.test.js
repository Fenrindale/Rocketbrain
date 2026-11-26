'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { execute } = require('../src/java/testing/provision');
const { createAndroidDebug, kotlinLocation } = require('../src/java/android-debug');
const { androidTools, createAdb, connectAdbJdwp, activeJdwp, emulatorDevices, apkBadging, processStartedAt } = require('../src/java/android-adb');

const packageName = 'dev.rocketbrain.androidfixture', activity = packageName + '.MainActivity';
const manifest = "package: name='" + packageName + "' versionCode='1'\napplication-debuggable\nlaunchable-activity: name='" + activity + "'\n";

test('Android parsers only accept one debug APK launcher and bind emulator transport and process lifetime', () => {
  assert.deepEqual(apkBadging(manifest), { packageName, activity });
  assert.throws(() => apkBadging(manifest.replace('application-debuggable\n', '')), /debuggable/u);
  assert.throws(() => apkBadging(manifest.replace("versionCode='1'", "split='settings'")), /standalone/u);
  assert.throws(() => apkBadging(manifest + "launchable-activity: name='other.App'\n"), /one launchable/u);
  const inventory = 'List of devices attached\nemulator-5570 device transport_id:7\npixel-012 device transport_id:9\nemulator-5558 offline transport_id:11\n';
  assert.deepEqual(emulatorDevices(inventory), [{ serial: 'emulator-5570', transportId: '7' }]);
  assert.throws(() => emulatorDevices(inventory + 'emulator-5554 device transport_id:7\n'), /ambiguous/u);
  const stat = '804 (unusual ) name) S ' + Array(18).fill('9').join(' ') + ' 5289 1';
  assert.equal(processStartedAt(stat, '804'), '5289');
  assert.equal(processStartedAt(stat, '805'), undefined);
  assert.deepEqual(kotlinLocation(path.resolve('MainActivity.kt'), 'package ' + packageName + '\nclass MainActivity', 2),
    { className: activity, fileName: 'MainActivity.kt', line: 2 });
  assert.throws(() => kotlinLocation(path.resolve('MainActivity.kt'), 'package ' + packageName, 2), /Kotlin line/u);
});

test('Android transport selects exact ADB ID and PID without installing an ADB TCP forward', async t => {
  const commands = [];
  const server = net.createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      while (received.length >= 4) {
        const length = Number.parseInt(received.subarray(0, 4).toString('ascii'), 16);
        if (received.length < length + 4) break;
        commands.push(received.subarray(4, length + 4).toString('ascii'));
        received = received.subarray(length + 4);
        socket.write('OK');
        socket.write(commands.length === 2 ? 'AYpayload' : 'AY');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); });
  const channel = await connectAdbJdwp(server.address().port, '7', '804');
  try {
    assert.deepEqual(commands, ['host:transport-id:7', 'jdwp:804']);
    let payload = channel.read(7);
    if (!payload) {
      await once(channel, 'readable');
      payload = channel.read(7);
    }
    assert.equal(payload?.toString('utf8'), 'payload');
  } finally { channel.destroy(); }
  await assert.rejects(connectAdbJdwp(server.address().port, '7;12', '804'), /reviewed Android JDWP/u);
});

test('Android package installation requests explicit nonreplacement and binds all changes to a transport ID', async () => {
  const calls = [];
  const adb = createAdb({ adb: 'adb', aapt2: 'aapt2', port: 5037 }, async (_application, args) => {
    calls.push(args);
    return { code: 0, output: 'Success\n' };
  });
  await adb.install({ serial: 'emulator-5570', transportId: '7' }, path.resolve('reviewed.apk'));
  assert.deepEqual(calls[0].slice(0, -1), ['-H', '127.0.0.1', '-P', '5037', '-t', '7', 'install',
    '--no-streaming', '--no-incremental', '-R', '--user', '0']);
});

test('read the first Android JDWP process list and close its persistent tracking stream', async t => {
  let closed, messages = [];
  const server = net.createServer(socket => {
    closed = once(socket, 'close');
    let seen = '';
    socket.setEncoding('utf8').on('data', chunk => {
      seen += chunk;
      while (seen.length >= 4) {
        const length = Number.parseInt(seen.slice(0, 4), 16);
        if (seen.length < 4 + length) return;
        const message = seen.slice(4, 4 + length);
        seen = seen.slice(4 + length);
        messages.push(message);
        if (message === 'track-jdwp') socket.write('OKAY0007804\n25\n');
        else socket.write('OKAY');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); });
  assert.deepEqual(await activeJdwp(server.address().port, '7'), ['804', '25']);
  await closed;
  assert.deepEqual(messages, ['host:transport-id:7', 'track-jdwp']);
});

const wanted = {
  sdk: process.env.ROCKETBRAIN_ANDROID_TEST_SDK,
  javaHome: process.env.ROCKETBRAIN_ANDROID_TEST_JAVA_HOME,
  root: process.env.ROCKETBRAIN_ANDROID_TEST_ROOT,
  serial: process.env.ROCKETBRAIN_ANDROID_TEST_SERIAL
};

function connectable(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('actual Android emulator stops in owned Kotlin APK, reads primitive locals and continues on ART', {
  skip: Object.values(wanted).some(value => !value), timeout: 200000
}, async t => {
  const root = await fs.realpath(wanted.root), apk = path.join(root, 'reviewed.apk'), file = path.join(root, 'MainActivity.kt');
  const source = await fs.readFile(file, 'utf8'), line = source.split('\n').findIndex(row => row.includes('SOURCE_STOP')) + 1;
  assert.ok(line > 0);
  const config = { sdk: wanted.sdk, javaHome: wanted.javaHome, buildTools: '35.0.0', port: 5037 };
  const tools = await androidTools(config.sdk, config.buildTools, config.port);
  const adb = createAdb(tools), workbench = createAndroidDebug({ trusted() {}, getTools: () => config });
  t.after(() => workbench.dispose());
  const target = await adb.observe(wanted.serial);
  assert.equal(target.avd, 'rocketbrain-art-fixture');
  const adbCommand = async (...args) => {
    const run = await execute(tools.adb, args, { timeoutMs: 10000 });
    assert.equal(run.code, 0, 'The owned emulator fixture command failed.');
    return run.output;
  };
  const forwards = await adbCommand('forward', '--list');
  const input = { root, apk, file, line, serial: wanted.serial };
  let reviewed = await workbench.review(input);
  assert.equal(reviewed.packageName, packageName);
  assert.equal(reviewed.activity, activity);
  assert.equal(reviewed.apkSha256, createHash('sha256').update(await fs.readFile(apk)).digest('hex'));
  await assert.rejects(workbench.start(reviewed.token, false), /Approve/u);
  assert.equal(await adb.present(target, packageName), false);
  try {
    await fs.writeFile(file, source + '\n// stale selected source\n');
    await assert.rejects(workbench.start(reviewed.token, true), /Kotlin source changed/u);
  } finally { await fs.writeFile(file, source); }
  assert.equal(await adb.present(target, packageName), false);

  reviewed = await workbench.review(input);
  const launched = await workbench.start(reviewed.token, true);
  try {
    assert.equal(launched.host, '127.0.0.1');
    const hit = await launched.waitForStop();
    assert.deepEqual([hit.source, hit.className, hit.line], [file, activity, line]);
    assert.deepEqual(hit.locals.find(value => value.name === 'measured'), { name: 'measured', type: 'int', value: '42' });
    assert.equal(await connectable(launched.localPort), false);
    await assert.rejects(workbench.start(reviewed.token, true), /Review the current/u);
    await assert.rejects(workbench.review(input), /already exists/u);
    const log = async () => (await adbCommand('-t', target.transportId, 'logcat', '-d', '--pid=' + launched.pid,
      '-s', 'RBAndroidFixture:I')).match(/Finished 42/gu)?.length || 0;
    const previous = await log();
    await launched.resume();
    await assert.rejects(launched.resume(), /not paused/u);
    const until = Date.now() + 15000;
    let count = previous;
    while (count <= previous && Date.now() < until) { await delay(250); count = await log(); }
    assert.ok(count > previous, 'The Android Activity did not execute the Kotlin line after resume.');
    assert.equal(await adbCommand('forward', '--list'), forwards);
  } finally { await launched.close(); }
  assert.equal(await adb.present(target, packageName), false);
  const recipe = path.join(wanted.sdk, 'system-images/android-35/google_apis/x86_64/source.properties');
  const image = await fs.readFile(recipe, 'utf8');
  assert.match(image, /AndroidVersion.ApiLevel=35/u);
  const report = {
    format: 'RocketbrainAndroidKotlinDebug1', githubSha: process.env.GITHUB_SHA,
    image: 'system-images;android-35;google_apis;x86_64', imageRevision: /^Pkg.Revision=(.+)$/mu.exec(image)?.[1].trim(),
    kotlin: '2.4.21', buildTools: '35.0.0',
    adbVersion: (await adbCommand('version')).trim().split(/\r?\n/u).slice(0, 2), apkSha256: reviewed.apkSha256,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    source: { name: path.basename(file), type: activity, line }, primitive: { name: 'measured', type: 'int', value: '42' },
    actualArt: true, installed: true, resumed: true, temporaryPackageRemoved: true,
    loopbackSingleClient: true, adbForwardsUnchanged: true, installedPackageRefused: true, staleSourceRefused: true
  };
  if (process.env.ROCKETBRAIN_ANDROID_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_ANDROID_RECEIPT,
    JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
});
