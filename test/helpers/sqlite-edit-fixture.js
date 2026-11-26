'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { markers } = require('./sqlite-file-fixture');

const fixtureKind = 'RocketbrainOwnedSqliteEdit-v1';
const primaryKey = '9007199254740994';
const fixtureSql = `CREATE TABLE edited(id INTEGER PRIMARY KEY, amount INTEGER, label TEXT UNIQUE ON CONFLICT REPLACE,
 binary_data BLOB, ratio REAL, linked TEXT UNIQUE, required TEXT NOT NULL) STRICT;
 INSERT INTO edited VALUES (9007199254740994,9223372036854775807,'before',x'00ff',1.25,'parent','same'),
 (-1,-9223372036854775808,'peer',x'',0.125,'peer-parent','peer-stable');
 CREATE TABLE dependent(id INTEGER PRIMARY KEY, link TEXT REFERENCES edited(linked) ON UPDATE CASCADE) STRICT;
 INSERT INTO dependent VALUES(1,'parent');
 CREATE TABLE guarded(id INTEGER PRIMARY KEY, value TEXT) STRICT;
 INSERT INTO guarded VALUES(1,'held');
 CREATE TRIGGER guarded_edit AFTER UPDATE ON guarded BEGIN UPDATE edited SET required='triggered' WHERE id=-1; END;
 CREATE TABLE generated(id INTEGER PRIMARY KEY, raw TEXT, derived INTEGER GENERATED ALWAYS AS (length(raw)) STORED) STRICT;
 INSERT INTO generated(id,raw) VALUES(1,'source');
 CREATE VIEW edited_view AS SELECT id,label FROM edited;`;

function seedSqliteEdit(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try { db.exec(fixtureSql); }
  finally { db.close(); }
}

function prepareSqliteEditFixture(owned) {
  const configPath = fs.realpathSync(owned.db.configPath);
  const folder = path.dirname(configPath);
  const marker = JSON.parse(fs.readFileSync(path.join(folder, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, markers[owned.dbEngine]);
  assert.equal(marker.id, owned.db.id);
  assert.equal(owned.db.config.host, '127.0.0.1');
  const stem = 'rocketbrain-sqlite-cell-' + randomUUID(), name = stem + '.db';
  seedSqliteEdit(path.join(folder, name));
  const descriptor = path.join(folder, stem + '.json');
  fs.writeFileSync(descriptor, JSON.stringify({ kind: fixtureKind, engine: owned.dbEngine, owner: marker.id, configPath, name }), { flag: 'wx' });
  return descriptor;
}

function fixtureRoute(descriptor) {
  const location = fs.realpathSync(descriptor), folder = path.dirname(location);
  const config = JSON.parse(fs.readFileSync(location, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(folder, 'owner.json'), 'utf8'));
  assert.equal(config.kind, fixtureKind);
  assert.equal(marker.kind, markers[config.engine]);
  assert.equal(marker.id, config.owner);
  assert.equal(path.dirname(fs.realpathSync(config.configPath)), folder);
  assert.match(config.name, /^rocketbrain-sqlite-cell-[a-f0-9-]{36}\.db$/u);
  assert.equal(path.basename(location), config.name.replace(/\.db$/u, '.json'));
  const file = fs.realpathSync(path.join(folder, config.name));
  assert.equal(path.dirname(file), folder);
  return { ...config, file };
}

function rawProbe(action, descriptor) {
  const { DatabaseSync } = require('node:sqlite');
  const { file } = fixtureRoute(descriptor);
  if (action === 'replace') {
    const retained = file + '.retained';
    fs.renameSync(file, retained);
    fs.copyFileSync(retained, file, fs.constants.COPYFILE_EXCL);
    return { replaced: true };
  }
  const url = pathToFileURL(file);
  url.searchParams.set('mode', action === 'values' ? 'ro' : 'rw');
  const db = new DatabaseSync(url.href, { timeout: 0, readOnly: action === 'values' });
  if (action === 'hold') {
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\n');
    process.stdin.resume();
    process.stdin.once('end', () => { db.exec('ROLLBACK'); db.close(); });
    return undefined;
  }
  try {
    if (action === 'values') {
      const rows = db.prepare('SELECT CAST(id AS TEXT) id,CAST(amount AS TEXT) amount,hex(CAST(label AS BLOB)) labelHex,' +
        'typeof(binary_data) bytesType,hex(binary_data) bytesHex,ratio,required,linked FROM edited ORDER BY id').all();
      return { rows, dependent: db.prepare('SELECT link FROM dependent').get().link,
        guarded: db.prepare('SELECT value FROM guarded').get().value };
    }
    if (action === 'peer') db.exec("UPDATE edited SET required='peer-committed' WHERE id=-1");
    else if (action === 'stale-row') db.exec("UPDATE edited SET required='other-client' WHERE id=9007199254740994");
    else if (action === 'stale-schema') db.exec('ALTER TABLE edited ADD COLUMN externally_added TEXT');
    else assert.fail('Unknown owned fixture operation');
    return { completed: true };
  } finally { db.close(); }
}

module.exports = { prepareSqliteEditFixture, seedSqliteEdit, fixtureRoute, primaryKey };
if (require.main === module) {
  try {
    const value = rawProbe(process.argv[2], process.argv[3]);
    if (value !== undefined) process.stdout.write(JSON.stringify(value));
  } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}
