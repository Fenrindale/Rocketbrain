'use strict';

const { createHash } = require('node:crypto');

const SQLITE_FILE_LIMIT = 32 * 1024 * 1024;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const hash = value => createHash('sha256').update(value).digest('hex');

function sqliteFileIdentity(location, stat) {
  if (!stat.isFile() || !stat.ino || !stat.birthtimeNs) return null;
  const normalized = process.platform === 'win32' ? location.toLowerCase() : location;
  return hash(JSON.stringify([normalized, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]));
}

module.exports = { SQLITE_FILE_LIMIT, SQLITE_MAGIC, sqliteFileIdentity, hash };
