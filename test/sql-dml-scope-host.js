'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout:delay } = require('node:timers/promises');
const mysql = require('mysql2/promise');

async function runSqlDmlScopeChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  const fixture = await mysql.createConnection(config);
  const table = 'rb_dml_scope_' + randomBytes(5).toString('hex');
  let sessionId;
  const rows = async () => (await fixture.query('SELECT id,note FROM ' + table + ' ORDER BY id'))[0].map(row => [row.id, row.note]);
  try {
    await fixture.query('CREATE TABLE ' + table + ' (id INTEGER PRIMARY KEY, note VARCHAR(24)) ENGINE=InnoDB');
    await fixture.query("INSERT INTO " + table + " VALUES (1, 'first'), (2, 'second')");
    await api.disconnectMysql();
    const document = await vscode.workspace.openTextDocument({ language:'sql', content:'SELECT 1;' });
    await vscode.window.showTextDocument(document);
    await api.connectMysql(config);
    sessionId = (await api.sqlScripts.describe(document)).sessionId;
    await api.configureConsoleSession(sessionId, { readOnly:false, autocommit:false });
    const script = 'UPDATE ' + table + " SET note=:where;\nDELETE FROM " + table + ' WHERE id=99;\n' +
      'SELECT id,note FROM ' + table + ' ORDER BY id;';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), script);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const end = Date.now() + 7500;
    let warnings;
    do {
      warnings = vscode.languages.getDiagnostics(document.uri).filter(item => item.code === 'sql.dml.noWhere');
      if (warnings.length) break;
      await delay(70);
    } while (Date.now() < end);
    assert.equal(warnings.length, 1);
    assert.equal(document.getText(warnings[0].range), 'UPDATE');
    const description = await api.sqlScripts.describe(document);
    const plan = await api.sqlScripts.preview(description.id, { where:{ kind:'text', value:'reviewed' } });
    assert.deepEqual(plan.unboundedDml, [{ index:0, command:'UPDATE', hasLimit:false }]);
    await assert.rejects(api.sqlScripts.run(plan.id), /without an outer WHERE/);
    assert.deepEqual(await rows(), [[1, 'first'], [2, 'second']]);
    const run = await api.sqlScripts.run(plan.id, { allowUnboundedDml:true });
    assert.equal(run.state, 'completed');
    assert.equal(run.statements[0].result.affectedRows, 2);
    assert.deepEqual(run.statements[2].result.rows, [[1, 'reviewed'], [2, 'reviewed']]);
    assert.deepEqual(await rows(), [[1, 'first'], [2, 'second']]);
    await api.controlConsoleSession(sessionId, 'rollback');
    assert.deepEqual(await rows(), [[1, 'first'], [2, 'second']]);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    assert.deepEqual(await response.json(), { people:2, departments:1, rolledBackNames:0 });
    checks.push('The editor marked only the unfiltered UPDATE. The script dispatched no SQL before approval and rolled back the approved two-row fixture write.');
    return { engine:runtime.dbEngine, diagnostics:1, scopedDeleteExcluded:true, refusedBeforeDispatch:true,
      acknowledgedRows:2, noCommitToOtherSession:true, rollback:true };
  } finally {
    try {
      if (sessionId) await api.closeConsoleSession(sessionId);
      await api.disconnectMysql();
      await fixture.query('DROP TABLE IF EXISTS ' + table);
    } finally { await fixture.end(); }
  }
}

module.exports = { runSqlDmlScopeChecks };
