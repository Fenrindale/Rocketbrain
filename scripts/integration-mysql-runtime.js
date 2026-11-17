'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { runProcess, WORKSPACE } = require('./integration-db-runtime');
const VERSION = '8.4.13';
const NAME = 'mysql-' + VERSION + '-winx64.zip';
const SOURCE = 'https://cdn.mysql.com/Downloads/MySQL-8.4/' + NAME;
const CHECKSUM_SOURCE = 'https://dev.mysql.com/downloads/mysql/8.4.html?os=3';
const MD5 = '7b94489d5524dea9b27097068bea25a8';
const SHA256 = 'e9cd98b1d23f122987b1afca26ad942efec5891481103d48ae3cde237fa3ea54';
const CACHE = path.join(WORKSPACE, 'research', 'implementation', 'runtimes', 'mysql-' + VERSION);
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
let pending;
async function ensureMysqlRuntime() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This pinned fixture supports Windows x64 only.');
  if (pending) return pending;
  pending = (async () => {
    await fsp.mkdir(CACHE, { recursive: true });
    const archive = path.join(CACHE, NAME);
    if (!fs.existsSync(archive)) {
      const partial = archive + '.' + crypto.randomUUID() + '.partial';
      try {
        await pipeline(await download(SOURCE), fs.createWriteStream(partial, { flags: 'wx' }));
        if (await digest(partial, 'sha256') !== SHA256 || await digest(partial, 'md5') !== MD5) throw new Error('Official MySQL archive checksum mismatch.');
        await fsp.rename(partial, archive);
      } catch (error) { await fsp.unlink(partial).catch(() => {}); throw error; }
    }
    if (await digest(archive, 'sha256') !== SHA256 || await digest(archive, 'md5') !== MD5) throw new Error('Cached MySQL archive checksum mismatch.');
    const extracted = path.join(CACHE, 'extracted'), home = path.join(extracted, 'mysql-' + VERSION + '-winx64');
    const server = path.join(home, 'bin', 'mysqld.exe');
    if (!fs.existsSync(server)) {
      const quote = value => "'" + value.replaceAll("'", "''") + "'";
      await fsp.mkdir(extracted, { recursive: true });
      await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(' + quote(archive) + ', ' + quote(extracted) + ')']);
    }
    if (!fs.existsSync(server)) throw new Error('Portable MySQL server is missing.');
    const result = { asOf: '2026-11-12', distribution: 'Oracle MySQL Community Server', version: VERSION,
      source: SOURCE, checksumSource: CHECKSUM_SOURCE, publishedMd5: MD5, actualMd5: await digest(archive, 'md5'),
      pinnedSha256: SHA256, actualSha256: await digest(archive, 'sha256'), bytes: (await fsp.stat(archive)).size,
      home, server, windowsServiceInstalled: false, globalInstall: false, bundledInVsix: false,
      verification: 'Official HTTPS ZIP; publisher page MD5 matched, SHA-256 computed from that download and pinned. OpenPGP signature not verified.',
      license: 'GPL-2.0 MySQL server is an isolated verification tool, not linked into or redistributed inside Rocketbrain.' };
    await fsp.writeFile(path.join(CACHE, 'source.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  })().catch(error => { pending = undefined; throw error; });
  return pending;
}
module.exports = { ensureMysqlRuntime, WORKSPACE, VERSION, SOURCE, SHA256 };
