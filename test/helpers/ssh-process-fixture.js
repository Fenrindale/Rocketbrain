'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { source } = require('../../src/remote/ssh-files-worker');
const { terminalProgram } = require('../../src/remote/ssh-processes');
const { javaSupervisorInvocation } = require('../../src/devcontainer/java-process');
const { debugSupervisorInvocation } = require('../../src/remote/ssh-java-debug-runtime');
const { compileProgram } = require('../../src/remote/ssh-java-compile-runtime');
const { mavenProgram } = require('../../src/remote/ssh-maven-runtime');
const { gradleProgram } = require('../../src/remote/ssh-gradle-runtime');
const { fixtureStep } = require('../devcontainer-port-fixture');

async function startSshProcessFixture({ python, pythonPackage, ownWorkerTemp = false }, registerCleanup) {
  const boundary = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(boundary, 'rb-ssh-exec-'));
  const root = path.join(owned, 'workspace');
  const generator = process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen';
  await fs.mkdir(path.join(root, 'src', 'fixture'), { recursive: true });
  const sourceText = 'package fixture; public class Example { Target field = new Target(); }\n';
  const example = path.join(root, 'src', 'fixture', 'Example.java');
  await fs.writeFile(example, sourceText);
  await fs.writeFile(path.join(root, 'src', 'fixture', 'Target.java'), 'package fixture; public class Target {}\n');
  for (const name of ['host', 'client', 'wrong']) {
    execFileSync(generator, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(owned, name)],
      { timeout: 12000, stdio: 'ignore', windowsHide: true });
  }
  const input = path.join(owned, 'input.json'), host = path.join(owned, 'host');
  const workerTemp = ownWorkerTemp ? path.join(owned, 'temporary') : undefined;
  if (workerTemp) await fs.mkdir(workerTemp);
  await fs.writeFile(input, JSON.stringify({ host, client: path.join(owned, 'client.pub'), programs: [source, terminalProgram,
    javaSupervisorInvocation({}, undefined, 'ssh').program, debugSupervisorInvocation({}).program, compileProgram, mavenProgram, gradleProgram] }));
  const worker = spawn(python, [path.join(__dirname, '..', 'fixtures', 'ssh-process-server.txt'), input],
    { cwd: owned, env: { ...process.env, PYTHONPATH: pythonPackage,
      ...(workerTemp && { TMPDIR: workerTemp, TEMP: workerTemp, TMP: workerTemp }) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = once(worker, 'close');
  registerCleanup(async () => {
    if (worker.exitCode === null) worker.kill();
    await stopped;
    const actual = await fs.realpath(owned);
    assert.equal(actual, owned);
    assert.equal(path.dirname(actual), boundary);
    assert.match(path.basename(actual), /^rb-ssh-exec-/u);
    await fs.rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    worker.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) {
        try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); }
      }
    });
    worker.once('error', reject);
    worker.once('close', () => reject(Error('Owned AsyncSSH startup failed. ' + stderr)));
  });
  const information = await fixtureStep('starting the owned AsyncSSH server', () => ready);
  assert.equal(information.asyncssh, '2.24.1');
  const knownHostsPath = path.join(owned, 'known_hosts'), wrongPin = path.join(owned, 'wrong_hosts');
  for (const [name, target] of [['host', knownHostsPath], ['wrong', wrongPin]]) {
    const key = (await fs.readFile(path.join(owned, name + '.pub'), 'utf8')).trim().split(/\s+/u).slice(0, 2).join(' ');
    await fs.writeFile(target, '[127.0.0.1]:' + information.port + ' ' + key + '\n');
  }
  const profile = { id: 'rb-ssh-process', host: '127.0.0.1', port: information.port, user: 'rb_process',
    root, python: 'python', privateKeyPath: path.join(owned, 'client'), knownHostsPath };
  return { profile, wrongPin, example, sourceText, asyncssh: information.asyncssh, workerTemp };
}

module.exports = { startSshProcessFixture };
