'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { jdbcReadback } = require('./java-source-analysis-host');

const big = '9007199254740993';
const argumentsForCall = { input: { kind: 'integer', value: big }, initial: { kind: 'integer', value: big } };
const exact = [['balance', 'OUT', '9007199254740993.00000'], ['carry', 'INOUT', '9007199254740994']];

async function fixture(run) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const directory = path.dirname(runtime.dbConfigPath);
  const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const suffix = randomBytes(5).toString('hex'), mixed = 'rb_script_out_' + suffix;
  const outputOnly = 'rb_script_only_' + suffix, table = 'rb_script_keys_' + suffix;
  const actor = await mysql.createConnection(config);
  const createMixed = increment => actor.query(`CREATE PROCEDURE ${mixed}(IN lookup BIGINT, OUT amount DECIMAL(30,5), INOUT carry BIGINT)
    READS SQL DATA SQL SECURITY INVOKER BEGIN
      SET carry=carry+${increment};
      SET amount=lookup;
      SELECT id FROM ${table} WHERE id=lookup;
    END`);
  try {
    await actor.query('CREATE TABLE ' + table + '(id BIGINT PRIMARY KEY) ENGINE=InnoDB');
    await actor.execute('INSERT INTO ' + table + ' VALUES(?)', [big]);
    await createMixed(1);
    await actor.query(`CREATE PROCEDURE ${outputOnly}(OUT message VARCHAR(40)) NO SQL SQL SECURITY INVOKER
      BEGIN SET message='typed output'; END`);
    const sql = `SELECT CONNECTION_ID(); CALL ${mixed}(:input,@balance,:initial);
      CALL ${outputOnly}(@notice); SELECT CONNECTION_ID();`;
    const [[{ version }]] = await actor.query('SELECT VERSION() version');
    const jdbc = await jdbcReadback();
    const replace = async () => {
      await actor.query('DROP PROCEDURE ' + mixed);
      await createMixed(2);
    };
    return { engine: runtime.dbEngine, version, jdbc, ...await run({ config, sql, mixed, outputOnly, replace }) };
  } finally {
    try {
      for (const procedure of [mixed, outputOnly]) await actor.query('DROP PROCEDURE IF EXISTS ' + procedure);
      await actor.query('DROP TABLE IF EXISTS ' + table);
    } finally { await actor.end(); }
  }
}

function verifyResult(report) {
  assert.equal(report.state, 'completed', JSON.stringify(report.statements.map(item => item.error)));
  assert.equal(report.completed, 4);
  const [start, mixed, standalone, finish] = report.statements.map(item => item.result);
  assert.deepEqual(finish.rows, start.rows);
  assert.deepEqual(mixed.resultSets[0].rows, [[big]]);
  assert.deepEqual(mixed.resultSets[1].rows.map(([label, mode, , value]) => [label, mode, value]), exact);
  assert.deepEqual(standalone.outputParameters.map(({ label, mode, value }) => [label, mode, value]),
    [['notice', 'OUT', 'typed output']]);
  assert.equal(report.stateAfter.connected, true);
  assert.equal(report.stateAfter.readOnly, true);
  return { exactBigintAndDecimal: true, outputOnly: true, sameConsole: true };
}

async function verifyScriptOutputsBackend() {
  return fixture(async ({ config, sql, mixed, outputOnly, replace }) => {
    const db = new MysqlService(config);
    try {
      await assert.rejects(db.previewScript(`CALL ${mixed}(:input,:initial,:input);`, { parameters: argumentsForCall }), /signature/);
      await assert.rejects(db.previewScript(`CALL ${outputOnly}(@@notice);`), /distinct @names/);
      const plan = await db.previewScript(sql, { parameters: argumentsForCall });
      assert.deepEqual(plan.statements[1].call.slots, [null, 'balance', null]);
      assert.deepEqual(plan.statements[1].call.outputParameters.map(({ label, name, mode }) => [label || name, mode]),
        [['balance', 'OUT'], ['carry', 'INOUT']]);
      assert.ok(!JSON.stringify(plan).includes(big));
      const report = verifyResult(await db.runScript({ reviewId: plan.reviewId }));
      const stale = await db.previewScript(sql, { parameters: argumentsForCall });
      await replace();
      await assert.rejects(db.runScript({ reviewId: stale.reviewId }), /changed after script review/);
      await db.setReadOnly(false);
      const variables = await db.query('SELECT @balance,@notice');
      assert.deepEqual(variables.rows, [[null, null]]);
      return { ...report, privateSlots: true, changedDefinitionRefused: true };
    } finally { await db.dispose(); }
  });
}

async function runScriptOutputsChecks(api, vscode, checks) {
  return fixture(async ({ config, sql, replace }) => {
    await api.connectMysql(config);
    let sessionId;
    try {
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
      const prepare = async () => {
        const description = await api.sqlScripts.describe(document);
        sessionId = description.sessionId;
        return api.sqlScripts.preview(description.id, argumentsForCall);
      };
      const review = await prepare();
      const report = await api.sqlScripts.run(review.id);
      const verified = verifyResult(report);
      const opened = await api.sqlScripts.openStatement(report.resultId, 1, 1);
      assert.equal(opened.executedSql, false);
      assert.deepEqual(api.results().find(item => item.id === opened.resultId).result.rows.map(([label, mode, , value]) =>
        [label, mode, value]), exact);
      assert.equal((await api.sqlScripts.openStatement(report.resultId, 1, 1)).resultId, opened.resultId);
      const stale = await prepare();
      await replace();
      await assert.rejects(api.sqlScripts.run(stale.id), /changed after script review/);
      await api.configureConsoleSession(sessionId, { readOnly: false });
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        'SELECT @balance,@notice;');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      const variables = await api.sqlScripts.describe(document);
      assert.equal(variables.sessionId, sessionId);
      const selected = await api.sqlScripts.run((await api.sqlScripts.preview(variables.id)).id);
      assert.deepEqual(selected.statements[0].result.rows, [[null, null]]);
      checks.push('The installed read-only batch captured OUT and INOUT values as a separate result while leaving caller variables untouched.');
      return { ...verified, privateSlots: true, nativeOutputCapture: true, noReplay: true, changedDefinitionRefused: true };
    } finally {
      if (sessionId) await api.closeConsoleSession(sessionId);
      await api.disconnectMysql();
    }
  });
}

if (require.main === module) verifyScriptOutputsBackend().then(value => console.log(JSON.stringify(value)),
  error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { verifyScriptOutputsBackend, runScriptOutputsChecks };
