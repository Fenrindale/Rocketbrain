'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Writable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const maxDumpBytes = 256 * 1024 * 1024;
const maxToolBytes = 64 * 1024 * 1024;
const maxDiagnosticBytes = 8192;
const timeoutMs = 15 * 60 * 1000;
const error = (code, message) => Object.assign(new Error(message), { code: 'ROCKETBRAIN_NATIVE_DUMP_' + code });

function environment() {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
}

function readOutput(stream, maxBytes, onOverflow) {
  const parts = [];
  let bytes = 0;
  stream.on('data', chunk => {
    const before = bytes;
    if (before < maxBytes) parts.push(chunk.subarray(0, maxBytes - before));
    bytes += chunk.length;
    if (before <= maxBytes && bytes > maxBytes) onOverflow();
  });
  return () => ({ text: Buffer.concat(parts).toString('utf8'), overflow: bytes > maxBytes });
}

function runner(file, args, { cwd, input, output, signal, limit = timeoutMs, probe = false } = {}) {
  if (signal?.aborted) return Promise.reject(error('CANCELLED', 'The native database operation was cancelled.'));
  const processChild = spawn(file, args, { cwd, env: environment(), shell: false, windowsHide: true,
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let interrupted;
  const stop = reason => { interrupted ||= reason; processChild.kill('SIGKILL'); };
  const overflow = () => stop(error('OUTPUT_LIMIT', 'The native database tool exceeded its diagnostic output limit.'));
  const observedErrors = readOutput(processChild.stderr, maxDiagnosticBytes, overflow);
  const observedOutput = output ? undefined : readOutput(processChild.stdout, maxDiagnosticBytes, overflow);
  const onAbort = () => stop(error('CANCELLED', 'The native database operation was cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const expiry = setTimeout(() => stop(error('TIMEOUT', 'The native database operation reached its time limit.')), limit);
  expiry.unref();
  const result = new Promise((resolve, reject) => {
    processChild.once('error', () => reject(error('LAUNCH', 'The selected native database tool could not be started.')));
    processChild.once('close', code => {
      if (interrupted) return reject(interrupted);
      const stderr = observedErrors();
      const captured = observedOutput?.();
      if (code !== 0 || stderr.overflow || captured?.overflow) {
        const number = /\b(?:ERROR|Error|error)\s+(\d{3,5})\b/.exec(stderr.text)?.[1];
        return reject(error('TOOL', 'The native database tool stopped' + (number ? ' (database error ' + number + ')' : '') + '.'));
      }
      resolve({ text: probe ? captured?.text : undefined, warnings: Boolean(stderr.text.trim()) });
    });
  });
  const streams = [];
  if (input) streams.push(pipeline(...input, processChild.stdin));
  if (output) streams.push(pipeline(processChild.stdout, ...output));
  for (const stream of streams) stream.catch(cause => {
    if (cause.code === 'EPIPE' || cause.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    stop(cause.code?.startsWith('ROCKETBRAIN_NATIVE_DUMP_') ? cause : error('IO', 'The native dump file stream could not be completed.'));
  });
  return Promise.allSettled([result, ...streams]).then(([childResult, ...streamResults]) => {
    if (interrupted) throw interrupted;
    if (childResult.status === 'rejected') throw childResult.reason;
    if (streamResults.some(item => item.status === 'rejected')) throw error('IO', 'The native database tool did not consume the entire file.');
    return childResult.value;
  }).finally(() => { clearTimeout(expiry); signal?.removeEventListener('abort', onAbort); });
}

async function privateDirectory() {
  const folder = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-native-dump-'));
  try {
    if (process.platform === 'win32') {
      const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      const identity = await runner(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { probe: true, limit: 5000 });
      const sid = /"(S-1-(?:[0-9]+-)+[0-9]+)"/i.exec(identity.text)?.[1];
      if (!sid) throw error('PERMISSIONS', 'The current Windows user could not be determined for the private temporary folder.');
      await runner(path.join(system, 'icacls.exe'), [folder, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'], { limit: 5000 });
    } else {
      await fs.chmod(folder, 0o700);
      const stat = await fs.stat(folder);
      if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw error('PERMISSIONS', 'The temporary database credentials folder is not private.');
    }
  } catch {
    await fs.rmdir(folder).catch(() => {});
    throw error('PERMISSIONS', 'The private temporary folder could not be secured.');
  }
  return folder;
}

async function withPrivateDirectory(action) {
  const directory = await privateDirectory();
  try { return await action(directory); }
  finally {
    const deleted = await Promise.allSettled(['rb-client.cnf', 'reviewed.sql'].map(name => fs.unlink(path.join(directory, name))));
    if (deleted.some(result => result.status === 'rejected' && result.reason.code !== 'ENOENT')) {
      throw error('CLEANUP', 'The private temporary database files could not be removed.');
    }
    try { await fs.rmdir(directory); }
    catch { throw error('CLEANUP', 'The private temporary database folder could not be removed.'); }
  }
}

function option(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw error('CREDENTIALS', 'A database connection value cannot be passed to the native client.');
  }
  const escapes = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  return '"' + value.replace(/[\\"\n\r\t]/g, character => escapes[character]) + '"';
}

async function writeClientFile(directory, config) {
  const content = ['[client]', 'protocol=TCP', 'host=' + option(config.host), 'port=' + config.port,
    'user=' + option(config.user), 'password=' + option(config.password), 'default-character-set=utf8mb4', ''].join('\n');
  await fs.writeFile(path.join(directory, 'rb-client.cnf'), content, { flag: 'wx', mode: 0o600 });
}

function measure(maxBytes, onProgress, signal) {
  const digest = createHash('sha256');
  let bytes = 0, last = 0;
  const stream = new Transform({ transform(chunk, encoding, done) {
    bytes += chunk.length;
    if (signal?.aborted) return done(error('CANCELLED', 'The native database operation was cancelled.'));
    if (bytes > maxBytes) return done(error('SIZE', 'The native database file exceeds its size limit.'));
    digest.update(chunk);
    if (bytes - last >= 1024 * 1024) { last = bytes; onProgress?.(bytes); }
    done(null, chunk);
  } });
  return { stream, summary: () => ({ bytes, sha256: digest.digest('hex') }) };
}

async function readFile(file, { maxBytes, output, onProgress, signal } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > maxBytes) throw error('SIZE', 'Choose a nonempty regular file within the native database size limit.');
    const metered = measure(maxBytes, onProgress, signal);
    const destination = output ? output() : new Writable({ write(chunk, encoding, done) { done(); } });
    await pipeline(handle.createReadStream(), metered.stream, destination);
    return metered.summary();
  } finally { await handle.close(); }
}

async function tool(directory, name, dialect) {
  const file = await fs.realpath(path.join(directory, name + (process.platform === 'win32' ? '.exe' : '')));
  const actual = path.dirname(file);
  if ((process.platform === 'win32' ? actual.toLowerCase() : actual) !==
      (process.platform === 'win32' ? directory.toLowerCase() : directory)) {
    throw error('TOOL_PATH', 'Use a client binary inside the explicitly selected vendor directory.');
  }
  const initial = await readFile(file, { maxBytes: maxToolBytes });
  const { text } = await runner(file, ['--no-defaults', '--version'], { probe: true, limit: 5000 });
  const vendor = /mariadb/i.test(text) ? 'mariadb' : /\bMySQL\b/i.test(text) ? 'mysql' : null;
  const version = (vendor === 'mariadb' ? /(?:from|Distrib)\s+(\d+\.\d+\.\d+)/i : /\bVer\s+(\d+\.\d+\.\d+)/i).exec(text)?.[1];
  if (vendor !== dialect || !version || (dialect === 'mysql' ? Number(version.split('.')[0]) < 8 : Number(version.split('.')[0]) < 11)) {
    throw error('TOOL_VERSION', 'The selected native client must be MySQL 8 or later, or MariaDB 11 or later, and match the database dialect.');
  }
  return { file, version, fingerprint: initial.sha256 };
}

async function inspectTools(selected, dialect) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw error('TOOL_PATH', 'Select an absolute vendor client bin directory.');
  try {
    const directory = await fs.realpath(selected);
    const [dump, restore] = await Promise.all((dialect === 'mysql' ? ['mysqldump', 'mysql'] : ['mariadb-dump', 'mariadb'])
      .map(name => tool(directory, name, dialect)));
    if (dump.version !== restore.version) throw error('TOOL_VERSION', 'Select matching native backup and restore binaries from one vendor release.');
    return { directory, version: dump.version, dump, restore };
  } catch (cause) {
    if (cause.code?.startsWith('ROCKETBRAIN_NATIVE_DUMP_')) throw cause;
    throw error('TOOL_PATH', 'The selected directory does not contain both required vendor client binaries.');
  }
}

module.exports = { error, inspectTools, measure, maxDumpBytes, maxToolBytes, readFile, runner, withPrivateDirectory, writeClientFile };
