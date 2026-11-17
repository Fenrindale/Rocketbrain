'use strict';

// These bounds apply to the bundled, disposable demo database only.
module.exports = Object.freeze({
  maxSqlBytes: 64 * 1024,
  maxRows: 5000,
  maxColumns: 128,
  maxCellBytes: 128 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  minTimeoutMs: 10,
  maxTimeoutMs: 30000,
  startupTimeoutMs: 15000,
});
