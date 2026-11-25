'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { owned } = require('./schema-stored-diff-host');

const decimal = '9007199254740993.125000';
const largeInteger = '18446744073709551615';
const orderedVector = '[1.5,-2.25,0.125]';
const utf8mb4 = '한글 🎯 café';
const zonedTimestamp = '2025-01-15 23:59:58.123456';
const expectedEpoch = '1736965798.123456';
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };

async function verifyMySqlNativeVector(adapter) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const table = 'rb_vector_' + randomBytes(5).toString('hex');
  const hasVector = runtime.dbEngine === 'mysql' && version.startsWith('9.');
  const spring = async () => {
    const endpoint = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  let connected = false;
  try {
    await spring();
    const valueType = hasVector ? 'VECTOR(3)' : 'VARBINARY(12)';
    await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, value ' + valueType +
      ', exact_number DECIMAL(25,6), big_number BIGINT UNSIGNED, label VARCHAR(64) CHARACTER SET utf8mb4,' +
      ' observed_at TIMESTAMP(6)) ENGINE=InnoDB');
    await actor.query("SET SESSION time_zone = '+05:30'");
    await actor.execute('INSERT INTO ' + table + ' VALUES (1,' + (hasVector ? 'STRING_TO_VECTOR(?)' : '?') +
      ',?,?,?,?),(2,NULL,NULL,NULL,NULL,NULL)', [hasVector ? orderedVector : Buffer.from('001122', 'hex'),
      decimal, largeInteger, utf8mb4, zonedTimestamp]);
    await adapter.connect(config);
    connected = true;
    await adapter.profileTest?.(config, version);
    const metadata = await adapter.catalog();
    assert.equal(metadata.database, config.database);
    const column = metadata.tables.find(item => item.name === table).columns.find(item => item.name === 'value');
    assert.equal(column.type.toLowerCase(), valueType.toLowerCase());
    assert.equal(column.nullable, true);
    const context = await adapter.select('SELECT VERSION(), @@SESSION.sql_mode, DATABASE()');
    assert.equal(context.rows[0][0], version);
    assert.equal(typeof context.rows[0][1], 'string');
    assert.equal(context.rows[0][2], config.database);

    const select = 'SELECT id,value,exact_number,big_number,label,CAST(UNIX_TIMESTAMP(observed_at) AS CHAR) FROM ' + table;
    const ordinary = await adapter.select(select + ' ORDER BY id');
    const prepared = await adapter.select(select + ' WHERE id >= ' + adapter.placeholder + ' ORDER BY id', true);
    const expected = [[1, hasVector ? orderedVector : '0x001122', decimal, largeInteger, utf8mb4, expectedEpoch],
      [2, null, null, null, null, null]];
    for (const result of [ordinary, prepared]) {
      assert.equal(result.truncated, false);
      assert.deepEqual(result.rows, expected);
      assert.equal(result.fields[1].originalName, 'value');
      assert.equal(result.fields[1].type === 242, hasVector);
    }
    if (hasVector) {
      const [[server]] = await actor.query('SELECT VECTOR_TO_STRING(value) observed FROM ' + table + ' WHERE id=1');
      assert.deepEqual(JSON.parse(ordinary.rows[0][1]), JSON.parse(server.observed));
    }
    await spring();
    return {
      engine: runtime.dbEngine, serverVersion: version, mysql9NativeVector: hasVector, vectorProtocolType: hasVector ? 242 : null,
      orderedFloat32Verified: hasVector, unchangedBinaryFallback: !hasVector, textProtocolSqlNull: true,
      preparedProtocolSqlNull: true, exactDecimalAndUnsignedBigInt: true, utf8mb4AndZonedTimestamp: true,
      catalogType: column.type.toLowerCase(), wrongPasswordRefused: Boolean(adapter.profileTest),
      sqlModeObserved: true, springJdbcUnchanged: true, nativeResultCapture: Boolean(adapter.profileTest)
    };
  } finally {
    try { if (connected) await adapter.disconnect(); }
    finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + table); }
      finally { await actor.end(); }
    }
  }
}

async function verifyMysqlNativeVectorBackend() {
  let db;
  return verifyMySqlNativeVector({
    placeholder: '?',
    connect(config) { db = new MysqlService(config); },
    disconnect() { return db.dispose(); },
    catalog() { return db.metadata(); },
    select(sql, prepared) { return db.query(sql, prepared ? { values: [1] } : {}); }
  });
}

async function runMysqlNativeVectorChecks(api, vscode, checks) {
  const result = await verifyMySqlNativeVector({
    placeholder: ':first_id',
    connect: config => api.connectMysql(config),
    disconnect: () => api.disconnectMysql(),
    catalog: () => api.catalogSnapshot(),
    async profileTest(config, version) {
      const { host, port, user, password, database } = config;
      const profile = { name: 'Owned MySQL compatibility check', host, port, user, database, tls: { mode: 'disabled' } };
      const report = await api.dbConnections.test({ profile, password });
      assert.equal(report.connected, true);
      assert.equal(report.serverVersion, version);
      assert.equal(report.database, database);
      await assert.rejects(api.dbConnections.test({ profile, password: randomBytes(32).toString('hex') }),
        { code: 'ROCKETBRAIN_PROFILE', message: /connection could not be verified/i });
    },
    async select(sql, prepared) {
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql + ';' });
      await vscode.window.showTextDocument(document);
      const description = await api.sqlScripts.describe(document);
      try {
        const review = await api.sqlScripts.preview(description.id, prepared ? { first_id: { kind: 'integer', value: '1' } } : []);
        const run = await api.sqlScripts.run(review.id);
        assert.equal(run.state, 'completed');
        const capture = await api.sqlScripts.openStatement(run.resultId, 0);
        assert.equal(capture.executedSql, false);
        const rowSet = api.results().find(item => item.id === capture.resultId);
        assert.deepEqual(rowSet.result.rows, run.statements[0].result.rows);
        return rowSet.result;
      } finally {
        await api.closeConsoleSession(description.sessionId);
      }
    }
  });
  checks.push('The installed profile accepted the real credentials, rejected a wrong password and verified SQL mode, utf8mb4, time zone, exact numeric output and SQL NULL.');
  if (result.mysql9NativeVector) checks.push('Native MySQL 9 VECTOR columns kept ordered float32 data in direct and prepared queries, and NULL remained null.');
  return result;
}

module.exports = { runMysqlNativeVectorChecks, verifyMysqlNativeVectorBackend };
if (require.main === module) {
  verifyMysqlNativeVectorBackend().then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
