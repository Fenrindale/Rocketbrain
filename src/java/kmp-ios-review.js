'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const safeName = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const bundleName = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*){1,9}$/;
const maxBundleBytes = 128 * 1024 * 1024;

function childPath(parent, input, kind) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) {
    throw Error('Choose a saved physical ' + kind + '.');
  }
  const name = path.resolve(input);
  const relative = path.relative(parent, name);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      fs.realpathSync.native(name) !== name) throw Error('Choose a physical ' + kind + ' inside the reviewed workspace or bundle.');
  return name;
}

function fileDigest(file, limit = maxBundleBytes) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size > limit) throw Error('The selected file is outside the regular-file and size limits.');
  const hash = createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) {
      throw Error('A reviewed file changed while it was opened.');
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    for (;;) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      count += length;
      if (count > before.size) throw Error('A reviewed file changed while it was read.');
      hash.update(buffer.subarray(0, length));
    }
    const end = fs.fstatSync(fd);
    if (count !== before.size || end.mtimeMs !== before.mtimeMs || end.ctimeMs !== before.ctimeMs) {
      throw Error('A reviewed file changed while it was read.');
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function bundleDigest(dir) {
  const hash = createHash('sha256');
  let entries = 0, size = 0;
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (++entries > 1800 || /[\x00-\x1f]/.test(name)) throw Error('The app exceeds the supported iOS bundle bounds.');
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      const relative = path.relative(dir, file);
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(['directory', relative]));
        visit(file);
      } else if (stat.isFile() && (size += stat.size) <= maxBundleBytes) {
        hash.update(JSON.stringify(['file', relative, stat.mode & 0o111, fileDigest(file)]));
      } else {
        throw Error('Use a flat iOS simulator bundle without links, special files or more than 128 MB.');
      }
    }
  }
  visit(dir);
  return hash.digest('hex');
}

function armSimulatorBuild(output) {
  const platforms = Array.from(output.matchAll(/^\s*platform\s+(\S+)\s*$/gmi), match => match[1].toUpperCase());
  if (platforms.length !== 1 || !['IOSSIMULATOR', '7'].includes(platforms[0])) {
    throw Error('Only an arm64 iOS Simulator Mach-O app and framework are supported.');
  }
}

function armUuid(output) {
  const rows = output.trim().split(/\r?\n/);
  const row = rows.length === 1 && rows[0].match(/^UUID: ([a-f0-9-]{36}) \(arm64\) .+$/i);
  if (!row || !uuid.test(row[1])) throw Error('Expected one stock arm64 Mach-O UUID from dwarfdump.');
  return row[1].toLowerCase();
}

async function inspectIosReview(input, tool) {
  const root = fs.realpathSync.native(input.root);
  const app = childPath(root, input.app, 'simulator app');
  const source = childPath(root, input.source, 'Kotlin source file');
  const dsym = childPath(root, input.dsym, 'Kotlin framework dSYM');
  if (!app.endsWith('.app') || !dsym.endsWith('.dSYM') || !source.endsWith('.kt') ||
      !fs.statSync(app).isDirectory() || !fs.statSync(dsym).isDirectory() ||
      !safeName.test(input.framework) || !/\.framework$/.test(input.framework) || !Number.isSafeInteger(input.line) ||
      input.line < 1) throw Error('Choose a built iOS Simulator app, embedded Kotlin framework, matching dSYM and saved source line.');
  const sourceSha256 = fileDigest(source, 2 * 1024 * 1024);
  if (input.line > fs.readFileSync(source, 'utf8').split(/\r\n|\n|\r/).length) throw Error('Set a breakpoint on an existing Kotlin source line.');
  const appSha256 = bundleDigest(app);
  const metadata = childPath(app, path.join(app, 'Info.plist'), 'Info.plist');
  fileDigest(metadata, 256 * 1024);
  const plist = JSON.parse(await tool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', metadata]));
  if (!bundleName.test(plist.CFBundleIdentifier) || !safeName.test(plist.CFBundleExecutable) ||
      plist.CFBundlePackageType !== 'APPL' ||
      !plist.CFBundleSupportedPlatforms?.includes('iPhoneSimulator')) {
    throw Error('Select a conventional iPhoneSimulator app with identifiable bundle and executable.');
  }
  const executable = childPath(app, path.join(app, plist.CFBundleExecutable), 'app executable');
  const frameworkName = path.basename(input.framework, '.framework');
  const framework = childPath(app, path.join(app, 'Frameworks', input.framework, frameworkName), 'Kotlin framework binary');
  const symbols = childPath(dsym, path.join(dsym, 'Contents', 'Resources', 'DWARF', frameworkName), 'Kotlin DWARF file');
  const symbolsSha256 = fileDigest(symbols);
  const [appUuid, frameworkUuid, symbolsUuid] = await Promise.all([executable, framework, symbols].map(async file => {
    if (file !== symbols) armSimulatorBuild(await tool('vtool', ['-show-build', file]));
    return armUuid(await tool('dwarfdump', ['--uuid', file]));
  }));
  if (frameworkUuid !== symbolsUuid) throw Error('The dSYM does not match the reviewed Kotlin framework Mach-O UUID.');
  const executableSha256 = fileDigest(executable), frameworkSha256 = fileDigest(framework);
  function validate() {
    if (childPath(root, app, 'simulator app') !== app || childPath(root, dsym, 'Kotlin framework dSYM') !== dsym ||
        childPath(root, source, 'Kotlin source file') !== source ||
        fileDigest(source, 2 * 1024 * 1024) !== sourceSha256 || bundleDigest(app) !== appSha256 ||
        childPath(dsym, symbols, 'Kotlin DWARF file') !== symbols || fileDigest(symbols) !== symbolsSha256) {
      throw Error('The reviewed Kotlin source, simulator app or dSYM changed. Review the current build again.');
    }
  }
  validate();
  return { app, appUuid, bundleId: plist.CFBundleIdentifier, executable, executableSha256, framework, frameworkUuid,
    frameworkSha256, symbols, symbolsSha256, appSha256, source, sourceSha256, line: input.line, validate };
}

module.exports = { inspectIosReview, armUuid, armSimulatorBuild, bundleDigest, fileDigest, uuid, safeName };
