'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const markers = { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1' };
const tableName = '측정;"values';
const sourceTable = '"' + tableName.replaceAll('"', '""') + '"';
const schema = `CREATE TABLE batch (code TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE ${sourceTable} (
  group_id TEXT NOT NULL REFERENCES batch(code) ON UPDATE CASCADE,
  seq INTEGER NOT NULL,
  reading INTEGER,
  display TEXT,
  data BLOB,
  ratio REAL,
  next_seq INTEGER GENERATED ALWAYS AS (seq + 1) STORED,
  PRIMARY KEY (group_id, seq)
) WITHOUT ROWID, STRICT;
CREATE INDEX measured_display ON ${sourceTable} (lower(display), seq DESC) WHERE data IS NOT NULL;
CREATE VIEW public_measurement AS SELECT seq,reading,display,data,ratio,next_seq FROM ${sourceTable};
INSERT INTO batch VALUES ('그룹');
INSERT INTO ${sourceTable} (group_id,seq,reading,display,data,ratio) VALUES
 ('그룹',1,9223372036854775807,char(54620,0,44544)||' 🧪',x'00ff00',1.0),
 ('그룹',2,-9223372036854775808,'東京',x'',0.125),
 ('그룹',3,NULL,NULL,NULL,NULL);`;

function seedSqlite(file, options = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    if (options.wal) db.exec('PRAGMA journal_mode=WAL');
    db.exec(schema);
    if (options.updated) db.exec(`INSERT INTO ${sourceTable} (group_id,seq,reading,display,data,ratio) VALUES ('그룹',4,17,'갱신',x'fe',2.0)`);
    return db.prepare('SELECT sqlite_version() version, sqlite_source_id() sourceId').get();
  } finally { db.close(); }
}

async function prepareSqliteFileFixture(owned) {
  const configPath = await fs.realpath(owned.db.configPath);
  const folder = path.dirname(configPath);
  const marker = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, markers[owned.dbEngine]);
  assert.equal(marker.id, owned.db.id);
  assert.equal(owned.db.config.host, '127.0.0.1');
  const stem = path.join(folder, 'rocketbrain-sqlite-' + randomUUID());
  const primary = stem + '.db', updated = stem + '-updated.db', wal = stem + '-wal-mode.db';
  const sqlite = seedSqlite(primary);
  seedSqlite(updated, { updated: true });
  seedSqlite(wal, { wal: true });
  const descriptor = stem + '.json';
  await fs.writeFile(descriptor, JSON.stringify({ kind: 'RocketbrainOwnedSqliteSnapshot-v1', engine: owned.dbEngine, owner: marker.id, configPath,
    file: path.basename(primary), updated: path.basename(updated), wal: path.basename(wal), runtime: { node: process.version, ...sqlite } }),
  { flag: 'wx', mode: 0o600 });
  return descriptor;
}

module.exports = { prepareSqliteFileFixture, seedSqlite, tableName, schema, markers };
