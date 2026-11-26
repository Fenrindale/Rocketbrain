'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter, once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { armSimulatorBuild, armUuid, bundleDigest, uuid } = require('../src/java/kmp-ios-review');
const { createKmpIosDebug, launchedPid, observeInstalledContainer } = require('../src/java/kmp-ios-debug');
const { createKmpIosDebugAdapter } = require('../src/java/kmp-ios-debug-adapter');

test('iOS review refuses physical iOS, macOS and fat Mach-O debug artifacts', () => {
  armSimulatorBuild('Load command 1\n   cmd LC_BUILD_VERSION\n platform IOSSIMULATOR\n minos 17.0\n');
  assert.throws(() => armSimulatorBuild('platform IOS\n'), /iOS Simulator/);
  assert.throws(() => armSimulatorBuild('platform MACOS\n'), /iOS Simulator/);
  const line = 'UUID: 12345678-1234-5678-90AB-ABCDEF123456 (arm64) /App';
  assert.equal(armUuid(line), '12345678-1234-5678-90ab-abcdef123456');
  assert.throws(() => armUuid(line + '\n' + line.replace('arm64', 'x86_64')), /stock arm64/);
  assert.equal(launchedPid('test.rb.fixture: 498', 'test.rb.fixture'), 498);
  assert.throws(() => launchedPid('not.rb.fixture: 498', 'test.rb.fixture'), /approved app/);
});

test('iOS bundle review binds file names and bytes and refuses links', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-ios-bundle-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Info.plist');
  fs.writeFileSync(file, 'A');
  const before = bundleDigest(dir);
  fs.writeFileSync(file, 'B');
  const changed = bundleDigest(dir);
  assert.notEqual(changed, before);
  fs.renameSync(file, path.join(dir, 'Renamed.plist'));
  assert.notEqual(bundleDigest(dir), changed);
  if (process.platform !== 'win32') {
    fs.symlinkSync('Renamed.plist', file);
    assert.throws(() => bundleDigest(dir), /without links/);
  }
});

test('a busy owned simulator repeats only the exact read and never retries a reported exit', async () => {
  const calls = [], phases = [];
  const signal = new AbortController().signal;
  const timedOut = Error('container still busy', { cause: { killed: true, signal: 'SIGTERM', code: null } });
  const lookup = async (tool, args, { timeout }) => {
    calls.push([tool, ...args, timeout]);
    if (calls.length === 1) throw timedOut;
    return '/owned/container';
  };
  assert.equal(await observeInstalledContainer(lookup, 'device', 'app.bundle', signal, phase => phases.push(phase)),
    '/owned/container');
  assert.deepEqual(calls, [
    ['simctl', 'get_app_container', 'device', 'app.bundle', 'app', 75000],
    ['simctl', 'get_app_container', 'device', 'app.bundle', 'app', 35000]
  ]);
  assert.deepEqual(phases, ['read-container-retry']);
  await assert.rejects(observeInstalledContainer(async () => {
    throw Error('actual simctl exit', { cause: { code: 2 } });
  }, 'device', 'app.bundle', signal, () => assert.fail('unexpected retry')), /actual simctl exit/);
});

