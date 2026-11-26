'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { connectWorkspace } = require('../src/remote/ssh-workspace');
const { createSshJavaDebug, localSnapshot } = require('../src/remote/ssh-java-debug');
const { debugSupervisorInvocation } = require('../src/remote/ssh-java-debug-runtime');
const { ownership } = require('../src/remote/ssh-java-debug-linux');
const { pythonCommand } = require('../src/remote/ssh-files-worker');
const { createManagedJavaAttach, assertManagedAttach } = require('../src/devcontainer/java-attach');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { processFixture, fixtureJvm } = require('./helpers/java-debug-process-fixture');
const { until } = require('./helpers/stdio-lsp');

const invoke = promisify(execFile);
const javaHome = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_JDK;
const python = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON;
const pythonPackage = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH;
const linux = process.platform === 'linux';

const jdi = String.raw`
import com.sun.jdi.Bootstrap;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.request.EventRequest;

class VerifySshJdi {
    public static void main(String[] args) throws Exception {
        var socket = Bootstrap.virtualMachineManager().attachingConnectors().stream()
            .filter(connector -> connector.name().equals("com.sun.jdi.SocketAttach")).findFirst().orElseThrow();
        var settings = socket.defaultArguments();
        settings.get("hostname").setValue("127.0.0.1");
        settings.get("port").setValue(args[0]);
        settings.get("timeout").setValue("10000");
        var vm = socket.attach(settings);
        try {
            var prepare = vm.eventRequestManager().createClassPrepareRequest();
            prepare.addClassFilter(args[1]);
            prepare.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            prepare.enable();
            for (int attempt = 0; attempt < 8; attempt++) {
                var events = vm.eventQueue().remove(2500);
                if (events == null) continue;
                for (var event : events) {
                    if (event instanceof ClassPrepareEvent loaded) {
                        var location = loaded.referenceType().locationsOfLine(Integer.parseInt(args[2])).getFirst();
                        var breakpoint = vm.eventRequestManager().createBreakpointRequest(location);
                        breakpoint.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                        breakpoint.enable();
                    } else if (event instanceof BreakpointEvent stopped) {
                        var frame = stopped.thread().frame(0);
                        var local = frame.getValue(frame.visibleVariableByName("watched"));
                        System.out.println(stopped.location().sourcePath().replace('\\', '/') + ":" + stopped.location().lineNumber() + ":" + local);
                        return;
                    }
                }
                events.resume();
            }
            throw new IllegalStateException("The owned remote JVM did not hit the reviewed source breakpoint.");
        } finally { vm.dispose(); }
    }
}
`;

async function localTestFolder(context) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'rb-ssh-java-test-'));
  context.after(async () => {
    const real = await fs.realpath(folder);
    assert.equal(real, folder);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-ssh-java-test-/u);
    await fs.rm(real, { recursive: true, force: true });
  });
  return folder;
}

