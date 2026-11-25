'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaging step failed with exit code ${result.status}.`);
}

function resolvePackageManifest(name, fromManifest) {
  const resolver = createRequire(fromManifest);
  try {
    return resolver.resolve(`${name}/package.json`);
  } catch {
    let folder = path.dirname(resolver.resolve(name));
    for (;;) {
      const candidate = path.join(folder, 'package.json');
      if (fs.existsSync(candidate)) {
        const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (value.name === name) return candidate;
      }
      const parent = path.dirname(folder);
      if (parent === folder) throw new Error(`Could not locate the manifest for ${name}.`);
      folder = parent;
    }
  }
}

function writeRuntimeNotices() {
  const seen = new Set();
  const packages = [];
  function visit(name, fromManifest, optional = false) {
    let resolved;
    try { resolved = fs.realpathSync(resolvePackageManifest(name, fromManifest)); }
    catch (error) { if (optional) return; throw error; }
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const info = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    let folder = path.dirname(resolved);
    let files = fs.readdirSync(folder).filter((file) => /^(licen[sc]e|copying|notice|authors)(?:$|[.\-])/i.test(file)
      && fs.statSync(path.join(folder, file)).isFile()).sort();
    // saxes 6.0.0's npm archive omits the license included at its release tag.
    // Use the complete pinned upstream notice; never infer text from an SPDX id.
    if(info.name==='saxes'&&info.version==='6.0.0'&&!files.some(file=>/^(licen[sc]e|copying)/i.test(file))){
      folder=path.join(root,'third-party/licenses');files=['saxes-6.0.0-LICENSE.txt'];
      const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(folder,files[0]))).digest('hex');
      if(actual!=='0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e')throw new Error('The pinned saxes upstream license changed.');
    }
    if (!files.some((file) => /^(licen[sc]e|copying)/i.test(file))&&!(info.name==='saxes'&&info.version==='6.0.0'&&files.includes('saxes-6.0.0-LICENSE.txt'))) {
      throw new Error(`No license text was found for bundled dependency ${info.name}@${info.version}.`);
    }
    packages.push({ info, folder, files });
    for (const dependency of Object.keys(info.dependencies || {}).sort()) visit(dependency, resolved);
    for (const dependency of Object.keys(info.optionalDependencies || {}).sort()) visit(dependency, resolved, true);
  }
  for (const dependency of Object.keys(manifest.dependencies || {}).sort()) visit(dependency, manifestPath);
  packages.sort((a, b) => a.info.name.localeCompare(b.info.name) || a.info.version.localeCompare(b.info.version));
  const blocks = [
    'Rocketbrain runtime dependency notices',
    'Generated from the exact installed runtime dependency closure. Build tools are not bundled.',
    'SQLite, included through sql.js, is public domain. sql.js and its notices follow below.',
    '',
  ];
  for (const { info, folder, files } of packages) {
    blocks.push('='.repeat(78), `${info.name}@${info.version}`, `Declared license: ${typeof info.license === 'string' ? info.license : JSON.stringify(info.license)}`, '');
    for (const file of files) blocks.push(`--- ${file} ---`, fs.readFileSync(path.join(folder, file), 'utf8').trimEnd(), '');
  }
  fs.writeFileSync(path.join(root, 'THIRD-PARTY-LICENSES.txt'), `${blocks.join('\n')}\n`, 'utf8');
  console.log(`Collected license texts for ${packages.length} runtime dependency packages.`);
}

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function verifyArchive(archive, vsceManifest) {
  const yauzl = createRequire(vsceManifest)('yauzl');
  const requiredPayloads = [
    'package.json', 'README.md', 'NOTICE.txt', 'THIRD-PARTY-LICENSES.txt',
    'dist/java-quality-gate.js',
    'dist/extension.js', 'dist/worker.js', 'dist/sql-wasm.wasm', 'dist/results.js', 'dist/results.css',
    'themes/rocketbrain-dark.json', 'media/rocketbrain.svg', 'media/duckdb.tmLanguage.json', 'media/jdbc.tmLanguage.json',
  ];
  const allowed = new Set(['[content_types].xml', 'extension.vsixmanifest', ...requiredPayloads.map((file) => `extension/${file.toLowerCase()}`)]);
  const seen = new Set();
  await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) { reject(error); return; }
      let failed = false;
      function fail(reason) {
        if (failed) return;
        failed = true;
        zip.close();
        reject(reason);
      }
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        const normalized = entry.fileName.toLowerCase();
        if (!allowed.has(normalized) || seen.has(normalized)) {
          fail(new Error(`Unexpected or duplicate VSIX file: ${entry.fileName}`));
          return;
        }
        seen.add(normalized);
        if (entry.uncompressedSize > 16 * 1024 * 1024) {
          fail(new Error(`Unexpectedly large VSIX file: ${entry.fileName}`));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { fail(streamError); return; }
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            if (failed) return;
            try {
              const bytes = Buffer.concat(chunks);
              if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) {
                throw new Error(`VSIX integrity check failed: ${entry.fileName}`);
              }
              const source = requiredPayloads.find((file) => `extension/${file.toLowerCase()}` === normalized);
              if (source) {
                const expected = fs.readFileSync(path.join(root, source));
                if (!bytes.equals(expected)) throw new Error(`VSIX content differs from the build: ${source}`);
              }
              zip.readEntry();
            } catch (verificationError) { fail(verificationError); }
          });
        });
      });
      zip.on('end', () => {
        if (failed) return;
        const missing = [...allowed].filter((file) => !seen.has(file));
        if (missing.length) { reject(new Error(`Missing VSIX files: ${missing.join(', ')}`)); return; }
        resolve();
      });
      zip.readEntry();
    });
  });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  console.log(`Verified ${seen.size} VSIX files, payload equality and ZIP CRCs. Only declared deliverables are included.`);
  console.log(`SHA-256 ${hash}`);
}

async function main() {
  runNode(path.join(root, 'scripts/build.js'));
  writeRuntimeNotices();
  const vsceManifest = require.resolve('@vscode/vsce/package.json');
  const vsceCli = path.join(path.dirname(vsceManifest), 'vsce');
  const archive = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
  // This creates a local review package only. It does not publish or sign in.
  runNode(vsceCli, ['package', '--no-dependencies', '--allow-missing-repository', '--no-rewrite-relative-links', '--skip-license', '-o', archive]);
  await verifyArchive(archive, vsceManifest);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