test('iOS review denies a replay and cancellation cleans up just the UUID created in flight', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-ios-review-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Test.app'), source = path.join(root, 'Probe.kt'), dsym = path.join(root, 'Probe.dSYM');
  const framework = path.join(app, 'Frameworks', 'Probe.framework', 'Probe');
  const symbols = path.join(dsym, 'Contents', 'Resources', 'DWARF', 'Probe');
  for (const dir of [path.dirname(framework), path.dirname(symbols)]) fs.mkdirSync(dir, { recursive: true });
  for (const file of [source, framework, symbols, path.join(app, 'Info.plist'), path.join(app, 'Main')]) fs.writeFileSync(file, 'test source');
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', device = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
  const owned = '5787B148-4858-45BE-8A3D-BB2964EFD036', other = '4C8F5351-9B5A-412A-A368-30C8CB96AF8B';
  const changes = [];
  let creating, created = false;
  const entered = new Promise(resolve => { creating = resolve; });
  let resolveCreate;
  const createResult = new Promise(resolve => { resolveCreate = resolve; });
  const service = createKmpIosDebug({ tools: async () => ({ tool: async (name, args) => {
    if (name === '/usr/bin/plutil') return JSON.stringify({ CFBundleIdentifier: 'test.rb.fixture', CFBundleExecutable: 'Main',
      CFBundlePackageType: 'APPL', CFBundleSupportedPlatforms: ['iPhoneSimulator'] });
    if (name === 'vtool') return ' platform IOSSIMULATOR\n';
    if (name === 'dwarfdump') return 'UUID: ' + owned + ' (arm64) ' + args[1] + '\n';
    if (args[0] === 'list') return JSON.stringify({ runtimes: [{ identifier: runtime, isAvailable: true,
      supportedDeviceTypes: [{ identifier: device }] }], devicetypes: [{ identifier: device }],
    devices: { [runtime]: [{ udid: other }, ...(created ? [{ udid: owned }] : [])] } });
    if (args[0] === 'create') {
      creating();
      await createResult;
      created = true;
      return owned;
    }
    assert.equal(args[1], owned);
    changes.push(args[0]);
    if (args[0] === 'delete') created = false;
    return '';
  } }) });
  const review = await service.review({ root, app, source, dsym, framework: 'Probe.framework', line: 1, runtime, device });
  await assert.rejects(service.start(review.token, false), /Approve the exact/);
  const starting = service.start(review.token, true);
  void starting.catch(() => {});
  await entered;
  const stopping = service.stop();
  resolveCreate();
  await assert.rejects(starting, { name: 'AbortError' });
  await stopping;
  assert.deepEqual(changes, ['terminate', 'shutdown', 'delete']);
  assert.equal(created, false);
  await assert.rejects(service.start(review.token, true), /Approve the exact/);
});

function debugClient(service, review) {
  const events = new EventEmitter();
  const adapter = createKmpIosDebugAdapter({ service, review, send(message) {
    if (message.type === 'response') events.emit('response:' + message.request_seq, message);
    else events.emit(message.event, message.body);
  } });
  let seq = 0;
  return {
    async request(command, args) {
      const id = ++seq;
      const receipt = once(events, 'response:' + id);
      await adapter.handleMessage({ type: 'request', seq: id, command, arguments: args });
      return (await receipt)[0];
    },
    async event(name, timeout = 120000) {
      return (await once(events, name, { signal: AbortSignal.timeout(timeout) }))[0];
    },
    dispose: adapter.dispose
  };
}

const xcrun = promisify(execFile);
async function simctl(args, timeout = 45000) {
  return (await xcrun('/usr/bin/xcrun', ['simctl', ...args], { timeout, maxBuffer: 512 * 1024, encoding: 'utf8' })).stdout.trim();
}

async function recordLaunchLog(t, id, bundleId) {
  try {
    const log = await simctl(['spawn', id, 'log', 'show', '--last', '2m', '--style', 'compact',
      '--predicate', 'eventMessage CONTAINS[c] "' + bundleId + '"'], 16000);
    t.diagnostic('Owned simulator launch log:\n' + log.split('\n').slice(-25).join('\n').slice(0, 12000));
  } catch (error) {
    t.diagnostic('Owned simulator log unavailable: ' + String(error.code ?? error.signal).slice(0, 100));
  }
}

async function ordinaryLaunchControl(t, selection, service, baseline) {
  const appId = 'org.rocketbrain.fixture.kotlinios';
  const id = await simctl(['create', 'Rocketbrain ordinary launch control', selection.device, selection.runtime]);
  assert.ok(uuid.test(id) && !baseline.includes(id), 'expected a newly created diagnostic simulator');
  try {
    await simctl(['boot', id], 45000);
    await simctl(['bootstatus', id, '-b'], 240000);
    await simctl(['install', id, selection.app], 65000);
    launchedPid(await simctl(['launch', id, appId], 90000), appId);
    const data = await simctl(['get_app_container', id, appId, 'data'], 75000);
    const reply = path.join(data, 'Library', 'rocketbrain-ios-fixture.txt');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(reply); attempt++) await delay(150);
    assert.equal(fs.readFileSync(reply, 'utf8'), 'UIKit Kotlin=42\n');
    t.diagnostic('Ordinary UIKit launch wrote the same Kotlin result inside a separate owned simulator.');
  } catch (error) {
    t.diagnostic('Ordinary UIKit launch control failed: ' + String(error.stderr || error.message).slice(0, 2000));
    await recordLaunchLog(t, id, appId);
  } finally {
    await simctl(['terminate', id, appId], 20000).catch(() => {});
    await simctl(['shutdown', id], 35000).catch(() => {});
    await simctl(['delete', id], 35000);
    assert.deepEqual(Object.values((await service.devices()).devices).flat().map(item => item.udid).sort(), baseline);
    t.diagnostic('Separate ordinary launch simulator removed.');
  }
}

