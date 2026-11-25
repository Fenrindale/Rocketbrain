'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const ownerKinds = {
  mysql: 'RocketbrainDisposableOracleMysqlFixture-v1',
  mariadb: 'RocketbrainDisposableMariaDbFixture-v1'
};
const decimal = { kind: 'decimal', value: '1234567890123456789.123456' };
const integer = { kind: 'integer', value: '9007199254740993' };

async function verifyPackageWorkflow(runtime, { connect, probe, reviewDocument, openResult, calls }) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  const engine = Object.keys(ownerKinds).find(key => ownerKinds[key] === owner.kind);
  assert.ok(engine, 'Use an owned MySQL/MariaDB fixture');
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.ok(Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535);
  const raw = await mysql.createConnection(config);
  const suffix = randomBytes(5).toString('hex');
  const packageName = 'rb_ora_' + suffix, psm = 'rb_psm_' + suffix, audit = 'rb_ora_audit_' + suffix;
  const standalone = 'rb_proc_' + suffix;
  const target = { kind: 'package', schema: config.database, name: packageName };
  const member = (kind, name, pkg = packageName) => ({ kind: 'package-' + kind, schema: config.database, package: pkg, name });
  const definition = addition => 'CREATE PACKAGE BODY ' + packageName + ' AS ' +
    'PROCEDURE sum_amount(v IN NUMBER(32,6), running_total IN OUT NUMBER(32,6), note OUT VARCHAR2(20)) IS ' +
    'BEGIN running_total := running_total + v; note := NULL; END; ' +
    'FUNCTION hidden(v IN NUMBER(32,6)) RETURN NUMBER(32,6) IS BEGIN RETURN v; END; ' +
    'FUNCTION exact_amount(v IN NUMBER(32,6)) RETURN NUMBER(32,6) IS n INTEGER; ' +
    'BEGIN SELECT COUNT(*) INTO n FROM rb_spring_person; IF n = 2 THEN RETURN hidden(v) + ' + addition + '; END IF; RETURN NULL; END; ' +
    'FUNCTION empty_amount() RETURN NUMBER(32,6) IS BEGIN RETURN NULL; END; ' +
    'FUNCTION attempts_write() RETURN INTEGER IS BEGIN INSERT INTO ' + audit + ' VALUES(1); RETURN 1; END; ' +
    'END ' + packageName;
  async function approved(callTarget, inputs = []) {
    const draft = await calls.inspect(callTarget);
    return calls.run(calls.prepare(draft.id, inputs).id, { approved: true });
  }
  try {
    const spring = await probe();
    assert.equal(spring.people, 2);
    await connect(config);
    if (engine === 'mysql') {
      await assert.rejects(calls.listPackages({}), /require MariaDB/);
      await assert.rejects(calls.inspect(member('function', 'exact_amount')), /require MariaDB/);
      await raw.query('CREATE PROCEDURE ' + standalone + ' (IN v BIGINT, OUT answer BIGINT) BEGIN SET answer=v; SELECT v AS record_id; END');
      const report = await approved({ kind: 'procedure', schema: config.database, name: standalone }, [integer]);
      assert.equal(report.definitionCheck, 'transaction-pinned');
      assert.deepEqual(report.resultSets[0].rows, [[integer.value]]);
      assert.equal(report.outputParameters[0].value, integer.value);
      assert.deepEqual(await probe(), spring);
      return { engine, packageGate: true, standaloneTypedProcedure: true, spring };
    }

    const [[{ sqlMode }]] = await raw.query('SELECT @@SESSION.sql_mode AS sqlMode');
    await raw.query('CREATE TABLE ' + audit + ' (id INT) ENGINE=InnoDB');
    await raw.query('SET SESSION sql_mode=ORACLE');
    await raw.query('CREATE PACKAGE ' + packageName + ' SQL SECURITY INVOKER AS ' +
      'PROCEDURE sum_amount(v IN NUMBER(32,6), running_total IN OUT NUMBER(32,6), note OUT VARCHAR2(20)); ' +
      'FUNCTION exact_amount(v IN NUMBER(32,6)) RETURN NUMBER(32,6); FUNCTION empty_amount() RETURN NUMBER(32,6); ' +
      'FUNCTION attempts_write() RETURN INTEGER; END ' + packageName);
    await raw.query(definition('0.000001'));
    await raw.query('SET SESSION sql_mode=?', [sqlMode]);
    assert.deepEqual((await calls.listPackages({ prefix: packageName })).items, [target]);
    const browse = await calls.inspectPackage(target);
    assert.equal(browse.syntax, 'oracle');
    assert.deepEqual(browse.members.map(item => [item.kind, item.name, item.supported]), [
      ['procedure', 'sum_amount', true], ['function', 'exact_amount', true],
      ['function', 'empty_amount', true], ['function', 'attempts_write', true]
    ]);
    assert.match(browse.body.source, /FUNCTION hidden/);
    await assert.rejects(calls.inspect(member('function', 'hidden')), /unambiguous public function/);
    const draft = await calls.inspect(member('function', 'exact_amount'));
    const plan = calls.prepare(draft.id, [decimal]);
    assert.deepEqual(plan.returns, { kind: 'decimal', type: 'NUMBER(32,6)' });
    assert.equal(plan.sql, 'SELECT ' + [config.database, packageName, 'exact_amount'].map(name => String.fromCharCode(96) + name + String.fromCharCode(96)).join('.') + '(?) AS return_value');
    const review = (await reviewDocument(plan.uri)).replaceAll('\r\n', '\n');
    assert.match(review, /Oracle PL\/SQL/);
    assert.match(review, /read-only server transaction/);
    assert.ok(draft.packageSources.every(record => review.includes(record.source.replaceAll('\r\n', '\n'))));
    assert.ok(!review.includes(decimal.value));
    await assert.rejects(calls.run(plan.id), /Approve the exact/);
    const result = await calls.run(plan.id, { approved: true });
    assert.deepEqual(result.resultSets[0].rows, [['1234567890123456789.123457']]);
    assert.equal(result.readOnlyInvocation, true);
    assert.equal(result.callerTransactionCommitted, false);
    assert.equal(result.definitionCheck, 'before-and-after');
    assert.equal((await openResult({ resultId: result.resultId, index: 0 })).executedSql, false);
    await assert.rejects(calls.run(plan.id, { approved: true }), /expired or the connection changed/);
    assert.deepEqual((await approved(member('function', 'empty_amount'))).resultSets[0].rows, [[null]]);
    const procedure = await approved(member('procedure', 'sum_amount'), [{ ...decimal, value: '0.000001' }, decimal]);
    assert.deepEqual(procedure.outputParameters.map(item => item.value), ['1234567890123456789.123457', null]);
    await assert.rejects(approved(member('function', 'attempts_write')), { causeCode: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' });
    assert.equal(Number((await raw.query('SELECT COUNT(*) AS count FROM ' + audit))[0][0].count), 0);

    const stale = calls.prepare((await calls.inspect(member('function', 'exact_amount'))).id, [decimal]);
    await raw.query('SET SESSION sql_mode=ORACLE');
    await raw.query('DROP PACKAGE BODY ' + packageName);
    await raw.query(definition('0.000002'));
    await raw.query('SET SESSION sql_mode=?', [sqlMode]);
    await assert.rejects(calls.run(stale.id, { approved: true }), /definition or input signature changed/);
    await raw.query('CREATE PACKAGE ' + psm + ' FUNCTION add_ten(IN v INTEGER) RETURNS INTEGER; END');
    await raw.query('CREATE PACKAGE BODY ' + psm + ' FUNCTION add_ten(IN v INTEGER) RETURNS INTEGER BEGIN RETURN v+10; END; END');
    assert.equal((await calls.inspectPackage({ ...target, name: psm })).syntax, 'psm');
    assert.deepEqual((await approved(member('function', 'add_ten', psm), [{ ...integer, value: '2' }])).resultSets[0].rows, [[12]]);
    assert.deepEqual(await probe(), spring);
    return { engine, storedSyntax: ['oracle', 'psm'], exactSources: 2, publicProcedures: 1, publicFunctions: 3,
      privateMemberExcluded: true, exactDecimalAndNull: true, procedureInOut: true, boundScalar: true,
      approvalAndNoReplay: true, rollbackWithWriteRejected: true, staleBodyRejected: true, spring };
  } finally {
    try {
      if (engine === 'mariadb') {
        await raw.query('DROP PACKAGE IF EXISTS ' + packageName);
        await raw.query('DROP PACKAGE IF EXISTS ' + psm);
        await raw.query('DROP TABLE IF EXISTS ' + audit);
      } else await raw.query('DROP PROCEDURE IF EXISTS ' + standalone);
    } finally { await raw.end(); }
  }
}

async function runOraclePackageChecks(api, vscode, checks) {
  const configPath = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
  const runtime = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.reviewPackageCall'));
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    return response.json();
  };
  checks.oraclePackageCalls = await verifyPackageWorkflow(runtime, {
    connect: config => api.connectMysql(config),
    probe,
    calls: api.routineCalls,
    async reviewDocument(uri) {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      return document.getText();
    },
    openResult: target => vscode.commands.executeCommand('rocketbrain.db.openProcedureResult', target)
  });
}

module.exports = { runOraclePackageChecks, verifyPackageWorkflow };
