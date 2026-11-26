'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { parseDarwinTcpListeners, parseDarwinSocketOwners, correlateDarwinListeners,
  readDarwinListeners } = require('../src/java/darwin-debug-listeners');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');
const { waitForOwnedListener } = require('../src/java/testing-debug');
const { processFixture, fixtureJvm } = require('./helpers/java-debug-process-fixture');
const { until } = require('./helpers/stdio-lsp');

const invoke = promisify(execFile);
const netstatHeader = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state)\n';
const lsofLine = (...fields) => fields.join('\0') + '\0\n';

test('macOS listener ownership requires exact agreement across netstat and same-UID lsof records', () => {
  const network = parseDarwinTcpListeners(netstatHeader + [
    'tcp4 0 0 127.0.0.1.43001 *.* LISTEN',
    'tcp4 0 0 127.0.0.1.43001 127.0.0.1.51111 ESTABLISHED',
    'tcp4 0 0 127.0.0.1.43002 *.* LISTEN',
    'tcp6 0 0 ::1.43002 *.* LISTEN',
    'tcp4 0 0 *.43003 *.* LISTEN',
    'tcp4 0 0 127.0.0.1.43004 *.* LISTEN',
    'tcp4 0 0 127.0.0.1.43005 *.* LISTEN',
    'tcp4 0 0 127.0.0.1.43006 *.* LISTEN',
    'tcp4 0 0 127.0.0.1.43007 *.* LISTEN',
    'tcp6 0 0 ::1.43008 *.* LISTEN'
  ].join('\n'));
  const owner = parseDarwinSocketOwners([
    lsofLine('p870', 'u502'),
    lsofLine('f3', 'tIPv4', 'n127.0.0.1:43001'),
    lsofLine('f4', 'tIPv4', 'n127.0.0.1:43002'),
    lsofLine('f5', 'tIPv4', 'n127.0.0.1:43003'),
    lsofLine('f6', 'tIPv4', 'n127.0.0.1:43005'),
    lsofLine('f7', 'tIPv4', 'n127.0.0.1:43005'),
    lsofLine('f8', 'tIPv4', 'n127.0.0.2:43006'),
    lsofLine('f9', 'tIPv6', 'n[::1]:43008'),
    lsofLine('f10', 'tIPv4', 'n127.0.0.1:43999'),
    lsofLine('p871', 'u503'),
    lsofLine('f4', 'tIPv4', 'n127.0.0.1:43007')
  ].join(''), 502);
  assert.deepEqual([...correlateDarwinListeners(network, owner)].map(([port, row]) => [port, row.pid ?? null]),
    [[43001, 870], [43002, null], [43003, null], [43004, null], [43005, null], [43006, null], [43007, null], [43008, null]]);
  assert.throws(() => parseDarwinTcpListeners('unrelated stdout'), /unrecognized/);
  assert.throws(() => parseDarwinTcpListeners(netstatHeader + 'tcp4 0 0 broken *.* LISTEN'), /invalid/);
  assert.throws(() => parseDarwinSocketOwners('p870\0u502', 502), /incomplete/);
  assert.throws(() => parseDarwinSocketOwners(lsofLine('f3', 'tIPv4', 'n127.0.0.1:43001'), 502), /unordered/);
});

const jdi = String.raw`
import com.sun.jdi.Bootstrap;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.request.EventRequest;

class VerifyMacDebug {
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
                        prepare.disable();
                    } else if (event instanceof BreakpointEvent stopped) {
                        var frame = stopped.thread().frame(0);
                        var local = frame.getValue(frame.visibleVariableByName("watched"));
                        System.out.println(stopped.location().sourceName() + ":" + stopped.location().lineNumber() + ":" + local);
                        return;
                    }
                }
                events.resume();
            }
            throw new IllegalStateException("The owned JVM did not hit the fixture breakpoint.");
        } finally {
            vm.dispose();
        }
    }
}
`;