test('iOS adapter refuses wrong/conditional breakpoints and frames outside the paused scope', async () => {
  const source = path.resolve('Probe.kt');
  const calls = [];
  const session = debugClient({
    async start(token, approved) {
      calls.push([token, approved]);
      return { waitForStop: async () => ({ source, line: 9, name: 'probe', locals: [{ name: 'value', type: 'int', value: '2' }] }),
        resume: async () => { calls.push('continue'); } };
    },
    async stop() { calls.push('stop'); }
  }, { source, line: 9, token: 'owned' });
  const request = (...args) => session.request(...args);
  assert.equal((await request('initialize')).body.supportsConfigurationDoneRequest, true);
  await request('launch');
  let info = await request('setBreakpoints', { source: { path: source + '.other' }, breakpoints: [{ line: 9 }] });
  assert.equal(info.body.breakpoints[0].verified, false);
  assert.equal((await request('configurationDone')).success, false);
  await request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: 9, condition: 'expression()' }] });
  assert.equal((await request('configurationDone')).success, false);
  await request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: 9 }] });
  const stopped = session.event('stopped');
  const approved = await request('configurationDone');
  assert.equal(approved.success, true);
  assert.deepEqual((await stopped).hitBreakpointIds, [1]);
  assert.deepEqual((await request('variables', { variablesReference: 10 })).body.variables, []);
  assert.equal((await request('variables', { variablesReference: 1 })).body.variables[0].value, '2');
  assert.equal((await request('evaluate', { expression: 'target()' })).success, false);
  await request('continue', { threadId: 1 });
  assert.deepEqual((await request('variables', { variablesReference: 1 })).body.variables, []);
  await request('disconnect');
  assert.deepEqual(calls, [['owned', true], 'continue', 'stop']);
});

