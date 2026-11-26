'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { independentJavaExecutable } = require('./debug-runtime');
const { waitForOwnedListener } = require('./testing-debug');
const { readLinuxListeners } = require('./linux-debug-listeners');
const { readDarwinListeners } = require('./darwin-debug-listeners');

const limit = 32;
const listenerLimit = 2048;
const loopback = '127.0.0.1';
// HotSpot exposes the actual port, including dynamically assigned ports, only while JDWP is listening.
const LOOKUP = String.raw`
import com.sun.tools.attach.VirtualMachine;
import com.sun.tools.attach.VirtualMachineDescriptor;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

class RocketbrainDebugProcesses {
    private static final String ADDRESS_PROPERTY = "sun.jdwp.listenerAddress";

    private static String inspect(VirtualMachineDescriptor descriptor, String owner) {
        try {
            var process = ProcessHandle.of(Long.parseLong(descriptor.id())).orElseThrow();
            if (!process.isAlive()) return null;
            var info = process.info();
            if (!owner.equalsIgnoreCase(info.user().orElse(""))) return null;
            var binary = Path.of(info.command().orElseThrow()).getFileName().toString();
            if (!binary.equals("java") && !binary.matches("(?i)javaw?\\.exe")) return null;
            var started = info.startInstant().orElseThrow().toEpochMilli();
            var vm = VirtualMachine.attach(descriptor);
            String address;
            try {
                address = vm.getAgentProperties().getProperty(ADDRESS_PROPERTY, "");
            } finally {
                vm.detach();
            }
            if (!address.matches("^dt_socket:[0-9]{1,5}$")) return null;
            String label = descriptor.displayName().split("\\s+", 2)[0];
            label = label.replaceFirst("^.*[/\\\\]", "");
            if ("Unknown".equalsIgnoreCase(label) || !label.matches("[\\p{L}\\p{N}_.$-]{1,120}")) label = binary;
            return descriptor.id() + "\t" + started + "\t" + address.substring(10) + "\t" + label;
        } catch (Exception unavailable) {
            return null;
        }
    }

    public static void main(String[] pids) {
        System.setOut(new java.io.PrintStream(System.out, true, java.nio.charset.StandardCharsets.UTF_8));
        var requested = new HashSet<>(java.util.List.of(pids));
        var owner = ProcessHandle.current().info().user().orElse("");
        if (owner.isBlank() || requested.size() > 2048) return;
        var candidates = VirtualMachine.list().stream()
            .filter(item -> requested.contains(item.id()))
            .limit(32)
            .map(item -> CompletableFuture.supplyAsync(() -> inspect(item, owner)))
            .toList();
        CompletableFuture.allOf(candidates.toArray(CompletableFuture[]::new))
            .completeOnTimeout(null, 7, TimeUnit.SECONDS).join();
        for (var candidate : candidates) {
            String value = candidate.getNow(null);
            if (value != null) System.out.println(value);
        }
    }
}
`;

const SOCKETS = [
  "$ErrorActionPreference='Stop'",
  "Get-NetTCPConnection -State Listen | Group-Object LocalPort | ForEach-Object {",
  "if ($_.Count -eq 1 -and $_.Group[0].LocalAddress -eq '127.0.0.1') {",
  "$row=$_.Group[0]; [Console]::Out.WriteLine(('{0}:{1}' -f $row.OwningProcess,$row.LocalPort))",
  '}}'
].join('\n');

function processId(value) {
  if (typeof value === 'string' && /^[0-9]{1,10}$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) {
    throw Error('Provide a positive local Java process ID.');
  }
  return value;
}

function validPort(value) { return Number.isInteger(value) && value >= 1 && value <= 65535; }

function readSocketOwners(source) {
  const owners = new Map();
  for (const line of String(source).trim().split(/\r?\n/)) {
    const [, pid, port] = /^([0-9]{1,10}):([0-9]{1,5})$/.exec(line) || [];
    if (!pid || Number(pid) < 1 || Number(pid) > 0xffffffff || !validPort(Number(port))) continue;
    const ports = owners.get(Number(pid)) || new Set();
    ports.add(Number(port));
    owners.set(Number(pid), ports);
  }
  return owners;
}

function readyProcesses(source, owners) {
  const entries = new Map();
  for (const line of String(source).trim().split(/\r?\n/)) {
    const [id, time, socket, label, extra] = line.split('\t');
    const pid = Number(id), startedAt = Number(time), port = Number(socket);
    if (extra !== undefined || !/^[0-9]{1,10}$/.test(id) || !owners.get(pid)?.has(port) ||
        !Number.isSafeInteger(startedAt) || startedAt < 1 || !/^[\p{L}\p{N}_.$-]{1,120}$/u.test(label || '')) continue;
    const entry = { pid, startedAt, hostName: loopback, port, label };
    const previous = entries.get(pid);
    if (!entries.has(pid)) entries.set(pid, entry);
    else if (previous?.port !== port || previous?.startedAt !== startedAt) entries.set(pid, undefined);
  }
  return [...entries.values()].filter(Boolean).sort((a, b) => a.label.localeCompare(b.label) || a.pid - b.pid);
}

