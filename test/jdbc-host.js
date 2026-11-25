'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const drivers = {
  mysql: { className: 'com.mysql.cj.jdbc.Driver', owner: 'RocketbrainDisposableOracleMysqlFixture-v1', testOptions: 'sslMode=DISABLED&allowPublicKeyRetrieval=true' },
  mariadb: { className: 'org.mariadb.jdbc.Driver', owner: 'RocketbrainDisposableMariaDbFixture-v1', testOptions: 'sslMode=disable' }
};

async function verifyJdbcDriver(api, { dialect, configPath, jar, afterOpen }) {
  const info = drivers[dialect];
  const folder = path.dirname(configPath);
  const marker = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(marker.kind, info.owner);
  assert.equal(config.host, '127.0.0.1');
  const suffix = randomBytes(5).toString('hex');
  const table = 'rb_jdbc_' + suffix;
  const fixtureJar = path.join(folder, 'rb-jdbc-' + suffix + '.jar');
  await fs.copyFile(jar, fixtureJar);
  const connection = await mysql.createConnection(config);
  let approved;
  try {
    await connection.query(`CREATE TABLE ${table} (id BIGINT PRIMARY KEY, price DECIMAL(22,6), payload VARBINARY(8), note VARCHAR(80))`);
    await connection.query(`INSERT INTO ${table} VALUES (?, ?, UNHEX(?), ?), (?, ?, UNHEX(?), NULL)`,
      ['9007199254740994', '9876543210.123450', '000AFF', '한글', '9007199254740995', '-123.000000', 'AF']);
    const proposal = await api.prepare({ name: 'Owned JDBC sample ' + suffix, jar: fixtureJar, driverClass: info.className });
    assert.match(proposal.sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(api.save(proposal.id, false), /explicitly approve/);
    approved = await api.save(proposal.id, true);
    const auth = { url: `jdbc:${dialect}://${config.host}:${config.port}/${config.database}?${info.testOptions}`,
      user: config.user, password: config.password };
    const catalog = await api.open(approved.id, auth);
    assert.ok(catalog.connection.driverVersion);
    await afterOpen?.();
    const saved = JSON.stringify(api.list());
    for (const privateValue of [auth.url, auth.password]) assert.ok(!saved.includes(privateValue));
    const object = catalog.objects.findIndex(item => item.name === table);
    assert.ok(object >= 0);
    const metadata = await api.describe(object);
    assert.deepEqual(metadata.columns.map(item => [item.name, item.jdbcType, item.nullable]), [
      ['id', -5, false], ['price', 3, true], ['payload', -3, true], ['note', 12, true]
    ]);
    const query = `SELECT id, price, payload, note FROM ${table} ORDER BY id`;
    const sample = await api.query(query, { maxRows: 1 });
    assert.equal(sample.truncated, true);
    assert.deepEqual(sample.rows, [['9007199254740994', '9876543210.123450', '0x000aff', '한글']]);
    const all = await api.query(query, { maxRows: 2 });
    assert.equal(all.truncated, false);
    assert.deepEqual(all.rows[1], ['9007199254740995', '-123.000000', '0xaf', null]);
    await assert.rejects(api.query(`DELETE FROM ${table}`), /read-only/i);
    const controller = new AbortController(), marker = 'rb_jdbc_cancel_' + suffix;
    const inFlight = api.query('SELECT /*' + marker + '*/ SLEEP(8)', { signal: controller.signal });
    inFlight.catch(() => {});
    try {
      const deadline = Date.now() + 6000;
      let visible = false;
      while (!visible && Date.now() < deadline) {
        const [rows] = await connection.query('SELECT ID FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND INFO LIKE ?', ['%' + marker + '%']);
        visible = rows.length > 0;
        if (!visible) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(visible, true);
      controller.abort();
      await assert.rejects(inFlight, /cancelled/i);
    } finally { controller.abort(); await inFlight.catch(() => {}); }
    await fs.appendFile(fixtureJar, Buffer.from([82, 66]));
    await assert.rejects(api.query(query), { code: 'ROCKETBRAIN_JDBC_JAR' });
    return { dialect, driverVersion: catalog.connection.driverVersion, metadata: true, exactCells: true,
      boundedQuery: true, cancelled: true, serverObservedActiveQuery: true,
      refusedWriteAndChangedJar: true, credentialsKeptInMemory: true, nativeEditor: Boolean(afterOpen) };
  } finally {
    api.close();
    if (approved) await api.remove(approved.id);
    await connection.query('DROP TABLE IF EXISTS ' + table);
    await connection.end();
    await fs.unlink(fixtureJar);
  }
}

async function runJdbcChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const dialect = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  const jar = process.env[dialect === 'mysql' ? 'ROCKETBRAIN_JDBC_MYSQL_TEST_JAR' : 'ROCKETBRAIN_JDBC_MARIADB_TEST_JAR'];
  assert.ok(jar);
  const commands = await vscode.commands.getCommands(true);
  for (const action of ['addDriver', 'profiles', 'newQuery', 'run', 'browse', 'close']) assert.ok(commands.includes('rocketbrain.jdbc.' + action));
  assert.ok((await vscode.languages.getLanguages()).includes('rocketbrain-jdbc'));
  const proof = await verifyJdbcDriver(api.jdbc, { dialect, configPath: runtime.dbConfigPath, jar, async afterOpen() {
    const uri = await vscode.commands.executeCommand('rocketbrain.jdbc.newQuery');
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
    assert.equal(vscode.window.activeTextEditor.document.languageId, 'rocketbrain-jdbc');
    const result = await vscode.commands.executeCommand('rocketbrain.jdbc.run');
    assert.deepEqual(result.rows, [['1']]);
    assert.equal(vscode.window.activeTextEditor.document.uri.scheme, 'rocketbrain-jdbc-output');
  } });
  checks.push('approved JDBC driver class and bytes, typed catalog and exact bounded result, cancellation');
  return proof;
}

module.exports = { verifyJdbcDriver, runJdbcChecks };
