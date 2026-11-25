'use strict';

const fs = require('node:fs/promises'), { constants } = require('node:fs'), path = require('node:path');
const os = require('node:os'), { spawn } = require('node:child_process');
const { createPrivateKey, randomBytes } = require('node:crypto');
const { javaExecutable } = require('./jdbc');
const worker = require('./pkcs12-worker-source.json');

const limit = 2 * 1024 * 1024;
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_CLIENT_IDENTITY' });

async function readMaterial(file) {
  let handle;
  try {
    const real = await fs.realpath(file);
    if (!path.isAbsolute(real) || /^\\\\/.test(real)) throw Error('local file required');
    const before = await fs.stat(real);
    if (!before.isFile() || !before.size || before.size > limit) throw Error('invalid file size');
    handle = await fs.open(real, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) throw Error('file changed');
    const result = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < result.length) {
      const { bytesRead } = await handle.read(result, length, result.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== opened.size) {
      result.fill(0);
      throw Error('file changed');
    }
    return result.subarray(0, length);
  } catch { throw fail('Choose a readable ordinary local certificate or key file of at most 2 MiB.'); }
  finally { await handle?.close(); }
}

async function readClientPem(file) {
  const bytes = await readMaterial(file);
  try { return bytes.toString('utf8'); }
  finally { bytes.fill(0); }
}

function clientPassphrase(value, required) {
  if (value === undefined || value === '') {
    if (required) throw fail('Enter the client identity passphrase for this connection attempt.');
    return undefined;
  }
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16384 || value.includes('\0')) throw fail('Use a client passphrase under 16 KiB.');
  if (!required) throw fail('Choose an encrypted client identity to use a passphrase.');
  return value;
}

function extract(java, directory, bytes, passphrase, signal) {
  if (signal?.aborted) throw fail('Reading the client identity was canceled.');
  const secret = Buffer.from(passphrase, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(secret.length); header.writeUInt32BE(bytes.length, 4);
  const allowed = new Set(['SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  const child = spawn(java.executable, ['-Xmx96m','-XX:ActiveProcessorCount=2','-Duser.home=.','-Djava.io.tmpdir=.',
    '--class-path','.','--source','25','ClientIdentity.java'], {
    cwd: directory, windowsHide: true, shell: false, env, stdio: ['pipe','pipe','ignore']
  });
  return new Promise((resolve,reject) => {
    const chunks = [];
    let size = 0, problem;
    const stop = message => { problem ||= fail(message); child.kill('SIGKILL'); };
    const cancel = () => stop('Reading the client identity was canceled.');
    const timer = setTimeout(() => stop('Reading the PKCS#12 client identity timed out.'), 12000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { chunk.fill(0); stop('The PKCS#12 identity exceeds the supported certificate-chain size.'); }
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { problem ||= fail('The independent Java client-identity reader could not start.'); });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      secret.fill(0);
      const output = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      if (problem || code !== 0) {
        output.fill(0);
        reject(problem || fail('Open a PKCS#12 file containing one private key and its certificate chain. Check the passphrase.'));
      } else resolve(output);
    });
    child.stdin.write(header);
    child.stdin.write(secret);
    child.stdin.end(bytes);
  });
}

function identityFromOutput(output) {
  let offset = 0;
  const take = () => {
    if (offset + 4 > output.length) throw Error('short output');
    const size = output.readUInt32BE(offset);
    offset += 4;
    if (!size || size > 131072 || offset + size > output.length) throw Error('invalid certificate or key');
    return output.subarray(offset, offset += size);
  };
  try {
    const algorithm = take().toString('ascii');
    if (!['RSA','EC','Ed25519','Ed448'].includes(algorithm)) throw Error('unsupported private-key algorithm');
    const key = createPrivateKey({key:take(),type:'pkcs8',format:'der'});
    let cert = '';
    for (let count = 0; offset < output.length; count++) {
      if (count >= 8) throw Error('chain size');
      const der = take();
      cert += '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
    }
    if (!cert) throw Error('empty client chain');
    // mysql2 accepts encrypted PEM. Keep only a per-attempt key wrapper in its connection options.
    const passphrase = randomBytes(32).toString('base64url');
    return { cert, key:key.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase}), passphrase };
  } catch { throw fail('The PKCS#12 file returned an invalid or unsupported client key and certificate chain.'); }
  finally { output.fill(0); }
}

async function readPkcs12Identity(file, passphrase, javaHome, signal) {
  const java = await javaExecutable(javaHome,'PKCS#12 client identities');
  const bytes = await readMaterial(file);
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rocketbrain-pkcs12-'));
    await fs.writeFile(path.join(directory,'ClientIdentity.java'),worker,{flag:'wx',mode:0o600});
    return identityFromOutput(await extract(java,directory,bytes,passphrase,signal));
  } finally {
    bytes.fill(0);
    if (directory) {
      await fs.unlink(path.join(directory,'ClientIdentity.java')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(directory);
    }
  }
}

module.exports = { readClientPem, readPkcs12Identity, clientPassphrase };
