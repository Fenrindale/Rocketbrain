'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const LIMITS = require('./limits');

/** A read-only, in-memory SQLite demo. Never opens a user's database. */
class DatabaseService {
  constructor() {
    this._worker = undefined;
    this._readyPromise = undefined;
    this._startupReject = undefined;
    this._startupTimer = undefined;
    this._pending = new Map();
    this._nextId = 0;
    this._queue = Promise.resolve();
    this._disposed = false;
  }

  async schema() {
    return this._enqueue(() => this._request('schema', {}, 5000));
  }

  async query(sql, { maxRows = 500, timeoutMs = 5000 } = {}) {
    this._assertOpen();
    if (typeof sql !== 'string' || !sql.trim()) {
      throw new Error('Enter one SELECT, WITH, or VALUES query for the demo database.');
    }
    if (sql.includes('\0') || Buffer.byteLength(sql, 'utf8') > LIMITS.maxSqlBytes) {
      throw new Error(`SQL must not contain NUL and must be at most ${LIMITS.maxSqlBytes} UTF-8 bytes.`);
    }
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > LIMITS.maxRows) {
      throw new Error(`maxRows must be an integer from 1 to ${LIMITS.maxRows}.`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < LIMITS.minTimeoutMs || timeoutMs > LIMITS.maxTimeoutMs) {
      throw new Error(`timeoutMs must be an integer from ${LIMITS.minTimeoutMs} to ${LIMITS.maxTimeoutMs}.`);
    }
    return this._enqueue(() => this._request('query', { sql, maxRows }, timeoutMs));
  }

  _assertOpen() {
    if (this._disposed) throw new Error('The demo database has been disposed.');
  }

  _enqueue(operation) {
    this._assertOpen();
    const result = this._queue.then(() => {
      this._assertOpen();
      return operation();
    });
    this._queue = result.catch(() => {});
    return result;
  }

  async _ensureWorker() {
    this._assertOpen();
    if (this._readyPromise) return this._readyPromise;
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    this._worker = worker;
    this._readyPromise = new Promise((resolve, reject) => {
      this._startupReject = reject;
      this._startupTimer = setTimeout(() => {
        this._invalidate(new Error('The demo database did not start in time.'));
      }, LIMITS.startupTimeoutMs);
      worker.on('message', (message) => {
        if (this._worker !== worker) return;
        if (message.type === 'ready') {
          clearTimeout(this._startupTimer);
          this._startupTimer = undefined;
          this._startupReject = undefined;
          resolve();
          return;
        }
        if (message.type === 'fatal') {
          this._invalidate(new Error(message.error || 'The demo database could not start.'));
          return;
        }
        const pending = this._pending.get(message.id);
        if (!pending) return;
        this._pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      });
      worker.on('error', (error) => {
        if (this._worker === worker) this._invalidate(error);
      });
      worker.on('exit', (code) => {
        if (this._worker === worker) {
          this._invalidate(new Error(`The demo database worker stopped (code ${code}).`));
        }
      });
    });
    return this._readyPromise;
  }

  async _request(type, payload, timeoutMs) {
    await this._ensureWorker();
    this._assertOpen();
    const worker = this._worker;
    return new Promise((resolve, reject) => {
      const id = ++this._nextId;
      const timer = setTimeout(() => {
        if (this._worker === worker) {
          this._invalidate(new Error(`Demo query timed out after ${timeoutMs} ms. The demo database was reset.`));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, type, ...payload });
      } catch (error) {
        this._invalidate(error);
      }
    });
  }

  _invalidate(error) {
    const worker = this._worker;
    this._worker = undefined;
    this._readyPromise = undefined;
    clearTimeout(this._startupTimer);
    this._startupTimer = undefined;
    if (this._startupReject) this._startupReject(error);
    this._startupReject = undefined;
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
    return worker ? worker.terminate().catch(() => {}) : Promise.resolve();
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    await this._invalidate(new Error('The demo database has been disposed.'));
  }
}

module.exports = { DatabaseService, LIMITS };