test('actual Apple Silicon iOS Simulator Kotlin line, scalar local and scoped teardown', {
  skip: !process.env.ROCKETBRAIN_IOS_SIMULATOR_TEST, timeout: 1080000
}, async t => {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const root = fs.realpathSync.native(path.join(__dirname, '..'));
  const output = path.join(root, 'test-output', 'owned-ios-fixture');
  const app = path.join(output, 'RocketbrainIosFixture.app');
  const bundleId = 'org.rocketbrain.fixture.kotlinios';
  const dsym = path.join(output, 'RocketbrainProbe.framework.dSYM');
  const source = path.join(root, 'test/fixtures/kotlin-ios-debug/src/iosSimulatorArm64Main/kotlin/Probe.kt');
  const original = fs.readFileSync(source);
  const line = original.toString('utf8').split('\n').findIndex(item => item.includes('// debugger-stop')) + 1;
  assert.ok(line > 0);
  const phases = [];
  const service = createKmpIosDebug({ observe(phase, simulator) {
    phases.push(phase);
    t.diagnostic('iOS fixture: ' + phase);
    if (phase === 'debuggee-launch-refused') return recordLaunchLog(t, simulator, bundleId);
    if (phase === 'source-stop-unobserved') {
      return simctl(['get_app_container', simulator, bundleId, 'data'], 22000).then(data => {
        const fixtureResult = path.join(data, 'Library', 'rocketbrain-ios-fixture.txt');
        const wroteResult = fs.existsSync(fixtureResult) && fs.readFileSync(fixtureResult, 'utf8') === 'UIKit Kotlin=42\n';
        t.diagnostic('Owned UIKit app produced expected sandbox result before debugger stop: ' + wroteResult);
      }, error => t.diagnostic('Owned UIKit sandbox result unavailable: ' + String(error.code ?? error.signal).slice(0, 100)));
    }
  } });
  t.after(() => service.stop());
  const inventory = await service.devices();
  const runtime = inventory.runtimes.find(item => item.id === 'com.apple.CoreSimulator.SimRuntime.iOS-26-4');
  assert.ok(runtime, 'The exact Apple iOS 26.4 Simulator runtime is unavailable');
  const device = inventory.deviceTypes.find(item => item.id === 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' &&
    runtime.deviceIds.has(item.id));
  assert.ok(device, 'The exact Apple iPhone 17 simulator device is unavailable');
  const selection = { root, app, dsym, source, line, framework: 'RocketbrainProbe.framework',
    runtime: runtime.id, device: device.id };
  const uuids = inventory => Object.values(inventory.devices).flat().map(item => item.udid).sort();
  const baseline = uuids(inventory);
  const wrong = path.join(output, 'Foreign.dSYM');
  execFileSync('/usr/bin/xcrun', ['dsymutil', path.join(app, 'RocketbrainIosFixture'), '-o', wrong]);
  fs.renameSync(path.join(wrong, 'Contents/Resources/DWARF/RocketbrainIosFixture'),
    path.join(wrong, 'Contents/Resources/DWARF/RocketbrainProbe'));
  await assert.rejects(service.review({ ...selection, dsym: wrong }), /dSYM does not match/);
  const stale = await service.review(selection);
  try {
    fs.appendFileSync(source, '\n// changed after review\n');
    await assert.rejects(service.start(stale.token, true), /changed/);
  } finally { fs.writeFileSync(source, original); }
  await assert.rejects(service.start(stale.token, true), /Approve the exact/);
  const staleSymbols = await service.review(selection);
  const symbolBytes = fs.readFileSync(staleSymbols.symbols);
  try {
    fs.appendFileSync(staleSymbols.symbols, '\n');
    await assert.rejects(service.start(staleSymbols.token, true), /changed/);
  } finally { fs.writeFileSync(staleSymbols.symbols, symbolBytes); }
  assert.deepEqual(uuids(await service.devices()), baseline);

  // Wrap the actual service only to observe the exact product-owned simulator UUID for the resumed UIKit assertion.
  let handle;
  const review = await service.review(selection);
  const client = debugClient({ stop: () => service.stop(), async start(...args) {
    handle = await service.start(...args);
    return handle;
  } }, review);
  t.after(client.dispose);
  await client.request('initialize');
  assert.equal((await client.request('launch')).success, true);
  assert.equal((await client.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line }] })).success, true);
  const stop = client.event('stopped', 575000);
  const observed = stop.catch(error => { throw error; });
  void observed.catch(() => {});
  const failure = client.event('output', 575000).then(event => { throw Error(event.output); });
  void failure.catch(() => {});
  assert.equal((await client.request('configurationDone')).success, true);
  try {
    assert.equal((await Promise.race([observed, failure])).reason, 'breakpoint');
  } catch (debugFailure) {
    if (phases.includes('debuggee-launch-refused')) {
      await service.stop();
      await ordinaryLaunchControl(t, selection, service, baseline);
    }
    throw debugFailure;
  }
  const stack = await client.request('stackTrace', { threadId: 1 });
  assert.equal(stack.body.stackFrames[0].source.path, source);
  assert.equal(stack.body.stackFrames[0].line, line);
  const locals = await client.request('variables', { variablesReference: 1 });
  const measured = locals.body.variables.find(item => item.name === 'measured');
  assert.ok(measured, JSON.stringify(locals.body.variables));
  assert.equal(measured.value, '42');
  const container = execFileSync('/usr/bin/xcrun', ['simctl', 'get_app_container', handle.id, bundleId, 'data'],
    { encoding: 'utf8' }).trim();
  const reply = path.join(container, 'Library', 'rocketbrain-ios-fixture.txt');
  assert.equal(fs.existsSync(reply), false);
  assert.equal((await client.request('continue', { threadId: 1 })).success, true);
  for (let retry = 0; retry < 50 && !fs.existsSync(reply); retry++) await delay(150);
  assert.equal(fs.readFileSync(reply, 'utf8'), 'UIKit Kotlin=42\n');
  assert.equal((await client.request('disconnect')).success, true);
  assert.deepEqual(uuids(await service.devices()), baseline);
  const digest = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
  fs.writeFileSync(process.env.ROCKETBRAIN_IOS_SIMULATOR_RECEIPT, JSON.stringify({
    githubSha: process.env.GITHUB_SHA, platform: 'darwin-arm64', xcode: execFileSync('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8' }).trim(),
    runtime: runtime.id, runtimeVersion: runtime.version, device: device.id, build: 'Kotlin 2.4.21 iosSimulatorArm64 DEBUG framework + UIKit',
    appSha256: review.appSha256, frameworkSha256: review.frameworkSha256, frameworkUuid: review.frameworkUuid,
    symbolsSha256: review.symbolsSha256, sourceSha256: digest(source), editorBreakpoint: { file: path.basename(source), line,
      stack: stack.body.stackFrames[0].name, local: { name: measured.name, type: measured.type, value: measured.value } },
    resumed: 'UIKit Kotlin=42', staleSourceRefused: true, staleDsymRefused: true, wrongDsymRefused: true, oneShot: true, simulatorRemoved: true,
    otherSimulatorsUnchanged: true, phases
  }, null, 2) + '\n');
});
