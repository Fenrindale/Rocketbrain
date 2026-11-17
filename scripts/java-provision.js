'use strict';
// Explicit local installer. Run manually; extension activation never downloads runtimes.
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const JDT_VERSION = '1.63.0';
const JDT_FILE = 'jdt-language-server-1.63.0-202610191322.tar.gz';
const JDT_SHA256 = 'b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4';

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--target', '--java-home'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/java-provision.js --target <absolute runtime directory> [--java-home <existing JDK 25+>]');
    result[args[i].slice(2)] = args[++i];
  }
  if (!result.target || !path.isAbsolute(result.target)) throw new Error('--target must be an explicit absolute directory.');
  if (result['java-home'] && !path.isAbsolute(result['java-home'])) throw new Error('--java-home must be absolute.');
  return result;
}

async function sha256(file) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function download(url, file, checksum) {
  if (fs.existsSync(file) && await sha256(file) === checksum) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const partial = file + '.partial'; let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) { bytes += chunk.length; done(bytes > 350 * 1024 * 1024 ? new Error('Runtime archive exceeds 350 MiB.') : undefined, chunk); } }), fs.createWriteStream(partial, { flags: 'wx' }));
    if (await sha256(partial) !== checksum) throw new Error(`SHA-256 mismatch: ${path.basename(file)}`);
    await fsp.rename(partial, file);
  } finally { await fsp.rm(partial, { force: true }); }
}

function extract(archive, destination) {
  const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`Cannot list archive: ${listing.stderr || listing.error}`);
  for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) throw new Error('Unsafe archive entry.');
  }
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('tar', ['-xf', archive, '-C', destination], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Cannot extract archive: ${result.stderr || result.error}`);
}

async function provision(options) {
  const target = path.resolve(options.target); await fsp.mkdir(target, { recursive: true });
  const progress = options.onProgress || (message => console.log(message));
  const sources = [];
  let javaHome = options['java-home'];
  if (!javaHome) {
    const platform = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
    const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
    if (!platform || !arch) throw new Error('Automatic JDK provisioning supports Windows/macOS/Linux x64 or arm64. Supply --java-home on other systems.');
    const metadataUrl = `https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=${arch}&image_type=jdk&os=${platform}&vendor=eclipse`;
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Adoptium metadata failed (${response.status}).`);
    const asset = (await response.json())[0];
    const pkg = asset?.binary?.package;
    if (!pkg || !/^[a-f0-9]{64}$/i.test(pkg.checksum) || new URL(pkg.link).hostname !== 'github.com' || !new URL(pkg.link).pathname.startsWith('/adoptium/temurin25-binaries/')) throw new Error('Unexpected Adoptium release metadata.');
    const archive = path.join(target, path.basename(pkg.name));
    progress(`Downloading and verifying Temurin ${asset.version.semver} (${platform}/${arch}).`);
    await download(pkg.link, archive, pkg.checksum.toLowerCase());
    const jdkRoot = path.join(target, 'temurin-' + asset.version.semver.replace(/[^a-zA-Z0-9._-]/g, '_')); extract(archive, jdkRoot);
    const roots = (await fsp.readdir(jdkRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(jdkRoot, entry.name));
    javaHome = roots.map(root => process.platform === 'darwin' ? path.join(root, 'Contents', 'Home') : root).find(root => fs.existsSync(path.join(root, 'release')));
    if (!javaHome) throw new Error('Temurin archive does not contain a JDK release file.');
    sources.push({ name: 'Temurin JDK', version: asset.version.semver, metadataUrl, url: pkg.link, sha256: pkg.checksum, license: 'GPL-2.0 with Classpath Exception; see downloaded legal directory.' });
  }
  const jdtUrl = `https://download.eclipse.org/jdtls/milestones/${JDT_VERSION}/${JDT_FILE}`;
  const archive = path.join(target, JDT_FILE);
  progress(`Downloading and verifying Eclipse JDT LS ${JDT_VERSION}.`);
  await download(jdtUrl, archive, JDT_SHA256);
  const serverPath = path.join(target, `jdtls-${JDT_VERSION}`); extract(archive, serverPath);
  const { resolveLaunch } = require('../src/java/runtime');
  const launch = resolveLaunch({ javaHome, serverPath, storagePath: path.join(target, 'validation-storage') });
  const javaVersion = spawnSync(launch.command, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (javaVersion.status !== 0) throw new Error(`JDK execution failed: ${javaVersion.stderr || javaVersion.error}`);
  sources.push({ name: 'Eclipse JDT LS', version: JDT_VERSION, url: jdtUrl, checksumUrl: jdtUrl + '.sha256', sha256: JDT_SHA256, license: 'EPL-2.0 and included third-party licenses.' });
  const debuggerRuntime = await require('./java-debug-provision').provisionDebugger(path.join(target, 'java-debug'), progress, { javaHome, serverPath });
  sources.push(debuggerRuntime.source);
  const settings = { 'rocketbrain.java.enabled': true, 'rocketbrain.java.serverPath': serverPath, 'rocketbrain.java.javaHome': javaHome, 'rocketbrain.java.debugBundlePath': debuggerRuntime.debugBundlePath, 'rocketbrain.spring.enabled': true };
  const result = { createdAt: new Date().toISOString(), javaHome, serverPath, debugBundlePath: debuggerRuntime.debugBundlePath, settings, javaVersion: javaVersion.stdout.trim(), sources, notice: 'Local installation only. Existing VS Code settings and global JAVA_HOME/PATH are unchanged. Copy settings into a trusted workspace. Final redistribution audit is separate.' };
  await fsp.writeFile(path.join(target, 'rocketbrain-java-runtime.json'), JSON.stringify(result, null, 2) + '\n');
  await fsp.writeFile(path.join(target, 'rocketbrain-java-settings.json'), JSON.stringify(settings, null, 2) + '\n');
  progress(`Java engine is ready. Settings: ${path.join(target, 'rocketbrain-java-settings.json')}`); return result;
}

if (require.main === module) provision(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, provision, sha256 };