function invoke(file, args, { signal, cwd, env, message } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024, cwd, env, signal },
      (error, stdout) => {
        if (!error) resolve(stdout);
        else reject(Error(signal?.aborted ? 'Java process discovery was cancelled.' : message));
      });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

async function onCancellation(cancellation, task) {
  if (cancellation instanceof AbortSignal) return task(cancellation);
  const control = new AbortController();
  const listener = cancellation?.onCancellationRequested?.(() => control.abort());
  if (cancellation?.isCancellationRequested) control.abort();
  try { return await task(control.signal); } finally { listener?.dispose(); }
}

async function socketOwners(signal) {
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const readListeners = process.platform === 'linux' ? readLinuxListeners : readDarwinListeners;
    const owners = new Map();
    for (const [port, listener] of await readListeners({ signal })) {
      if (!listener.pid) continue;
      const ports = owners.get(listener.pid) || new Set();
      ports.add(port);
      owners.set(listener.pid, ports);
    }
    return owners;
  }
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return readSocketOwners(await invoke(powershell, ['-NoProfile', '-NonInteractive', '-Command', SOCKETS],
    { signal, message: 'Windows could not verify local TCP listener ownership.' }));
}

async function queryJvm(launcher, pids, signal) {
  if (!pids.length) return '';
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-debug-process-'));
  const identity = await fs.lstat(owned, { bigint: true });
  try {
    const source = path.join(owned, 'RocketbrainDebugProcesses.java');
    await fs.writeFile(source, LOOKUP, { flag: 'wx' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|CLASSPATH)$/i.test(key)));
    return await invoke(launcher, ['--add-modules', 'jdk.attach', source, ...pids.map(String)], {
      cwd: owned, env, signal, message: 'The local JDK could not inspect active Java debug processes.'
    });
  } finally {
    const real = await fs.realpath(owned);
    const current = await fs.lstat(real, { bigint: true });
    if (path.relative(owned, real) || path.relative(parent, path.dirname(real)) || !path.basename(real).startsWith('rb-debug-process-') ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw Error('Java process discovery temporary directory identity changed.');
    await fs.rm(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 125 });
  }
}

function createDebugProcessDiscovery({ javaHome, trusted } = {}) {
  async function discover(pid, signal) {
    trusted();
    if (signal?.aborted) throw Error('Java process discovery was cancelled.');
    if (!['win32','linux','darwin'].includes(process.platform)) {
      throw Error('Local PID discovery verifies listener ownership on Windows, Linux and macOS. Enter the JVM host and port for manual attach.');
    }
    const home = javaHome();
    if (!path.isAbsolute(home || '')) throw Error('Configure the independent Java engine before finding JVMs.');
    const launcher = independentJavaExecutable(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    let owners;
    try { owners = await socketOwners(signal); } catch (error) {
      if (signal?.aborted) throw Error('Java process discovery was cancelled.');
      throw error;
    }
    const pids = pid ? (owners.has(pid) ? [pid] : []) : [...owners.keys()].slice(0, listenerLimit);
    const results = readyProcesses(await queryJvm(launcher, pids, signal), owners).slice(0, limit);
    trusted();
    return results;
  }

  return {
    async list(cancellation) {
      return onCancellation(cancellation, signal => discover(undefined, signal));
    },
    async resolve(selection, cancellation) {
      const expected = selection && typeof selection === 'object' ? selection : undefined;
      const pid = processId(expected?.pid ?? selection);
      return onCancellation(cancellation, async signal => {
        const [found] = await discover(pid, signal);
        if (!found) throw Error('The Java process does not have a verified local JDWP listener.');
        if (expected && (expected.startedAt !== found.startedAt || expected.port !== found.port || expected.hostName !== loopback)) {
          throw Error('The selected Java process or its debug listener changed. Select the process again.');
        }
        try { await waitForOwnedListener({ pid, port: found.port, cancellation: signal, timeoutMs: 2500 }); }
        catch (error) {
          if (signal.aborted) throw Error('Java process discovery was cancelled.');
          throw Error('The selected Java process no longer owns its debug listener.', { cause: error });
        }
        trusted();
        return found;
      });
    }
  };
}

module.exports = { createDebugProcessDiscovery, processId, readSocketOwners, readyProcesses };