test('actual macOS JVM discovery verifies dynamic loopback ownership and detaches after a real JDI breakpoint', {
  skip: (process.platform !== 'darwin' || process.env.ROCKETBRAIN_MACOS_JVM_TEST !== '1') && 'Run the owned macOS Temurin and Darwin socket fixture.',
  timeout: 110000
}, async context => {
  const javaHome = process.env.JAVA_HOME;
  assert.ok(path.isAbsolute(javaHome || ''), 'Use an absolute selected JDK 25.');
  const java = path.join(javaHome, 'bin', 'java');
  const javac = path.join(javaHome, 'bin', 'javac');
  const jdk = (await invoke(java, ['--version'], { timeout: 8000 })).stdout.split('\n')[0].trim();
  assert.match(jdk, /^openjdk 25[.\s]/u);
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-darwin-jvm-'));
  const identity = await fs.lstat(owned, { bigint: true });
  context.after(async () => {
    const real = await fs.realpath(owned);
    const current = await fs.lstat(real, { bigint: true });
    assert.equal(real, owned);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-darwin-jvm-/u);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await fs.rm(real, { recursive: true, force: true });
  });
  const fixture = processFixture('fixture.darwin', 'AttachFixture');
  const source = path.join(owned, 'AttachFixture.java');
  const verifier = path.join(owned, 'VerifyMacDebug.java');
  await fs.writeFile(source, fixture.source, { flag: 'wx' });
  await fs.writeFile(verifier, jdi, { flag: 'wx' });
  await invoke(javac, ['-g', '-d', owned, source], { timeout: 25000, cwd: owned });
  const target = fixtureJvm(java, owned, fixture.mainClass, [owned]);
  const plain = fixtureJvm(java, owned, fixture.mainClass, [owned], { debug: false });
  try {
    const [port, plainPort] = await Promise.all([target.readyPort(), plain.readyPort()]);
    assert.notEqual(port, plainPort);
    const osOwner = await readDarwinListeners({ port });
    assert.equal(osOwner.get(port)?.pid, target.target.pid, 'netstat and lsof agree on the owned loopback port.');
    const service = createDebugProcessDiscovery({ javaHome: () => javaHome, trusted() {} });
    const entries = await service.list();
    const picked = entries.find(entry => entry.pid === target.target.pid);
    assert.ok(picked, 'HotSpot Attach API confirmed the JDWP listener already verified by macOS.');
    assert.equal(picked.hostName, '127.0.0.1');
    assert.equal(picked.port, port);
    assert.ok(!entries.some(entry => entry.pid === plain.target.pid));
    assert.doesNotMatch(JSON.stringify(entries), /fixture-private-argument/u);
    await assert.rejects(service.resolve(plain.target.pid), /verified local JDWP listener/);
    await assert.rejects(service.resolve({ ...picked, startedAt: picked.startedAt - 1 }), /changed/);
    await assert.rejects(service.resolve({ ...picked, hostName: '127.0.0.2' }), /changed/);
    await assert.rejects(service.resolve({ ...picked, port: plainPort }), /changed/);
    await assert.rejects(waitForOwnedListener({ pid: picked.pid, port: plainPort, timeoutMs: 1500 }), { code: 'FOREIGN_LISTENER' });
    await assert.rejects(service.resolve(picked, AbortSignal.abort()), /cancelled/);
    assert.deepEqual(await service.resolve(picked), picked);
    const halted = await invoke(java, ['--add-modules', 'jdk.jdi', verifier, String(picked.port), fixture.mainClass, String(fixture.line)],
      { timeout: 28000, cwd: owned });
    assert.equal(halted.stdout.trim(), 'AttachFixture.java:' + fixture.line + ':73');
    await until(() => target.output().includes('DEBUG_FIXTURE_RESUMED:73'), 10000);
    assert.equal(target.ended(), false);
    await target.leave();
    await assert.rejects(service.resolve(picked), /verified local JDWP listener/);
    if (process.env.ROCKETBRAIN_MACOS_JVM_RECEIPT) {
      const result = {
        sourceCommit: process.env.GITHUB_SHA ?? null,
        platform: process.platform, architecture: process.arch, release: os.release(), jdk, exactListenerOwner: true,
        tools: ['netstat', 'lsof', 'HotSpot Attach API', 'JDI'], normalSocketExcluded: true, foreignSocketRefused: true,
        staleIdentityRefused: true, mismatchedHostAndPortRefused: true, cancelledBeforeAttach: true, stoppedAt: fixture.line,
        localValue: 73, detachedProcessResumed: true, exitedTargetRefused: true
      };
      await fs.writeFile(process.env.ROCKETBRAIN_MACOS_JVM_RECEIPT, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
  } finally {
    await Promise.all([target.leave(), plain.leave()]);
  }
});
