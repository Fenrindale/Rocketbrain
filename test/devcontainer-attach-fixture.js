'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createManagedJavaAttach, assertManagedAttach } = require('../src/devcontainer/java-attach');
const { checkHttp, fixtureStep, waitForReleasedPort } = require('./devcontainer-port-fixture');

function localJava() {
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  return process.env.ROCKETBRAIN_DEVCONTAINER_JDI_JAVA ||
    (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name);
}

function jdiProcess(root, localPort, line) {
  const command = spawn(localJava(), ['--add-modules', 'jdk.jdi', path.join(root, 'JdiAttachFixture.java'), String(localPort), String(line)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '', markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  command.stdout.on('data', chunk => {
    output = (output + chunk).slice(-4096);
    if (output.includes('JDI_READY')) markReady();
  });
  command.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2048); });
  const exited = new Promise((resolve, reject) => {
    command.once('error', reject);
    command.once('close', code => resolve({ code, output, errors }));
  });
  return {
    ready: () => Promise.race([ready, exited.then(({ errors }) => { throw Error('The fixture debugger exited before its breakpoint was ready. ' + errors); })]),
    exited,
    stop() { if (command.exitCode === null) command.kill(); }
  };
}

async function checkManagedJvmFixture(service, root, started, http) {
  const source = await fs.readFile(path.join(root, 'PortFixture.java'), 'utf8');
  const line = source.split(/\r?\n/u).findIndex(text => text.includes('Managed debugger source breakpoint.')) + 1;
  assert.ok(line > 0);
  const folder = { uri: { scheme: 'file', fsPath: root } };
  const events = new EventEmitter();
  const event = name => listener => {
    events.on(name, listener);
    return { dispose() { events.off(name, listener); } };
  };
  let client, selected;
  const manager = createManagedJavaAttach({
    ready: async () => {},
    openForward: service.forwardPort,
    closeForward: service.closePort,
    debug: {
      onDidStartDebugSession: event('started'), onDidTerminateDebugSession: event('ended'),
      async startDebugging(sessionFolder, configuration) {
        assertManagedAttach(configuration, sessionFolder);
        assert.throws(() => assertManagedAttach({ ...configuration, port: 1 }, sessionFolder), /reviewed Java attach/);
        selected = { id: 'owned-docker-jdi', type: configuration.type, workspaceFolder: sessionFolder, configuration };
        client = jdiProcess(root, configuration.port, line);
        await fixtureStep('installing the actual JDI source breakpoint', () => client.ready());
        events.emit('started', selected);
        return true;
      },
      async stopDebugging() { client?.stop(); }
    }
  });
  try {
    const input = { port: 5005, containerRoot: '/workspaces/compose', sourceDirectory: '.' };
    await assert.rejects(service.inspectJavaAttach(root, { ...input, sourceDirectory: '..' }), /within the mounted workspace/);
    await assert.rejects(service.inspectJavaAttach(root, { ...input, containerRoot: '/tmp' }), /exact local workspace bind mount/);
    const review = await service.inspectJavaAttach(root, input);
    assert.equal(review.containerId, started.id);
    assert.equal(review.localPort, 0);
    await assert.rejects(manager.start(root, folder, { token: review.token }), /Review and approve/);
    const attach = await manager.start(root, folder, { token: review.token, allowContainerDebugging: true });
    assert.equal(attach.sourceRoot, root);
    const forward = (await service.forwardedPorts(root)).find(value => value.localPort === selected.configuration.port);
    assert.ok(forward);
    await checkHttp(http);
    const result = await fixtureStep('reading the real JDI breakpoint and local value', () => client.exited);
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /JDI_BREAKPOINT_AND_VALUE/);
    events.emit('ended', selected);
    await fixtureStep('releasing the debugger forward after disconnect', () => waitForReleasedPort(forward));
    assert.throws(() => assertManagedAttach(selected.configuration, folder), /reviewed Java attach/);
    await checkHttp(http);
    return { realSourceBreakpoint: true, realLocalValue: true, exactReviewedMount: true, releasedOnDebugDisconnect: true,
      preservedIndependentHttpForward: true, approvalAndPortBinding: true };
  } finally {
    manager.dispose();
    client?.stop();
    await client?.exited.catch(() => {});
  }
}

module.exports = { checkManagedJvmFixture };
