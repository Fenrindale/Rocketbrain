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

function collectRuntime(child, valid, message, { input, timeout = 18000 } = {}) {
  return new Promise((resolve, reject) => {
    let count = 0, invalid = false;
    const chunks = [];
    const timer = setTimeout(() => { invalid = true; child.kill(); }, timeout);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.stdout.on('data', data => {
      count += data.length;
      if (count > 8192) { invalid = true; child.kill(); } else chunks.push(data);
    });
    child.stderr.resume();
    child.once('error', () => { invalid = true; });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        if (invalid || code !== 0) throw Error();
        const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!valid(info)) throw Error();
        resolve(info);
      } catch { reject(Error(message)); }
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
      target, close,
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
    return collectRuntime(child, info => info.pid === config.pid && info.port === config.port &&
      Number.isSafeInteger(info.startedAt) && info.startedAt > 0 && /^[a-f0-9]{64}$/.test(info.jdkSha256 || ''),
    'Verify a same-account Windows JVM, its reported workspace directory and exact IPv4 loopback JDWP listener.',
    { input, timeout: 38000 });
  }

  return {
    async inspect(kind, requested) {
      if (!['terminal', 'java', 'debug'].includes(kind)) throw Error('Choose a supported reviewed SSH workspace process.');
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
        if (!rootParts(remoteRoot).drive || !rootParts(javaHome).drive) throw Error('Use a Windows SSH workspace and remote independent JDK 25.');
        if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw Error('Choose an exact remote JVM process ID and debug port.');
        }
        config = { javaHome, pid, port, root: remoteRoot };
      }
      await verifyRoot();
      const info = kind === 'debug' ? await debugProcess(config) : config ? await javaRuntime(config) : undefined;
      if (closed) throw Error('The SSH workspace closed.');
      const now = Date.now();
      for (const [token, offer] of offers) if (offer.expires <= now) offers.delete(token);
      while (offers.size >= 8) offers.delete(offers.keys().next().value);
      const token = randomUUID();
      offers.set(token, { kind, config, info, expires: now + 120000 });
      return { token, kind, host: profile.host, port: profile.port ?? 22, user: profile.user, root: remoteRoot,
        ...(kind === 'java' && { jdk: info.jdk, javaHome: config.javaHome, serverPath: config.serverPath }),
        ...(kind === 'debug' && { javaHome: config.javaHome, pid: info.pid, debugPort: info.port, startedAt: info.startedAt }) };
    },
    async open(kind, approval) {
      if (closed || approval?.allowRemoteProcess !== true) throw Error('Review and approve the remote workspace process first.');
      const offer = offers.get(approval.token);
      if (offer?.kind !== kind || offer.expires <= Date.now()) throw Error('Open a current SSH process review first.');
      offers.delete(approval.token);
      if (started || active.size >= 3 || [...active.values()].includes(kind)) throw Error('Close the existing SSH workspace process of this kind first.');
      started = true;
      try {
        await verifyRoot();
        if (kind === 'terminal') return processFor(kind, commandWithArgs(profile.python, terminalProgram, [remoteRoot]), true);
        if (kind === 'debug') return debugProcess(offer.config, offer.info);
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
      for (const child of active.keys()) child.kill();
    }
  };
}

module.exports = { createPinnedSshPeer, createSshProcesses, terminalProgram };
