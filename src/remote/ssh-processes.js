'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { secureSshTarget } = require('../db/connection-tunnel');
const { pythonCommand } = require('./ssh-files-worker');
const { rootParts } = require('./ssh-java-mapping');
const { debugSupervisorInvocation } = require('./ssh-java-debug-runtime');
const { compileProgram, compileRequest } = require('./ssh-java-compile-runtime');
const { compileConfig, compileProof, validCompileReview, validCompileResult } = require('./ssh-java-compile');
const { mavenProgram, mavenRequest } = require('./ssh-maven-runtime');
const { mavenConfig, mavenProof, validMavenReview, validMavenResult } = require('./ssh-maven');
const { gradleProgram, gradleRequest } = require('./ssh-gradle-runtime');
const { gradleConfig, gradleProof, validGradleReview, validGradleResult } = require('./ssh-gradle');
const { javaSupervisorInvocation } = require('../devcontainer/java-process');

const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const rootBoundBytes = 4 * 1024 * 1024;
const terminalProgram = `import os, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
if not root.is_dir() or root.resolve(strict=True) != root:
    raise ValueError("The reviewed workspace path changed")
os.chdir(root)
env = dict(os.environ)
for key in ("ENV", "BASH_ENV"):
    env.pop(key, None)
if sys.platform == "win32":
    shell = pathlib.Path(os.environ.get("SystemRoot", r"C:\\Windows")) / "System32" / "cmd.exe"
    sys.exit(subprocess.call([str(shell), "/D", "/Q", "/K", "chcp 65001 >nul"], env=env))
else:
    os.execve("/bin/sh", ["sh", "-i"], env)
`;

async function observeKnownHosts(file) {
  const resolved = await fs.realpath(file), stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size < 1 || stat.size > rootBoundBytes) throw Error('Choose a verified SSH known_hosts file.');
  const bytes = await fs.readFile(resolved);
  if (!bytes.length || bytes.length > rootBoundBytes) throw Error('Choose a verified SSH known_hosts file.');
  return { resolved, bytes, sha256: bytesHash(bytes) };
}

function commandWithArgs(python, program, argv) {
  const payload = Buffer.from(JSON.stringify(argv)).toString('base64');
  return pythonCommand(python, "import base64, json, sys\nsys.argv = ['rocketbrain'] + json.loads(base64.b64decode('" + payload + "'))\n" + program);
}

function collectRuntime(child, valid, message, { input, timeout = 18000, maxBytes = 8192, keepInput = false,
  reportRemoteError = false, signal, cancelMessage = 'The SSH Java compile was cancelled.', cancelGrace = 2200 } = {}) {
  return new Promise((resolve, reject) => {
    let count = 0, invalid = false;
    let stopTimer, reason;
    const chunks = [];
    function stop(error) {
      if (invalid) return;
      invalid = true;
      reason = error;
      if (keepInput) {
        child.stdin.end();
        stopTimer = setTimeout(() => child.kill(), cancelGrace);
        stopTimer.unref();
      } else child.kill();
    }
    const abort = () => stop(cancelMessage);
    const timer = setTimeout(() => stop(), timeout);
    child.stdin.on('error', () => {});
    if (keepInput) child.stdin.write(input);
    else child.stdin.end(input);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', data => {
      count += data.length;
      if (count > maxBytes) stop();
      else chunks.push(data);
    });
    child.stderr.resume();
    child.once('error', () => { invalid = true; });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      try {
        if (invalid || code !== 0) throw Error(reason || message);
        const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (reportRemoteError && typeof info?.error === 'string' && /^[\x20-\x7e]{1,160}$/u.test(info.error)) {
          reject(Error(info.error));
          return;
        }
        if (!valid(info)) throw Error(message);
        resolve(info);
      } catch { reject(Error(reason || message)); }
    });
  });
}

