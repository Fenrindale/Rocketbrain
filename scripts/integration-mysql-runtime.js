'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { runProcess, WORKSPACE } = require('./integration-db-runtime');
const VERSION = '8.4.13';
const MYSQL9_VERSION = '9.7.4.1';
const PINNED = new Map([
  [VERSION, { family: '8.4', asOf: '2026-11-12', md5: '7b94489d5524dea9b27097068bea25a8',
    sha256: 'e9cd98b1d23f122987b1afca26ad942efec5891481103d48ae3cde237fa3ea54' }],
  [MYSQL9_VERSION, { family: '9.7', asOf: '2026-11-26', md5: 'a00c88c6c714867dcfaa2733d1ef2c5d',
    sha256: '1989c9a63674c01b0851523f6eaf21f1f4e233e678858423b5b9b6a24420b546' }]
]);
const archiveName = version => 'mysql-' + version + '-winx64.zip';
const sourceOf = (version, family) => 'https://cdn.mysql.com/Downloads/MySQL-' + family + '/' + archiveName(version);
const SOURCE = sourceOf(VERSION, PINNED.get(VERSION).family);
const SHA256 = PINNED.get(VERSION).sha256;
async function digest(file, algorithm) {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function download(url, redirects = 0) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['cdn.mysql.com', 'dev.mysql.com', 'downloads.mysql.com'].includes(parsed.hostname) || redirects > 5) throw new Error('Refusing an unapproved runtime source.');
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume(); download(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      } else if (response.statusCode === 200) resolve(response);
      else { response.resume(); reject(new Error('MySQL runtime returned HTTP ' + response.statusCode)); }
    });
    request.setTimeout(120000, () => request.destroy(new Error('MySQL download timed out.')));
    request.on('error', reject);
  });
}
const pending = new Map();
async function ensureMysqlRuntime(version = VERSION) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This pinned fixture supports Windows x64 only.');
  const pinned = PINNED.get(version);
  if (!pinned) throw new Error('Choose a pinned MySQL test runtime.');
  if (pending.has(version)) return pending.get(version);
  const task = (async () => {
    const { asOf, family, md5, sha256 } = pinned;
    const source = sourceOf(version, family);
    const cache = path.join(WORKSPACE, 'research', 'implementation', 'runtimes', 'mysql-' + version);
    await fsp.mkdir(cache, { recursive: true });
    const archive = path.join(cache, archiveName(version));
    if (!fs.existsSync(archive)) {
      const partial = archive + '.' + crypto.randomUUID() + '.partial';
      try {
        await pipeline(await download(source), fs.createWriteStream(partial, { flags: 'wx' }));
        if (await digest(partial, 'sha256') !== sha256 || await digest(partial, 'md5') !== md5) throw new Error('Official MySQL archive checksum mismatch.');
        await fsp.rename(partial, archive);
      } catch (error) { await fsp.unlink(partial).catch(() => {}); throw error; }
    }
    const actualSha256 = await digest(archive, 'sha256'), actualMd5 = await digest(archive, 'md5');
    if (actualSha256 !== sha256 || actualMd5 !== md5) throw new Error('Cached MySQL archive checksum mismatch.');
    const extracted = path.join(cache, 'extracted'), home = path.join(extracted, 'mysql-' + version + '-winx64');
    const server = path.join(home, 'bin', 'mysqld.exe');
    if (!fs.existsSync(server)) {
      const quote = value => "'" + value.replaceAll("'", "''") + "'";
      await fsp.mkdir(extracted, { recursive: true });
      await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(' + quote(archive) + ', ' + quote(extracted) + ')']);
    }
    if (!fs.existsSync(server)) throw new Error('Portable MySQL server is missing.');
    const result = { asOf, distribution: 'Oracle MySQL Community Server', version,
      source, checksumSource: 'https://dev.mysql.com/downloads/mysql/' + family + '.html?os=3', publishedMd5: md5, actualMd5,
      pinnedSha256: sha256, actualSha256, bytes: (await fsp.stat(archive)).size,
      home, server, windowsServiceInstalled: false, globalInstall: false, bundledInVsix: false,
      verification: 'Official HTTPS ZIP; publisher page MD5 matched, SHA-256 computed from that download and pinned. OpenPGP signature not verified.',
      license: 'GPL-2.0 MySQL server is an isolated verification tool, not linked into or redistributed inside Rocketbrain.' };
    await fsp.writeFile(path.join(cache, 'source.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  })().catch(error => { pending.delete(version); throw error; });
  pending.set(version, task);
  return task;
}
module.exports = { ensureMysqlRuntime, WORKSPACE, VERSION, MYSQL9_VERSION, SOURCE, SHA256 };
