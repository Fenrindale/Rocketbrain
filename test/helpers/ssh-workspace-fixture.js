'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { Server, utils } = require('ssh2');
const { remoteCommand, source } = require('../../src/remote/ssh-files-worker');

async function startSshWorkspace(python, parent = os.tmpdir()) {
  assert.ok(path.isAbsolute(python) && (await fs.stat(python)).isFile(), 'Configure an independent Python runtime.');
  const boundary = await fs.realpath(parent);
  const folder = await fs.mkdtemp(path.join(boundary, 'rb-ssh-workspace-'));
  const serverRoot = path.join(folder, 'remote');
  const clients = new Set();
  const workers = new Set();
  let server;
  let listening = false;
  async function close() {
    for (const process of workers) process.kill();
    for (const client of clients) client.end();
    if (listening) await new Promise(resolve => server.close(resolve));
    const owned = await fs.realpath(folder);
    assert.equal(path.relative(boundary, path.dirname(owned)), '');
    assert.ok(path.basename(owned).startsWith('rb-ssh-workspace-'));
    await fs.rm(owned, { recursive: true, maxRetries: 10, retryDelay: 200 });
  }
  try {
    await fs.mkdir(serverRoot);
    const file = path.join(serverRoot,'RemoteController.java');
    const original = 'final class RemoteController { int value() { return 42; } }\n';
    await fs.writeFile(file, original, { flag: 'wx' });
    const generator = process.platform === 'win32'
      ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen';
    for (const name of ['host','client','wrong']) {
      execFileSync(generator, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(folder, name)],
        { timeout: 12000, stdio: 'ignore', windowsHide: true });
    }
    const clientKey = utils.parseKey(await fs.readFile(path.join(folder, 'client.pub')));
    assert.ok(!(clientKey instanceof Error));
    let executions = 0;
    let observations = 0;
    server = new Server({ hostKeys: [await fs.readFile(path.join(folder,'host'))] }, client => {
      clients.add(client);
      client.on('error', () => {});
      client.once('close', () => clients.delete(client));
      client.on('authentication', event => {
        if (event.method === 'publickey' && event.username === 'rb_workspace' &&
            event.key.data.equals(clientKey.getPublicSSH()) &&
            (!event.signature || clientKey.verify(event.blob, event.signature, event.hashAlgo) === true)) event.accept();
        else event.reject();
      });
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('exec', (open, reject, request) => {
          if (request.command !== remoteCommand('python')) { reject(); return; }
          const stream = open();
          if (!stream) return;
          executions++;
          const worker = spawn(python, ['-I','-u','-c',source], { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
          workers.add(worker);
          worker.stdin.on('error', () => {});
          let header = '';
          stream.on('data', data => {
            if (!header.includes('\n') && header.length < 4096) header += data.toString('utf8').slice(0, 4096 - header.length);
          });
          stream.once('close', () => { if (workers.has(worker)) worker.kill(); });
          stream.pipe(worker.stdin);
          worker.stdout.pipe(stream, { end: false });
          worker.stderr.pipe(stream.stderr, { end: false });
          worker.once('close', code => {
            if (code === 0 && header.includes('\n')) {
              try { if (JSON.parse(header).operation === 'observe') observations++; } catch { /* A large frame was truncated. */ }
            }
            workers.delete(worker); stream.exit(code ?? 1); stream.end();
          });
        });
      }));
    });
    await new Promise((resolve, reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    listening = true;
    const { port } = server.address();
    const knownHostsPath = path.join(folder, 'known_hosts');
    const wrongHosts = path.join(folder, 'wrong_hosts');
    const record = async key => '[127.0.0.1]:' + port + ' ' +
      (await fs.readFile(path.join(folder,key + '.pub'),'utf8')).trim().split(/\s+/).slice(0, 2).join(' ') + '\n';
    await fs.writeFile(knownHostsPath, await record('host'));
    await fs.writeFile(wrongHosts, await record('wrong'));
    return { close, folder, file, original, wrongHosts, executions: () => executions, observations: () => observations,
      profile: { id: 'rb-ssh', host: '127.0.0.1', port, user: 'rb_workspace', root: serverRoot,
        python: 'python', privateKeyPath: path.join(folder,'client'), knownHostsPath } };
  } catch (error) { await close(); throw error; }
}

module.exports = { startSshWorkspace };
