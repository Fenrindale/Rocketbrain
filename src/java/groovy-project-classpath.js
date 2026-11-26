'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inside, local, fail } = require('./workbench-model');
const { visitJar } = require('./signature-compiler');

const entryLimit = 120;
const fileLimit = 64 * 1024 * 1024;
const byteLimit = 256 * 1024 * 1024;
const itemLimit = 12000;
const hash = value => createHash('sha256').update(value).digest('hex');

function localClasspathPath(value) {
  const candidate = local(value);
  if (/^(?:\\\\|\/\/)/u.test(candidate) || /[\u0000-\u001f]/u.test(candidate)) {
    throw fail('Use physical local Groovy classpath entries.');
  }
  return path.normalize(candidate);
}

async function physical(item, stat) {
  const info = stat || await fs.lstat(item);
  if (info.isSymbolicLink() || path.relative(item, await fs.realpath(item))) {
    throw fail('Groovy classpath entries and files must use unlinked physical paths.');
  }
  return info;
}

async function readExact(file, expectedSize) {
  if (expectedSize > fileLimit) throw fail('A Groovy classpath file exceeds 64 MiB.');
  await physical(file);
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize) throw fail('The Groovy classpath changed during review.');
    const data = Buffer.alloc(expectedSize + 1);
    let total = 0;
    while (total < data.length) {
      const { bytesRead } = await handle.read(data, total, data.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== expectedSize || (await handle.stat()).size !== expectedSize) {
      throw fail('The Groovy classpath changed during review.');
    }
    return data.subarray(0, total);
  } finally { await handle.close(); }
}

async function validateJar(file, digest, groovyHash) {
  const core = /^(?:META-INF\/versions\/[0-9]+\/)?groovy\/lang\/GroovySystem\.class$/iu;
  await visitJar(file, async (entry, read) => {
    // The required JDK ignores the obsolete JAR index at runtime. Keep the reviewed archive bytes intact.
    if (core.test(entry.fileName) && digest !== groovyHash) throw fail('The project classpath contains a different Groovy core runtime.');
    if (!/^META-INF\/MANIFEST\.MF$/iu.test(entry.fileName)) return;
    if (entry.uncompressedSize > 4 * 1024 * 1024) throw fail('A Groovy JAR manifest exceeds its inspection limit.');
    const manifest = (await read()).toString('utf8').replace(/\r\n?/gu, '\n');
    const boundary = manifest.indexOf('\n\n');
    const main = boundary === -1 ? manifest : manifest.slice(0, boundary);
    if (Buffer.byteLength(main) > 256 * 1024 || /^Class-Path\s*:/imu.test(main.replace(/\n /gu, ''))) {
      throw fail('Review Groovy JARs whose manifests contain no indirect classpath.');
    }
  });
}

function checkPart(name) {
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\u0000-\u001f]/u.test(name) ||
      /[. ]$/u.test(name)) throw fail('The Groovy classpath contains an unsafe resource name.');
}

async function captureClasspath(values, roots, groovyHash, check = () => {}) {
  if (!Array.isArray(values) || !values.length || values.length > entryLimit) {
    throw fail('Review 1 to 120 ordered Groovy project classpath entries.');
  }
  const entries = [];
  let files = 0, bytes = 0, traversed = 0;

  async function inspectFile(file, stat) {
    if (++files > itemLimit || (bytes += stat.size) > byteLimit) {
      throw fail('The reviewed Groovy classpath exceeds its file or 256 MiB byte budget.');
    }
    check();
    const digest = hash(await readExact(file, stat.size));
    check();
    return { size: stat.size, digest };
  }

  async function walk(root, dir, depth, localFiles) {
    if (depth > 32) throw fail('The Groovy classpath directory is too deep.');
    await physical(dir);
    const handle = await fs.opendir(dir);
    const list = [];
    for await (const entry of handle) {
      if (++traversed > itemLimit) throw fail('The Groovy classpath directory exceeds its entry limit.');
      checkPart(entry.name);
      list.push(entry.name);
    }
    list.sort();
    const names = new Set();
    for (const name of list) {
      check();
      const unique = process.platform === 'win32' ? name.toLowerCase() : name;
      if (names.has(unique)) throw fail('The Groovy classpath contains colliding resource names.');
      names.add(unique);
      const file = path.join(dir, name), stat = await physical(file);
      if (stat.isDirectory()) await walk(root, file, depth + 1, localFiles);
      else if (stat.isFile()) {
        const relative = path.relative(root, file);
        if (relative.replaceAll(path.sep, '/') === 'groovy/lang/GroovySystem.class') {
          throw fail('The project output contains a competing Groovy core runtime.');
        }
        localFiles.push({ relative, ...await inspectFile(file, stat) });
      } else throw fail('The Groovy classpath contains a non-file resource.');
      check();
    }
  }

  for (const value of values) {
    check();
    const file = localClasspathPath(value);
    if (entries.some(entry => !path.relative(entry.file, file))) continue;
    const stat = await fs.lstat(file).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat && roots.some(root => inside(root, file)) && !/\.jar$/iu.test(file)) {
      entries.push({ kind: 'absent', file });
      continue;
    }
    if (!stat) throw fail('A reviewed Groovy classpath dependency is unavailable.');
    await physical(file, stat);
    if (stat.isDirectory()) {
      if (!roots.some(root => inside(root, file)) || roots.some(root => !path.relative(root, file))) {
        throw fail('Use JDT output directories inside an open workspace.');
      }
      const items = [];
      await walk(file, file, 0, items);
      entries.push({ kind: 'directory', file, items });
    } else if (stat.isFile() && /\.jar$/iu.test(file)) {
      const content = await inspectFile(file, stat);
      await validateJar(file, content.digest, groovyHash);
      entries.push({ kind: content.digest === groovyHash ? 'pinned-runtime' : 'jar', file, ...content });
    } else throw fail('Use JARs or project output directories for the Groovy classpath.');
  }
  if (!entries.some(entry => entry.kind === 'directory' && entry.items.some(file => /\.class$/u.test(file.relative)))) {
    throw fail('Build the selected Java project before reviewing its Groovy classpath.');
  }
  return { entries, files, bytes, groovyHash, digest: hash(JSON.stringify(entries)) };
}

async function stageClasspath(packet, owned, check) {
  const entries = [];
  for (const [index, entry] of packet.entries.entries()) {
    check();
    if (entry.kind === 'absent' || entry.kind === 'pinned-runtime') continue;
    const staging = path.join(owned, 'entry-' + index);
    await fs.mkdir(staging);
    if (entry.kind === 'directory') {
      for (const item of entry.items) {
        check();
        const bytes = await readExact(path.join(entry.file, item.relative), item.size);
        if (hash(bytes) !== item.digest) throw fail('The Groovy classpath changed after review.');
        const target = path.join(staging, item.relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { flag: 'wx' });
      }
      entries.push(staging);
    } else {
      const bytes = await readExact(entry.file, entry.size);
      if (hash(bytes) !== entry.digest) throw fail('The Groovy classpath changed after review.');
      const target = path.join(staging, path.basename(entry.file));
      await fs.writeFile(target, bytes, { flag: 'wx' });
      await validateJar(target, entry.digest, packet.groovyHash);
      entries.push(target);
    }
  }
  check();
  return entries;
}

module.exports = { captureClasspath, stageClasspath, readExact, hash };
