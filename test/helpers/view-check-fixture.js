'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const quote = value => String.fromCharCode(96) + value + String.fromCharCode(96);

async function prepareViewCheckFixture(db) {
  const dir = path.dirname(await fs.realpath(db.configPath));
  const ownership = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(ownership.kind));
  assert.equal(ownership.id, path.basename(dir));
  const source = db.config;
  assert.equal(source.host, '127.0.0.1');
  assert.equal(source.database, 'rocketbrain_fixture');
  const tag = randomBytes(5).toString('hex');
  const names = Object.fromEntries(['base','inner','target','alternate','aggregate'].map(type => [type, 'rb_check_' + type + '_' + tag]));
  const account = prefix => ({ ...source, user:'rb_v_' + prefix + '_' + tag, password:randomBytes(24).toString('base64url') });
  const writer = account('write'), reader = account('read'), drift = account('drift');
  const schema = quote(source.database), qualified = name => schema + '.' + quote(name);
  const author = await mysql.createConnection(source);
  try {
    await author.query('SET NAMES utf8mb4 COLLATE utf8mb4_bin');
    for (const table of [names.base, names.alternate]) {
      await author.query('CREATE TABLE ' + qualified(table) + ' (id INT PRIMARY KEY, score INT NOT NULL) ENGINE=InnoDB');
    }
    await author.query('INSERT INTO ' + qualified(names.base) + ' (id,score) VALUES (1,10),(2,130)');
    await author.query('CREATE ALGORITHM=MERGE SQL SECURITY DEFINER VIEW ' + qualified(names.inner) +
      ' AS SELECT id,score FROM ' + qualified(names.base) + ' WHERE score>0');
    await author.query('CREATE ALGORITHM=MERGE SQL SECURITY DEFINER VIEW ' + qualified(names.target) +
      ' AS SELECT id,score FROM ' + qualified(names.inner) + ' WHERE score<100 WITH LOCAL CHECK OPTION');
    await author.query('CREATE SQL SECURITY DEFINER VIEW ' + qualified(names.aggregate) +
      ' AS SELECT COUNT(id) AS qty FROM ' + qualified(names.base));
  } finally { await author.end(); }
  await db.withAdmin(async admin => {
    for (const user of [writer,reader,drift]) await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [user.user, user.host, user.password]);
    const target = qualified(names.target), actor = [source.user, source.host];
    await admin.query('GRANT SELECT (Host,Db,User,Table_name,Table_priv,Column_priv) ON mysql.tables_priv TO ?@?', actor);
    await admin.query('GRANT SELECT (Host,Db,User,Table_name,Column_name,Column_priv) ON mysql.columns_priv TO ?@?', actor);
    // MariaDB verifies the view definer’s grantability through nested views for direct column grants.
    for (const relation of [names.base,names.inner,names.target]) {
      await admin.query('GRANT SELECT, UPDATE ON ' + qualified(relation) + ' TO ?@? WITH GRANT OPTION', actor);
    }
    await admin.query('GRANT SELECT, UPDATE (score) ON ' + target + ' TO ?@?', [writer.user,writer.host]);
    await admin.query('GRANT SELECT (id) ON ' + target + ' TO ?@?', [reader.user,reader.host]);
  });
  const fixturePath = path.join(dir, 'view-check-fixture.json');
  await fs.writeFile(fixturePath, JSON.stringify({ fixtureId:ownership.id, names, writer, reader, drift }), { flag:'wx', mode:0o600 });
  return fixturePath;
}

module.exports = { prepareViewCheckFixture };
