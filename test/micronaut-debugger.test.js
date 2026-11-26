'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createMicronautDebugger, MARKER } = require('../src/java/micronaut-debugger');
const { snapshotMicronautDebugSources } = require('../src/java/micronaut-model');
const { until } = require('./helpers/stdio-lsp');

const pid = 4021, port = 41001, runId = 'owned-micronaut-workbench-run';
const exact = { pid, port, hostName: '127.0.0.1', startedAt: 1000 };
const proof = { pid, port, address: '127.0.0.1' };

function control() {
  const started = new Set(), ended = new Set(), stops = [], calls = [];
  let releaseStart, acknowledged;
  const folder = { name: 'test workspace' };
  const subscribe = handlers => callback => { handlers.add(callback); return { dispose: () => handlers.delete(callback) }; };
  const vscode = {
    Uri: { parse: value => value }, workspace: { getWorkspaceFolder: () => folder },
    debug: {
      onDidStartDebugSession: subscribe(started), onDidTerminateDebugSession: subscribe(ended),
      startDebugging(workspace, config, options) {
        calls.push({ workspace, config, options });
        return new Promise(resolve => { releaseStart = resolve; });
      },
      async stopDebugging(session) {
        stops.push(session.id);
        for (const hook of ended) hook(session);
      }
    }
  };
  function publish(id, known, owned = true) {
    const config = { ...calls.at(-1).config };
    if (!owned) config[MARKER] = 'a different debugger';
    const session = { id, type: 'rocketbrain-java', configuration: config };
    if (known) acknowledged = id;
    for (const hook of started) hook(session);
  }
  const java = { debug: { processes: { resolve: async candidate => { assert.equal(candidate, pid); return exact; } },
    verifiedLocalPid: session => session?.id === acknowledged ? pid : undefined } };
  return { vscode, java, calls, stops, folder, started, ended, publish, release: value => releaseStart(value) };
}

const options = { project: { uri: 'file:///test', name: 'micronaut' }, receipt: { runId, debug: { pid } },
  sourcePaths: ['test-source-path'], validate() {} };

test('Micronaut attaches by reviewed PID after matching its own listener and stops only the correlated session', async () => {
  const fixture = control();
  const runtime = { async verifyDebugTarget({ runId: value }) { assert.equal(value, runId); return proof; } };
  const debuggerControl = createMicronautDebugger(fixture.vscode, fixture.java, runtime);
  const pending = debuggerControl.attach(options);
  const original = await until(() => fixture.calls[0], 2000);
  assert.equal(original.workspace, fixture.folder);
  assert.deepEqual(original.config.sourcePaths, options.sourcePaths);
  assert.equal(original.config.processId, pid);
  assert.equal(original.config.__rocketbrainJavaProcessSelection.port, port);
  assert.equal(original.options.suppressSaveBeforeStart, true);
  fixture.publish('foreign', true, false);
  fixture.publish('owned', true);
  fixture.release(true);
  assert.equal(await pending, 'owned');
  assert.equal(debuggerControl.sessionId(runId), 'owned');
  await debuggerControl.stop();
  assert.deepEqual(fixture.stops, ['owned']);
  assert.equal(fixture.started.size, 0);
  assert.equal(fixture.ended.size, 0);
});

test('Micronaut refuses another port and retires a native session arriving after cancellation', async () => {
  const fixture = control(), controller = new AbortController();
  let match = false;
  const runtime = { verifyDebugTarget: async () => ({ ...proof, port: match ? port : port + 1 }) };
  const debuggerControl = createMicronautDebugger(fixture.vscode, fixture.java, runtime);
  await assert.rejects(debuggerControl.attach(options), /does not own the observed Micronaut debug listener/u);
  assert.equal(fixture.calls.length, 0);
  match = true;
  const pending = debuggerControl.attach({ ...options, cancellation: controller.signal });
  await until(() => fixture.calls[0], 2000);
  controller.abort();
  await assert.rejects(pending, /cancelled/u);
  fixture.publish('foreign', true, false);
  fixture.publish('late', false);
  fixture.release(true);
  await until(() => fixture.stops.length === 1 && !fixture.started.size && !fixture.ended.size, 2000);
  assert.deepEqual(fixture.stops, ['late']);
});

test('Micronaut debug source checksum includes exact Java bytes, application configuration and build descriptors', async () => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'rb-mn-source-proof-'));
  const identity = await fs.lstat(root, { bigint: true });
  try {
    const java = path.join(root, 'src', 'main', 'java'), resources = path.join(root, 'src', 'main', 'resources');
    await Promise.all([fs.mkdir(java, { recursive: true }), fs.mkdir(resources, { recursive: true })]);
    const file = path.join(java, 'Entry.java'), pom = path.join(root, 'pom.xml');
    await fs.writeFile(file, 'class Entry {}\n');
    const manifest = () => snapshotMicronautDebugSources({ root });
    const first = manifest();
    assert.deepEqual(first.sourcePaths, [java]);
    await fs.writeFile(file, 'class Entry {}\r\n');
    const second = manifest();
    assert.notEqual(second.digest, first.digest);
    await fs.writeFile(path.join(resources, 'application-dev.properties'), 'greeting.message=changed\n');
    const third = manifest();
    assert.notEqual(third.digest, second.digest);
    await fs.writeFile(pom, '<project />\n');
    assert.notEqual(manifest().digest, third.digest);
  } finally {
    const current = await fs.realpath(root), physical = await fs.lstat(current, { bigint: true });
    assert.equal(path.relative(root, current), '');
    assert.equal(path.relative(parent, path.dirname(current)), '');
    assert.match(path.basename(current), /^rb-mn-source-proof-/u);
    assert.deepEqual([physical.dev, physical.ino], [identity.dev, identity.ino]);
    await fs.rm(current, { recursive: true });
  }
});