function connectPort(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

async function openListener(options, callback) {
  const server = net.createServer(callback);
  const listening = once(server, 'listening');
  server.listen(options);
  await listening;
  return server;
}

function closeListener(server) { return new Promise(resolve => server.close(() => resolve())); }

async function observeRejectedRelay(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  let bytes = 0;
  try {
    socket.on('data', chunk => { bytes += chunk.length; });
    socket.setTimeout(10000, () => socket.destroy(Error('The obsolete relay was not released.')));
    await once(socket, 'close');
    return bytes;
  } finally { socket.destroy(); }
}

test('SSH Java source mapping derives the package root and the fixed remote command fits Windows OpenSSH', async context => {
  const home = await localTestFolder(context);
  const selected = path.join(home, 'src', 'app', 'fixture', 'Example.java');
  await fs.mkdir(path.dirname(selected), { recursive: true });
  await fs.writeFile(selected, 'package app.fixture; class Example {}\n');
  const evidence = await localSnapshot(home, selected);
  assert.equal(evidence.remoteFile, '/src/app/fixture/Example.java');
  assert.equal(evidence.sourceRoot, path.join(home, 'src'));
  await fs.writeFile(selected, 'package unrelated; class Example {}\n');
  await assert.rejects(localSnapshot(home, selected), /match its Java package/);
  assert.ok(Buffer.byteLength(pythonCommand('py -3', debugSupervisorInvocation({}).program)) < 7800);
});

test('Linux TCP parser distinguishes exact IPv4, IPv6 competition and an established owned route', { skip: !python }, async () => {
  const runner = 'import json, socket, struct\n' + ownership + `
header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode"
four = header + "\\n 0: 0100007F:C001 00000000:0000 0A 0:0 0:0 0 1001 0 87322"
four += "\\n 1: 0100007F:C001 0100007F:D002 01 0:0 0:0 0 1001 0 87323"
six = header.replace("rem_address", "remote_address")
six += "\\n 0: 00000000000000000000000001000000:C001 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1002 0 87324"
print(json.dumps([list(tcp_rows(four, 8)), list(tcp_rows(six, 32))]))
try:
    list(tcp_rows(header + "\\n 0: 01:ZZZZ 00000000:0000 0A 0:0 0:0 0 1001 0 87322", 8))
except ValueError:
    pass
else:
    raise AssertionError("Malformed TCP address was accepted")
`;
  const parsed = await invoke(python, ['-I', '-c', runner], { timeout: 10000, windowsHide: true });
  assert.deepEqual(JSON.parse(parsed.stdout), [
    [['0100007F', 49153, '00000000', 0, '0A', 1001, '87322'], ['0100007F', 49153, '0100007F', 53250, '01', 1001, '87323']],
    [['00000000000000000000000001000000', 49153, '00000000000000000000000000000000', 0, '0A', 1002, '87324']]
  ]);
});

test('SSH managed debugger guards its exact route and releases only its own session after source drift', async context => {
  const root = await localTestFolder(context);
  const folder = { uri: { scheme: 'file', fsPath: root } };
  const signals = new EventEmitter();
  const stopped = [], released = [];
  let session, changed;
  function on(signal, listener) {
    signals.on(signal, listener);
    return { dispose: () => signals.off(signal, listener) };
  }
  const sessions = {
    onDidStartDebugSession: callback => on('started', callback),
    onDidTerminateDebugSession: callback => on('ended', callback),
    async startDebugging(selected, configuration) {
      assertManagedAttach(configuration, selected);
      assert.throws(() => assertManagedAttach({ ...configuration, port: configuration.port + 1 }, selected), /verified SSH workspace/);
      session = { id: 'owned', type: configuration.type, workspaceFolder: selected, configuration };
      signals.emit('started', session);
      return true;
    },
    async stopDebugging(target) { stopped.push(target.id); signals.emit('ended', target); }
  };
  const attach = createManagedJavaAttach({ kind: 'ssh', debug: sessions, ready() {},
    async openForward(_root, approval) {
      assert.equal(approval.sourceFile, path.join(root, 'AttachFixture.java'));
      return { id: 'relay', host: '127.0.0.1', localPort: 41037, remoteRoot: 'C:/fixture', pid: 73,
        sourceFile: approval.sourceFile, sourceRoot: root };
    },
    closeForward(_root, id) { released.push(id); },
    observe(_forward, stop) { changed = stop; return { dispose() {} }; }
  });
  try {
    const options = { token: 'review', allowSshJavaDebug: true, sourceFile: path.join(root, 'AttachFixture.java') };
    await assert.rejects(attach.start(root, folder, { ...options, allowSshJavaDebug: false }), /Review and approve/);
    assert.equal((await attach.start(root, folder, options)).sessionId, 'owned');
    signals.emit('ended', { ...session, id: 'unrelated' });
    assert.deepEqual(released, []);
    changed();
    await until(() => released.length > 0, 1000);
    assert.deepEqual(stopped, ['owned']);
    assert.deepEqual(released, ['relay']);
    assert.throws(() => assertManagedAttach(session.configuration, folder), /verified SSH workspace/);
  } finally { attach.dispose(); }
});

test('actual SSH JDWP verifies the remote JVM and established socket before a real source stop and detach', {
  skip: !['linux', 'win32'].includes(process.platform) || !javaHome || !python || !pythonPackage, timeout: 245000
}, async context => {
  const owned = await startSshProcessFixture({ python, pythonPackage }, cleanup => context.after(cleanup));
  const home = await localTestFolder(context);
  const java = path.join(javaHome, 'bin', linux ? 'java' : 'java.exe');
  const javac = path.join(javaHome, 'bin', linux ? 'javac' : 'javac.exe');
  const fixture = processFixture('fixture', 'AttachFixture');
  const relative = path.join('src', 'fixture', 'AttachFixture.java');
  const local = path.join(home, relative);
  const remote = path.join(owned.profile.root, relative);
  const verifier = path.join(home, 'VerifySshJdi.java');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, fixture.source, { flag: 'wx' });
  await fs.writeFile(remote, fixture.source, { flag: 'wx' });
  await fs.writeFile(verifier, jdi, { flag: 'wx' });
  await invoke(javac, ['-g', '-d', owned.profile.root, remote], { timeout: 18000, windowsHide: true });
  let peer, target, plain, outsider, stale, forward, early;
  try {
    await assert.rejects(connectWorkspace({ ...owned.profile, knownHostsPath: owned.wrongPin }), /Verify the SSH host key/);
    peer = await connectWorkspace(owned.profile);
    const service = createSshJavaDebug({ current: () => peer, trusted() {}, saved() {} });
    target = fixtureJvm(java, peer.root, fixture.mainClass, [peer.root]);
    plain = fixtureJvm(java, peer.root, fixture.mainClass, [peer.root], { debug: false });
    outsider = fixtureJvm(java, home, fixture.mainClass, [peer.root],
      { vmArgs: linux ? ['-Duser.dir=' + peer.root] : [] });
    stale = fixtureJvm(java, peer.root, fixture.mainClass, [peer.root]);
    const [port, plainPort, outsidePort, stalePort] = await Promise.all([target.readyPort(), plain.readyPort(), outsider.readyPort(), stale.readyPort()]);
    const request = { javaHome, file: local, pid: target.target.pid, port };
    const approve = review => ({ token: review.token, sourceFile: review.sourceFile, allowSshJavaDebug: true });
    await assert.rejects(service.review(peer, home, { ...request, port: plainPort }), /exact IPv4 loopback JDWP/);
    await assert.rejects(service.review(peer, home, { ...request, pid: plain.target.pid, port: plainPort }), /exact IPv4 loopback JDWP/);
    await assert.rejects(service.review(peer, home, { ...request, pid: outsider.target.pid, port: outsidePort }), /reported workspace/);
    if (linux) {
      const competitor = await openListener({ host: '::1', port, ipv6Only: true }, socket => socket.destroy());
      try { await assert.rejects(service.review(peer, home, request), /exact IPv4 loopback JDWP/); }
      finally { await closeListener(competitor); }
    }
    const old = await service.review(peer, home, { ...request, pid: stale.target.pid, port: stalePort });
    if (linux) early = await service.open(peer, home, approve(old));
    await stale.leave();
    if (linux) {
      let connections = 0;
      const replacement = await openListener({ host: '127.0.0.1', port: stalePort }, socket => { connections++; socket.destroy(); });
      try {
        assert.equal(await observeRejectedRelay(early.localPort), 0);
        assert.equal(connections, 0);
      } finally {
        await early.close();
        await closeListener(replacement);
      }
    } else await assert.rejects(service.open(peer, home, approve(old)), /did not confirm the reviewed JVM/);
    const changed = await service.review(peer, home, request);
    await fs.appendFile(local, '// deliberate source drift\n');
    await assert.rejects(service.open(peer, home, approve(changed)), /exact same Java source/);
    await fs.writeFile(local, fixture.source);
    const review = await service.review(peer, home, request);
    assert.equal(review.pid, target.target.pid);
    assert.equal(review.platform, process.platform);
    assert.equal(review.debugPort, port);
    assert.equal(review.remoteFile, '/src/fixture/AttachFixture.java');
    await assert.rejects(service.open(peer, home, { token: review.token }), /Approve the current/);
    await assert.rejects(service.open(peer, home, { ...approve(review), sourceFile: verifier }), /Approve the current/);
    forward = await service.open(peer, home, approve(review));
    assert.equal(forward.host, '127.0.0.1');
    assert.equal(forward.sourceFile, local);
    assert.equal(forward.sourceRoot, path.join(home, 'src'));
    await assert.rejects(service.open(peer, home, approve(review)), /Approve the current/);
    const result = await invoke(java, ['--add-modules', 'jdk.jdi', verifier, String(forward.localPort), fixture.mainClass, String(fixture.line)],
      { cwd: home, timeout: 26000, windowsHide: true });
    const [held, line, value] = result.stdout.trim().split(':');
    assert.equal(path.join(forward.sourceRoot, ...held.split('/')), local);
    assert.equal(Number(line), fixture.line);
    assert.equal(value, '73');
    await until(() => target.output().includes('DEBUG_FIXTURE_RESUMED:73'), 10000);
    assert.equal(target.ended(), false);
    await forward.close();
    await assert.rejects(connectPort(forward.host, forward.localPort), { code: 'ECONNREFUSED' });
    assert.equal((await peer.stat('/src/fixture/AttachFixture.java')).kind, 'file');
    const evidence = { sourceCommit: process.env.GITHUB_SHA ?? null, platform: process.platform, architecture: process.arch,
      java: (await invoke(java, ['--version'], { timeout: 9000, windowsHide: true })).stdout.split(/\r?\n/u)[0],
      realOpenSshClient: true, asyncssh: owned.asyncssh, verifiedOwnerBeforeAndAfterTcp: true,
      sourceBytesAndPackageRoot: true, breakpoint: fixture.line, localValue: 73, targetResumed: true,
      routeReleased: true, existingFileChannelPreserved: true, wrongHostRejected: true, wrongPidAndPlainRejected: true,
      otherProjectRejected: true, exitedPidRejected: true, sourceDriftRejected: true, oneShot: true,
      ...(linux && { procUidStartAndSocketInode: true, kernelCwdOverridesSpoofedJavaCwd: true,
        ipv6CompetitorRejected: true, samePortReplacementNeverContacted: true }) };
    context.diagnostic(JSON.stringify(evidence));
    if (process.env.ROCKETBRAIN_SSH_DEBUG_TEST_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SSH_DEBUG_TEST_RECEIPT,
      JSON.stringify(evidence, null, 2) + '\n');
  } finally {
    await forward?.close();
    await early?.close();
    await Promise.all([target, plain, outsider, stale].map(child => child?.leave()));
    peer?.close();
  }
});