async function createPinnedSshPeer(profile) {
  const anchor = await observeKnownHosts(profile.knownHostsPath);
  const base = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(base, 'rb-ssh-process-'));
  const leaf = path.join(folder, 'known_hosts');
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    await fs.rm(leaf, { force: true });
    await fs.rmdir(folder);
  }

  try {
    await fs.writeFile(leaf, anchor.bytes, { flag: 'wx', mode: 0o600 });
    const target = await secureSshTarget({ ...profile, knownHostsPath: leaf });
    return {
      target, close, anchorSha256: anchor.sha256,
      async verify() {
        if (closed) throw Error('Reopen the SSH workspace before connecting.');
        const now = await observeKnownHosts(profile.knownHostsPath).catch(() => undefined);
        if (closed || !now || path.relative(anchor.resolved, now.resolved) || now.sha256 !== anchor.sha256) {
          throw Error('The known_hosts file changed. Reopen the SSH workspace and review again.');
        }
      }
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function createSshProcesses(profile, remoteRoot, target, verifyRoot) {
  const offers = new Map(), active = new Map();
  let closed = false, started = false;
  function processFor(kind, command, tty) {
    if (closed) throw Error('Reopen the SSH workspace before launching a remote process.');
    if (active.size >= 3) throw Error('Too many SSH workspace processes are active. Wait for a process to finish.');
    const options = tty ? ['-tt', '-e', 'none', ...target.options.filter(flag => flag !== '-T')] : target.options;
    const child = spawn(target.executable, [...options, ...target.destination, command], { shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    active.set(child, kind);
    child.stdin.on('error', () => {});
    child.once('error', () => {});
    child.once('close', () => active.delete(child));
    return child;
  }

  async function javaRuntime(config) {
    const { program, argv } = javaSupervisorInvocation(config, undefined, 'ssh');
    return collectRuntime(processFor('probe', commandWithArgs(profile.python, program, argv)),
      info => Number.isSafeInteger(info.jdk) && info.jdk >= 25 && /^[a-f0-9]{64}$/.test(info.sha256 || ''),
      'Verify Python, the independent JDK 25+ and Eclipse JDT LS inside the reviewed SSH workspace.');
  }

  function debugProcess(config, expected) {
    const { program, argv } = debugSupervisorInvocation(config, expected);
    const input = JSON.stringify(argv) + '\n';
    if (Buffer.byteLength(input) > 16384) throw Error('The SSH Java debug paths exceeded their input limit.');
    const child = processFor(expected ? 'debug' : 'probe', pythonCommand(profile.python, program));
    if (expected) {
      child.stdin.write(input);
      return child;
    }
    return collectRuntime(child, info => info.pid === config.pid && info.port === config.port && info.platform === config.platform &&
      Number.isSafeInteger(info.startedAt) && info.startedAt > 0 && /^[a-f0-9]{64}$/.test(info.jdkSha256 || '') &&
      (config.platform === 'win32' || /^[1-9][0-9]{0,19}$/.test(info.linuxStartTicks || '') &&
        /^[1-9][0-9]{0,19}$/.test(info.linuxListenerInode || '')),
    'Verify a same-account JVM, its reported workspace directory and exact IPv4 loopback JDWP listener on Windows or Linux.',
    { input, timeout: 38000 });
  }

  function compileProcess(config, expected, signal) {
    signal?.throwIfAborted();
    const input = compileRequest(config, expected);
    const child = processFor(expected ? 'compile' : 'probe', pythonCommand(profile.python, compileProgram));
    return collectRuntime(child, expected ? validCompileResult : info => validCompileReview(info, config),
      'Verify the independent remote JDK 25 and reviewed Java module before compiling.',
      { input, signal, keepInput: Boolean(expected), reportRemoteError: true, timeout: expected ? 47000 : 18000, maxBytes: 65536 });
  }

  function mavenProcess(config, expected, signal) {
    signal?.throwIfAborted();
    const input = mavenRequest(config, expected);
    const child = processFor(expected ? 'maven' : 'probe', pythonCommand(profile.python, mavenProgram));
    return collectRuntime(child, expected ? info => validMavenResult(info, config) : info => validMavenReview(info, config),
      'Verify the reviewed Maven project, remote runtimes and prepared offline Maven repository.',
      { input, signal, keepInput: Boolean(expected), reportRemoteError: true, timeout: expected ? 120000 : 38000,
        cancelMessage: 'The SSH Maven build was cancelled.' });
  }

  function gradleProcess(config, expected, signal) {
    signal?.throwIfAborted();
    const input = gradleRequest(config, expected);
    const child = processFor(expected ? 'gradle' : 'probe', pythonCommand(profile.python, gradleProgram));
    return collectRuntime(child, expected ? info => validGradleResult(info, config) : info => validGradleReview(info, config),
      'Verify the reviewed Gradle project, independent runtimes and prepared offline dependency mirror.',
      { input, signal, keepInput: Boolean(expected), reportRemoteError: true, timeout: expected ? 200000 : 64000,
        cancelMessage: 'The SSH Gradle build was cancelled.', cancelGrace: 7000 });
  }

  return {
    async inspect(kind, requested) {
      if (!['terminal', 'java', 'debug', 'compile', 'maven', 'gradle'].includes(kind)) throw Error('Choose a supported reviewed SSH workspace process.');
      rootParts(remoteRoot);
      let config;
      if (kind === 'java') {
        const { javaHome, serverPath } = requested || {};
        const workspace = rootParts(remoteRoot);
        for (const value of [javaHome, serverPath]) {
          if (Boolean(rootParts(value).drive) !== Boolean(workspace.drive)) throw Error('Use absolute Java paths on this SSH host.');
        }
        config = { javaHome, serverPath, containerRoot: remoteRoot };
      }
      if (kind === 'debug') {
        const { javaHome, pid, port } = requested || {};
        const windows = Boolean(rootParts(remoteRoot).drive);
        if (Boolean(rootParts(javaHome).drive) !== windows) throw Error('Use a remote JDK 25 path on the same Windows or Linux SSH host.');
        if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw Error('Choose an exact remote JVM process ID and debug port.');
        }
        config = { platform: windows ? 'win32' : 'linux', javaHome, pid, port, root: remoteRoot };
      }
      if (kind === 'compile') config = compileConfig(remoteRoot, requested);
      if (kind === 'maven') config = mavenConfig(remoteRoot, requested);
      if (kind === 'gradle') config = gradleConfig(remoteRoot, requested);
      await verifyRoot();
      let info;
      if (kind === 'debug') info = await debugProcess(config);
      else if (kind === 'compile') info = await compileProcess(config);
      else if (kind === 'maven') info = await mavenProcess(config);
      else if (kind === 'gradle') info = await gradleProcess(config);
      else if (kind === 'java') info = await javaRuntime(config);
      if (closed) throw Error('The SSH workspace closed.');
      const now = Date.now();
      for (const [token, offer] of offers) if (offer.expires <= now) offers.delete(token);
      while (offers.size >= 8) offers.delete(offers.keys().next().value);
      const token = randomUUID();
      offers.set(token, { kind, config, info, expires: now + 120000 });
      return { token, kind, host: profile.host, port: profile.port ?? 22, user: profile.user, root: remoteRoot,
        ...(kind === 'java' && { jdk: info.jdk, javaHome: config.javaHome, serverPath: config.serverPath }),
        ...(kind === 'debug' && { platform: info.platform, javaHome: config.javaHome, pid: info.pid, debugPort: info.port, startedAt: info.startedAt }),
        ...(kind === 'compile' && { ...info, file: config.file, javaHome: config.javaHome, jars: config.jars }),
        ...(kind === 'maven' && { ...info, file: config.file, javaHome: config.javaHome,
          mavenHome: config.mavenHome, repository: config.repository }),
        ...(kind === 'gradle' && { ...info, file: config.file, javaHome: config.javaHome,
          gradleHome: config.gradleHome, repository: config.repository }) };
    },
    async open(kind, approval) {
      if (closed || approval?.allowRemoteProcess !== true) throw Error('Review and approve the remote workspace process first.');
      const offer = offers.get(approval.token);
      if (offer?.kind !== kind || offer.expires <= Date.now()) throw Error('Open a current SSH process review first.');
      offers.delete(approval.token);
      if (kind === 'compile' && approval.file !== offer.config.file) {
        throw Error('Open the exact remote Java source that was reviewed for compilation.');
      }
      if (kind === 'maven' && (approval.file !== offer.config.file || approval.task !== offer.config.task)) {
        throw Error('Open the exact remote Maven POM and task that were reviewed.');
      }
      if (kind === 'gradle' && (approval.file !== offer.config.file || approval.task !== offer.config.task)) {
        throw Error('Open the exact remote Gradle build file and task that were reviewed.');
      }
      if (started || active.size >= 3 || [...active.values()].includes(kind)) throw Error('Close the existing SSH workspace process of this kind first.');
      started = true;
      try {
        await verifyRoot();
        if (kind === 'terminal') return processFor(kind, commandWithArgs(profile.python, terminalProgram, [remoteRoot]), true);
        if (kind === 'debug') return debugProcess(offer.config, offer.info);
        if (kind === 'compile') return compileProcess(offer.config, compileProof(offer.info), approval.signal);
        if (kind === 'maven') return mavenProcess(offer.config, mavenProof(offer.info), approval.signal);
        if (kind === 'gradle') return gradleProcess(offer.config, gradleProof(offer.info), approval.signal);
        const current = await javaRuntime(offer.config);
        if (current.sha256 !== offer.info.sha256) throw Error('The remote JDK or JDT LS changed after review.');
        await verifyRoot();
        const { program, argv } = javaSupervisorInvocation(offer.config, current.sha256, 'ssh');
        return processFor(kind, commandWithArgs(profile.python, program, argv));
      } finally {
        started = false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      offers.clear();
      for (const [child, kind] of active) {
        if (kind === 'compile' || kind === 'maven' || kind === 'gradle') {
          child.stdin.end();
          const timeout = setTimeout(() => child.kill(), kind === 'gradle' ? 7000 : 2200);
          timeout.unref();
          child.once('close', () => clearTimeout(timeout));
        } else child.kill();
      }
    }
  };
}

module.exports = { createPinnedSshPeer, createSshProcesses, terminalProgram };
