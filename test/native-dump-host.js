'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const owners = { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1' };

async function verifyNativeRoundTrip(api, { configPath, crossConfigPath, tools, dialect }) {
  const folder = path.dirname(configPath);
  assert.equal(path.dirname(crossConfigPath), folder);
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const cross = JSON.parse(await fs.readFile(crossConfigPath, 'utf8'));
  assert.equal(owner.kind, owners[dialect]);
  assert.equal(owner.id, cross.fixtureId);
  assert.deepEqual(cross.schemas, ['rocketbrain_fixture', 'rocketbrain_related']);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const target = 'rocketbrain_related';
  const suffix = randomBytes(5).toString('hex');
  const parent = 'rb_dump_parent_' + suffix, child = 'rb_dump_child_' + suffix;
  const file = path.join(folder, 'rb-native-' + suffix + '.sql');
  const actor = await mysql.createConnection(config);
  const original = { id: '9007199254740994', body: '공백\n줄', octets: '000AFF', price: '12345.678999' };
  const didCreate = { parent: false, child: false };
  let ownedTarget = false;
  try {
    const [existing] = await actor.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [target]);
    assert.deepEqual(existing, []);
    ownedTarget = true;
    await actor.query(`CREATE TABLE ${parent} (id BIGINT PRIMARY KEY, body VARCHAR(80), octets VARBINARY(8), price DECIMAL(20,6)) ENGINE=InnoDB`);
    didCreate.parent = true;
    await actor.query(`CREATE TABLE ${child} (id INT PRIMARY KEY, parent_id BIGINT, FOREIGN KEY(parent_id) REFERENCES ${parent}(id)) ENGINE=InnoDB`);
    didCreate.child = true;
    await actor.query(`INSERT INTO ${parent} VALUES (?, ?, UNHEX(?), ?)`, Object.values(original));
    await actor.query(`INSERT INTO ${child} VALUES (?, ?)`, [5, original.id]);
    await api.connectMysql(config);
    const native = api.nativeDumps;
    const listed = await native.listTables();
    assert.equal(listed.dialect, dialect);
    assert.ok(listed.tables.includes(parent) && listed.tables.includes(child));
    const request = { tools, file, tables: [parent, child], connectionEpoch: listed.connectionEpoch };
    await assert.rejects(native.dump({ ...request, tables: [child] }), /Include all selected/);
    const backup = await native.dump(request);
    const bytes = await fs.readFile(file), raw = bytes.toString('utf8');
    assert.equal(backup.bytes, bytes.length);
    assert.doesNotMatch(raw, /\bDROP TABLE\b|\bCREATE DATABASE\b/i);
    assert.ok(!raw.includes(config.password));
    await assert.rejects(native.dump(request), /backup was not published/);
    assert.deepEqual(await fs.readFile(file), bytes);
    await assert.rejects(native.previewRestore({ tools, file }), /different empty/);
    await api.disconnectMysql();
    await api.connectMysql({ ...config, database: target });
    await assert.rejects(native.dump(request), /backup connection changed/);

    const first = await native.previewRestore({ tools, file });
    assert.equal(first.destinationDatabase, target);
    assert.equal(first.sha256, backup.sha256);
    await assert.rejects(native.restore({ reviewId: first.reviewId, destinationDatabase: target }), /approving restore/);
    await fs.appendFile(file, '\n-- changed after review\n');
    await assert.rejects(native.restore({ reviewId: first.reviewId, destinationDatabase: target, allowWrite: true }), /backup bytes changed/);
    const [afterChange] = await actor.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [target]);
    assert.deepEqual(afterChange, []);
    await fs.writeFile(file, bytes);
    const approved = await native.previewRestore({ tools, file });
    const receipt = await native.restore({ reviewId: approved.reviewId, destinationDatabase: target, allowWrite: true });
    assert.equal(receipt.state, 'restored');
    assert.equal(receipt.sha256, backup.sha256);
    const [rows] = await actor.query(`SELECT CAST(p.id AS CHAR) AS id, p.body, HEX(p.octets) AS octets, p.price
      FROM ${target}.${parent} p JOIN ${target}.${child} c ON c.parent_id=p.id WHERE c.id=5`);
    assert.deepEqual(rows, [original]);
    await assert.rejects(actor.query(`INSERT INTO ${target}.${child} VALUES (6, 2)`), /foreign key constraint/i);
    await assert.rejects(native.previewRestore({ tools, file }), /empty destination/);
    return { dialect, clientVersion: backup.toolVersion, bytes: receipt.bytes, exactReview: true,
      immutableExistingFile: true, nonemptyRejected: true, foreignKey: true, unicodeBinaryDecimal: true };
  } finally {
    await api.disconnectMysql();
    try {
      if (ownedTarget) await actor.query(`DROP TABLE IF EXISTS ${target}.${child}, ${target}.${parent}`);
      if (didCreate.child) await actor.query(`DROP TABLE ${child}`);
      if (didCreate.parent) await actor.query(`DROP TABLE ${parent}`);
      await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } finally { await actor.end(); }
  }
}

async function runNativeDumpChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const dialect = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  const bundle = dialect === 'mysql' ? await require('../scripts/integration-mysql-runtime').ensureMysqlRuntime() :
    await require('../scripts/integration-db-runtime').ensureMariaDbRuntime();
  const proof = await verifyNativeRoundTrip(api, { dialect, tools: path.dirname(bundle.server),
    configPath: runtime.dbConfigPath, crossConfigPath: path.join(path.dirname(runtime.dbConfigPath), 'cross-schema.json') });
  checks.push('installed vendor backup/restore, stale and changed backup refused, exact round trip to owned empty schema');
  return proof;
}

module.exports = { runNativeDumpChecks, verifyNativeRoundTrip };
