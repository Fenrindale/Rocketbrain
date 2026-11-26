'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { freePort } = require('../java-debug-dap');

async function startLinuxOpenSshFixture(executable, cleanup) {
  assert.equal(process.platform, 'linux');
  assert.ok(process.getuid() !== 0, 'Use a disposable same-account non-root runner.');
  assert.ok(path.isAbsolute(executable));
  const daemon = await fs.realpath(executable);
  assert.equal(path.basename(daemon), 'sshd');
  const user = os.userInfo().username;
  assert.match(user, /^[A-Za-z_][A-Za-z0-9_-]*$/u);
  const boundary = await fs.realpath(os.homedir()), owned = await fs.mkdtemp(path.join(boundary, 'rb-linux-sshd-'));
  const root = path.join(owned, 'workspace'), workerTemp = path.join(owned, 'worker');
  let worker, stopped;
  cleanup(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill();
    if (stopped) await stopped;
    const resolved = await fs.realpath(owned);
    assert.deepEqual([resolved, path.dirname(resolved)], [owned, boundary]);
    assert.match(path.basename(resolved), /^rb-linux-sshd-/u);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  });
  await fs.mkdir(root);
  await fs.mkdir(workerTemp);
  for (const name of ['host', 'client', 'wrong']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(owned, name)], { stdio: 'ignore', timeout: 10000 });
  }
  const port = await freePort(), config = path.join(owned, 'sshd_config');
  assert.ok(!/[\s"=]/u.test(workerTemp));
  const quote = file => '"' + file.replaceAll('"', '\\"') + '"';
  await fs.writeFile(config, [
    'Port ' + port, 'ListenAddress 127.0.0.1', 'AddressFamily inet',
    'HostKey ' + quote(path.join(owned, 'host')), 'PidFile ' + quote(path.join(owned, 'sshd.pid')),
    'AuthorizedKeysFile ' + quote(path.join(owned, 'client.pub')), 'AllowUsers ' + user,
    'AuthenticationMethods publickey', 'PubkeyAuthentication yes', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes yes', 'PermitRootLogin no', 'PermitTTY no',
    'AllowTcpForwarding no', 'AllowAgentForwarding no', 'X11Forwarding no', 'PermitUserEnvironment no',
    'SetEnv TMPDIR=' + workerTemp, 'LogLevel ERROR', ''
  ].join('\n'), { mode: 0o600 });
  worker = spawn(daemon, ['-D', '-e', '-f', config], { cwd: owned, stdio: ['ignore', 'ignore', 'pipe'] });
  stopped = once(worker, 'close');
  let error = '';
  worker.stderr.setEncoding('utf8').on('data', part => { error = (error + part).slice(-2000); });
  const connect = () => new Promise(resolve => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
  let alive = false;
  for (let index = 0; index < 70 && worker.exitCode === null; index++) {
    if (await connect()) { alive = true; break; }
    await delay(100);
  }
  assert.ok(alive, 'The owned stock OpenSSH daemon failed to bind. ' + error);
  const knownHostsPath = path.join(owned, 'known_hosts'), wrongPin = path.join(owned, 'wrong_hosts');
  for (const [leaf, target] of [['host', knownHostsPath], ['wrong', wrongPin]]) {
    const key = (await fs.readFile(path.join(owned, leaf + '.pub'), 'utf8')).trim().split(/\s+/u).slice(0, 2).join(' ');
    await fs.writeFile(target, '[127.0.0.1]:' + port + ' ' + key + '\n');
  }
  const profile = { id: 'rb-linux-sshd', root, host: '127.0.0.1', port, user, python: 'python3',
    privateKeyPath: path.join(owned, 'client'), knownHostsPath };
  return { profile, wrongPin, workerTemp, stockOpenSshDaemon: true };
}

module.exports = { startLinuxOpenSshFixture };
