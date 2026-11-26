'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const pin = require('./sqlite-edit-pin');

const errorWith = (code, message, sqliteCode) => Object.assign(Error(message), { code: 'ROCKETBRAIN_SQLITE_EDIT_' + code,
  ...(Number.isInteger(sqliteCode) && { sqliteCode }) });
const platformSupported = () => process.platform === pin.platform && process.arch === pin.arch;
const nodePath = file => typeof file === 'string' && /^[A-Za-z]:[\\/][^:\x00-\x1f]+$/u.test(file) && file.length <= 4096 &&
  path.basename(file).toLowerCase() === 'node.exe';
const badPin = () => errorWith('RUNTIME', 'Choose the official Windows x64 Node.js ' + pin.node + ' executable matching its published SHA-256.');
const canceled = () => errorWith('CANCELED', 'The SQLite operation was canceled before the file was opened.');

async function verifyBinary(file, destination, signal) {
  if (!platformSupported() || !nodePath(file)) throw badPin();
  if (signal?.aborted) throw canceled();
  let canonical, input;
  try { canonical = await fs.realpath(file); input = await fs.open(canonical, 'r'); }
  catch { throw badPin(); }
  try {
    const info = await input.stat();
    if (!nodePath(canonical) || !info.isFile() || info.size !== pin.bytes) throw badPin();
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let bytes = 0;
    const output = destination && await fs.open(destination, 'wx', 0o700);
    try {
      while (true) {
        if (signal?.aborted) throw canceled();
        const { bytesRead } = await input.read(chunk, 0, chunk.length, bytes);
        if (!bytesRead) break;
        if (bytes + bytesRead > pin.bytes) throw badPin();
        digest.update(chunk.subarray(0, bytesRead));
        if (output && (await output.write(chunk, 0, bytesRead, bytes)).bytesWritten !== bytesRead) throw badPin();
        bytes += bytesRead;
      }
    } finally { await output?.close(); }
    if (bytes !== pin.bytes || digest.digest('hex') !== pin.sha256) throw badPin();
    if (signal?.aborted) throw canceled();
    return canonical;
  } catch (error) {
    if (signal?.aborted) throw canceled();
    if (error.code?.startsWith('ROCKETBRAIN_SQLITE_EDIT_')) throw error;
    throw badPin();
  } finally { await input.close(); }
}

async function selectSqliteEditRuntime(file, { signal } = {}) {
  return { file: await verifyBinary(file, undefined, signal), ...pin };
}

function execute(executable, directory, request, signal) {
  if (signal?.aborted) throw canceled();
  const allowed = new Set(['SYSTEMROOT', 'WINDIR']);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))),
    TEMP: directory, TMP: directory };
  const worker = spawn(executable, ['--no-warnings', '--max-old-space-size=96', path.join(__dirname, 'sqlite-edit-worker.js')],
    { cwd: directory, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const parts = [];
  let bytes = 0, stopped;
  const stop = reason => { if (!stopped) { stopped = reason; worker.kill('SIGKILL'); } };
  const interrupt = (code, message) => request.operation === 'apply' ? errorWith('UNKNOWN',
    'The SQLite edit outcome could not be confirmed. Reopen the file and inspect the exact cell before another edit.') : errorWith(code, message);
  const abort = () => stop(interrupt('CANCELED', 'The SQLite inspection was canceled.'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(interrupt('TIMEOUT', 'SQLite inspection reached its time limit.')), 10000);
  timer.unref();
  return new Promise((resolve, reject) => {
    worker.stdin.on('error', () => {});
    worker.stdout.on('data', content => {
      bytes += content.byteLength;
      if (bytes > 2 * 1024 * 1024) stop(interrupt('LIMIT', 'The SQLite edit response exceeded the output bound.'));
      else parts.push(content);
    });
    worker.once('error', () => reject(errorWith('RUNTIME', 'The pinned SQLite runtime could not start.')));
    worker.once('close', code => {
      if (stopped || code !== 0) return reject(stopped || interrupt('RUNTIME', 'The SQLite runtime stopped unexpectedly.'));
      let response;
      try { response = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { return reject(interrupt('PROTOCOL', 'The SQLite response was invalid.')); }
      if (response.error?.code && response.error.message) {
        return reject(errorWith(response.error.code, response.error.message, response.error.sqliteCode));
      }
      if (response.result) return resolve(response.result);
      return reject(interrupt('PROTOCOL', 'The SQLite response was incomplete.'));
    });
    worker.stdin.end(JSON.stringify(request));
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

async function runSqliteCellOperation(runtime, request, { signal, guard } = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-sqlite-edit-'));
  const executable = path.join(directory, 'node.exe');
  let result, removed = false;
  try {
    await verifyBinary(runtime.file, executable, signal);
    if (guard && !guard()) throw errorWith('REVIEW', 'The SQLite file or pinned runtime changed before dispatch. Open a fresh review.');
    result = await execute(executable, directory, request, signal);
  } finally {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.unlink(executable).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rmdir(directory);
        removed = true;
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) break;
        await delay(50);
      }
    }
  }
  return removed ? result : { ...result, temporaryRuntimeCleanupPending: true };
}

module.exports = { selectSqliteEditRuntime, runSqliteCellOperation, platformSupported, errorWith };
