'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const LIMITS = require('./limits');

const defaultTimeout = 5000;
const maxReviews = 8;
const lifetime = 120000;
const fail = (message, detail = 'QUERY') => Object.assign(new Error(message), { code: 'ROCKETBRAIN_SQLITE_' + detail });

class SqliteFileSession {
  constructor(file) {
    this.file = file;
    this.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { mode: 'sqlite-file', file },
      resourceLimits: { maxOldGenerationSizeMb: 96 } });
    this.next = 0;
    this.reviews = new Map();
    this.pending = null;
    this.source = null;
    this.stopped = null;
    this.worker.on('message', message => this.receive(message));
    this.worker.on('error', () => this.stop(fail('The SQLite snapshot worker failed. Open the file again.', 'CLOSED')));
    this.worker.on('exit', () => this.stop(fail('The SQLite snapshot worker stopped. Open the file again.', 'CLOSED')));
  }

  receive(message) {
    if (this.stopped) return;
    if (message.type === 'fatal') {
      this.stop(fail(message.error || 'The SQLite snapshot could not be opened.', 'OPEN'));
      return;
    }
    const pending = this.pending;
    if (!pending || (pending.id === null ? message.type !== 'ready' : pending.id !== message.id)) return;
    if (message.error) pending.finish(fail(message.error));
    else pending.finish(null, pending.id === null ? message.source : message.result);
  }

  call(type, data, { signal, timeoutMs = defaultTimeout } = {}) {
    if (this.stopped) throw fail('Open a local SQLite snapshot first.', 'CLOSED');
    if (this.pending) throw fail('Wait for the active SQLite operation to finish.', 'BUSY');
    if (signal?.aborted) throw fail('SQLite operation canceled.', 'CANCELED');
    if (!Number.isInteger(timeoutMs) || timeoutMs < LIMITS.minTimeoutMs || timeoutMs > LIMITS.maxTimeoutMs) {
      throw fail('Choose a SQLite timeout from 10 to 30000 milliseconds.');
    }
    return new Promise((resolve, reject) => {
      const id = type ? ++this.next : null;
      const abort = () => this.stop(fail('SQLite operation canceled. Reopen the file to resume.', 'CANCELED'));
      const timer = setTimeout(() => this.stop(fail('SQLite operation timed out. Reopen the file to resume.', 'TIMEOUT')), timeoutMs);
      this.pending = { id, finish: (error, result) => {
        this.pending = null;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result);
      } };
      signal?.addEventListener('abort', abort, { once: true });
      if (id !== null) {
        try { this.worker.postMessage({ id, type, ...data }); }
        catch { this.stop(fail('The SQLite snapshot worker is unavailable.', 'CLOSED')); }
      }
    });
  }

  stop(error = fail('The SQLite snapshot was closed.', 'CLOSED')) {
    if (!this.stopped) {
      this.reviews.clear();
      this.source = null;
      this.stopped = this.worker.terminate().catch(() => {});
      this.pending?.finish(error);
    }
    return this.stopped;
  }

  catalog(options) { return this.call('catalog', {}, options); }
  describe(name, options) { return this.call('describe', { name }, options); }

  async prepare(sql, { maxRows = 500, ...options } = {}) {
    if (typeof sql !== 'string' || !sql.trim() || sql.includes('\0') || Buffer.byteLength(sql, 'utf8') > LIMITS.maxSqlBytes) {
      throw fail('Enter SQL without NUL, up to 64 KiB.');
    }
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > LIMITS.maxRows) throw fail('Choose a SQLite result limit from 1 to 5000.');
    const description = await this.call('review', { sql }, options);
    if (!this.source) throw fail('The SQLite snapshot changed. Review the current query again.', 'CLOSED');
    while (this.reviews.size >= maxReviews) this.reviews.delete(this.reviews.keys().next().value);
    const data = { reviewId: randomUUID(), sql, maxRows, snapshotSha256: this.source.snapshotSha256,
      expiresAt: Date.now() + lifetime, ...description };
    this.reviews.set(data.reviewId, structuredClone(data));
    return data;
  }

  discard(reviewId) { this.reviews.delete(reviewId); }

  async execute(reviewId, options) {
    const saved = this.reviews.get(reviewId);
    if (!saved || saved.expiresAt < Date.now() || saved.snapshotSha256 !== this.source?.snapshotSha256) {
      throw fail('Review the exact query again on the selected SQLite snapshot.');
    }
    this.discard(reviewId);
    return this.call('execute', { sql: saved.sql, maxRows: saved.maxRows }, options);
  }
}

async function openSqliteSnapshot(file, options) {
  const session = new SqliteFileSession(file);
  try {
    session.source = Object.freeze(await session.call(null, {}, { timeoutMs: LIMITS.startupTimeoutMs, ...options }));
    return session;
  } catch (error) {
    await session.stop();
    throw error;
  }
}

module.exports = { openSqliteSnapshot };
