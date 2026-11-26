'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { parseLinuxListeners } = require('../src/java/linux-debug-listeners');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');
const { waitForOwnedListener } = require('../src/java/testing-debug');
const { processFixture, fixtureJvm } = require('./helpers/java-debug-process-fixture');
const { until } = require('./helpers/stdio-lsp');

const invoke = promisify(execFile);
const jdi = String.raw`
import com.sun.jdi.Bootstrap;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.request.EventRequest;

class VerifyLinuxDebug {
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
            while (true) {
                var events = vm.eventQueue().remove(12000);
                if (events == null) throw new IllegalStateException("The owned JVM did not reach the fixture breakpoint.");
                for (var event : events) {
                    if (event instanceof ClassPrepareEvent loaded) {
                        var line = Integer.parseInt(args[2]);
                        var location = loaded.referenceType().locationsOfLine(line).getFirst();
                        var breakpoint = vm.eventRequestManager().createBreakpointRequest(location);
                        breakpoint.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                        breakpoint.enable();
                    }
                    if (event instanceof BreakpointEvent stopped) {
                        var frame = stopped.thread().frame(0);
                        var value = frame.getValue(frame.visibleVariableByName("watched"));
                        System.out.println(stopped.location().lineNumber() + ":" + value);
                        return;
                    }
                }
                events.resume();
            }
        } finally {
            vm.dispose();
        }
    }
}
`;

test('Linux listener ownership requires one exact IPv4 loopback socket and one reported PID', () => {
  const rows = parseLinuxListeners([
    'LISTEN 0 50 127.0.0.1:43001 0.0.0.0:* users:(("java",pid=870,fd=3))   ',
    'LISTEN 0 50 127.0.0.1:43002 0.0.0.0:* users:(("java",pid=871,fd=4))',
    'LISTEN 0 50 [::1]:43002 [::]:* users:(("java",pid=871,fd=5))',
    'LISTEN 0 50 127.0.0.1:43003 0.0.0.0:*',
    'LISTEN 0 50 *:43004 *:* users:(("java",pid=872,fd=6))',
    'LISTEN 0 50 127.0.0.1:43005 0.0.0.0:* users:(("java",pid=873,fd=8),("java",pid=874,fd=8))'
  ].join('\n'));
  assert.deepEqual([...rows].map(([port, row]) => [port, row.pid]),
    [[43001, 870], [43002, null], [43003, null], [43004, null], [43005, null]]);
  assert.throws(() => parseLinuxListeners('LISTEN 0 50 unexpected record'), /unrecognized/);
});

test('actual Linux JVM discovery verifies a dynamic JDWP port and detaches after a real JDI breakpoint', {
  skip: (process.platform !== 'linux' || process.env.ROCKETBRAIN_LINUX_JVM_TEST !== '1') && 'Run the owned Linux JDK and iproute2 fixture.',
  timeout: 85000
}, async context => {
  const javaHome = process.env.JAVA_HOME;
  assert.ok(path.isAbsolute(javaHome), 'Use an absolute selected JDK 25.');
  const java = path.join(javaHome, 'bin', 'java');
  const javac = path.join(javaHome, 'bin', 'javac');
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-linux-jvm-'));
  context.after(async () => {
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-linux-jvm-/);
    await fs.rm(owned, { recursive: true, force: true });
  });
  const fixture = processFixture('fixture.linux', 'AttachFixture');
  const source = path.join(owned, 'AttachFixture.java');
  const verifier = path.join(owned, 'VerifyLinuxDebug.java');
  await fs.writeFile(source, fixture.source, { flag: 'wx' });
  await fs.writeFile(verifier, jdi, { flag: 'wx' });
  await invoke(javac, ['-g', '-d', owned, source], { timeout: 20000 });
  const target = fixtureJvm(java, owned, fixture.mainClass, [owned]);
  const plain = fixtureJvm(java, owned, fixture.mainClass, [owned], { debug: false });
  try {
    const [port, plainPort] = await Promise.all([target.readyPort(), plain.readyPort()]);
    const service = createDebugProcessDiscovery({ javaHome: () => javaHome, trusted() {} });
    const entries = await service.list();
    const picked = entries.find(entry => entry.pid === target.target.pid);
    assert.ok(picked);
    assert.equal(picked.port, port);
    assert.ok(!entries.some(entry => entry.pid === plain.target.pid));
    assert.doesNotMatch(JSON.stringify(entries), /fixture-private-argument/);
    await assert.rejects(service.resolve({ ...picked, startedAt: picked.startedAt - 1 }), /changed/);
    await assert.rejects(waitForOwnedListener({ pid: picked.pid, port: plainPort, timeoutMs: 1000 }), { code: 'FOREIGN_LISTENER' });
    assert.deepEqual(await service.resolve(picked), picked);
    const halted = await invoke(java, ['--add-modules', 'jdk.jdi', verifier, String(port), fixture.mainClass, String(fixture.line)],
      { timeout: 24000, cwd: owned });
    assert.equal(halted.stdout.trim(), fixture.line + ':73');
    await until(() => target.output().includes('DEBUG_FIXTURE_RESUMED:73'), 10000);
    assert.equal(target.ended(), false);
    await target.leave();
    await assert.rejects(service.resolve(picked), /verified local JDWP listener/);
    if (process.env.ROCKETBRAIN_LINUX_JVM_RECEIPT) {
      await fs.writeFile(process.env.ROCKETBRAIN_LINUX_JVM_RECEIPT, JSON.stringify({
        platform: process.platform, jdk: (await invoke(java, ['--version'])).stdout.split('\n')[0], exactListenerOwner: true,
        normalSocketExcluded: true, foreignSocketRefused: true, staleIdentityRefused: true, stoppedAt: fixture.line,
        localValue: 73, detachedProcessResumed: true, exitedTargetRefused: true
      }, null, 2) + '\n', { flag: 'wx' });
    }
  } finally {
    await Promise.all([target.leave(), plain.leave()]);
  }
});
