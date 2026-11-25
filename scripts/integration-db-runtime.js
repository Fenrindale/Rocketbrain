'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const WORKSPACE = path.resolve(__dirname, '..');
const VERSION = '11.4.8';
const ARCHIVE_NAME = `mariadb-${VERSION}-winx64.zip`;
const SOURCE = `https://archive.mariadb.org/mariadb-${VERSION}/winx64-packages/${ARCHIVE_NAME}`;
const CHECKSUM_SOURCE = `https://archive.mariadb.org/mariadb-${VERSION}/winx64-packages/sha256sums.txt`;
const SHA256 = 'ed86e93157af46317bb49161451c2ec258498a6fa8e68ca821ef1d780d855e6b';
const compatibilityDigests = new Map([
  ['10.11.20', 'aad30008fd9ce30c12366edc6414920d8596e69d7db94de50c63642a6e2982c3'],
  ['11.4.14', '9d9b410eb7b65f6616f29d933d76ee90cf7af4ba179a2d437e0f09f5bf6650df'],
  ['12.3.4', '178020ae8ff7d0caf77b5a3ad7e33e574e13001352d31b02503f97224e4b1f77']
]);

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function request(url, redirects = 0) {
  if (redirects > 5 || !url.startsWith('https://')) return Promise.reject(new Error('Unsafe runtime download redirect.'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Rocketbrain-Integration-Fixture/0.1' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        request(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      } else if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`Runtime download returned HTTP ${response.statusCode}.`));
      } else resolve(response);
    });
    req.setTimeout(120000, () => req.destroy(new Error('Runtime download timed out.')));
    req.on('error', reject);
  });
}

function runProcess(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: WORKSPACE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    const capture = data => { output = (output + data.toString()).slice(-16000); };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture helper timed out.')); }, 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`Fixture helper failed (${code}): ${output}`));
    });
  });
}

const pending = new Map();
async function ensureMariaDbRuntime(version = VERSION) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This pinned portable fixture supports Windows x64 only.');
  if (pending.has(version)) return pending.get(version);
  const expectedSha256 = version === VERSION ? SHA256 : compatibilityDigests.get(version);
  if (!expectedSha256) throw new Error('Select a pinned MariaDB fixture release.');
  const release = 'mariadb-' + version;
  const archiveName = release + '-winx64.zip';
  const source = version === VERSION ? SOURCE : 'https://mirror.mariadb.org/' + release + '/winx64-packages/' + archiveName;
  const checksumSource = version === VERSION ? CHECKSUM_SOURCE : 'https://downloads.mariadb.org/rest-api/mariadb/' + version + '/';
  const cache = path.join(WORKSPACE, 'research', 'implementation', 'runtimes', release);
  const provision = (async () => {
    await fsp.mkdir(cache, { recursive: true });
    const archive = path.join(cache, archiveName);
    if (!fs.existsSync(archive)) {
      const partial = path.join(cache, `${archiveName}.${crypto.randomUUID()}.partial`);
      try {
        await pipeline(await request(source), fs.createWriteStream(partial, { flags: 'wx' }));
        if (await sha256(partial) !== expectedSha256) throw new Error('Official MariaDB archive SHA-256 did not match the pinned value.');
        await fsp.rename(partial, archive);
      } finally { await fsp.rm(partial, { force: true }); }
    }
    const actualSha256 = await sha256(archive);
    if (actualSha256 !== expectedSha256) throw new Error('Cached MariaDB archive SHA-256 did not match.');
    const extracted = path.join(cache, 'extracted');
    const home = path.join(extracted, release + '-winx64');
    const server = path.join(home, 'bin', 'mariadbd.exe');
    if (!fs.existsSync(server)) {
      // The checksum-verified official ZIP is extracted only into this cache.
      const quote = value => `'${value.replace(/'/g, "''")}'`;
      await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)} -Force`]);
    }
    const initializer = path.join(home, 'bin', 'mariadb-install-db.exe');
    if (!fs.existsSync(server) || !fs.existsSync(initializer)) throw new Error('Portable MariaDB server files are missing.');
    const metadata = { asOf: version === VERSION ? '2026-11-12' : '2026-11-26', distribution: 'MariaDB Community Server', version, source, checksumSource, expectedSha256, actualSha256, bytes: (await fsp.stat(archive)).size, home, server, initializer, windowsServiceInstalled: false, globalInstall: false, verification: 'HTTPS publisher archive and pinned SHA-256; detached OpenPGP signature not verified.' };
    await fsp.writeFile(path.join(cache, 'source.json'), JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
  })().catch(error => { pending.delete(version); throw error; });
  pending.set(version, provision);
  return provision;
}

module.exports = { ensureMariaDbRuntime, runProcess, WORKSPACE, VERSION, SOURCE, SHA256 };
