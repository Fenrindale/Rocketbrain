'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function runSqlActivityLogChecks(api, vscode, checks) {
  const activity = api.activityLog;
  assert.ok(activity);
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const owner = await readJson(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const previous = activity.snapshot().enabled;
  const marker = randomBytes(6).toString('hex');
  const literal = 'private_literal_' + marker;
  const parameter = 'private_parameter_' + marker;
  const column = 'private_missing_column_' + marker;
  const query = async sql => {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    await vscode.window.showTextDocument(document);
    return { document, result: await vscode.commands.executeCommand('rocketbrain.runQuery') };
  };
  let scriptSession, cancelSession;
  try {
    await activity.setEnabled(false);
    await api.connectMysql(config);
    await api.databaseCatalog();
    assert.equal(activity.snapshot().entries.length, 0, 'Real metadata was omitted while logging was disabled.');
    await activity.setEnabled(true);
    const opened = await vscode.commands.executeCommand('rocketbrain.sql.activityLog');
    assert.equal(opened.enabled, true);
    const catalog = await api.databaseCatalog();
    assert.ok(catalog.tables.some(table => table.name === 'rb_spring_person'));
    const metadataCount = activity.snapshot().entries.filter(row => row.category === 'metadata').length;
    assert.ok(metadataCount >= 5);

    await query("SELECT '" + literal + "' AS private_value FROM rb_spring_person LIMIT 1;");
    assert.equal(api.results().at(-1).result.rows[0][0], literal);
    const session = api.sessionState();
    await query('SELECT ' + column + ' FROM rb_spring_person;');
    assert.equal(api.results().at(-1).state, 'error');

    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT :bound AS private_value;' });
    await vscode.window.showTextDocument(document);
    const script = await api.sqlScripts.describe(document);
    scriptSession = script.sessionId;
    const preview = await api.sqlScripts.preview(script.id, { bound: { kind: 'text', value: parameter } });
    const result = await api.sqlScripts.run(preview.id);
    assert.equal(result.statements[0].result.rows[0][0], parameter);
    await api.configureConsoleSession(scriptSession, { readOnly: false, autocommit: false });
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      'UPDATE rb_spring_person SET display_name = :bound WHERE id = -1;');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const write = await api.sqlScripts.describe(document);
    const plannedWrite = await api.sqlScripts.preview(write.id, { bound: { kind: 'text', value: parameter } });
    const updated = await api.sqlScripts.run(plannedWrite.id);
    assert.equal(updated.statements[0].result.affectedRows, 0);
    await api.controlConsoleSession(scriptSession, 'rollback');

    const sleep = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT SLEEP(4);' });
    await vscode.window.showTextDocument(sleep);
    const inflight = vscode.commands.executeCommand('rocketbrain.runQuery');
    let running;
    for (let attempt = 0; attempt < 80 && !running; attempt++) {
      running = activity.snapshot().entries.find(row => row.category === 'query' && row.status === 'running');
      if (!running) await new Promise(resolve => setTimeout(resolve, 35));
    }
    try {
      assert.ok(running, 'Found the actual dispatched query while it was running.');
      cancelSession = api.sessionState().id;
      await vscode.commands.executeCommand('rocketbrain.cancelQuery');
    } finally { await inflight; }
    assert.equal(activity.snapshot().entries.find(row => row.id === running.id)?.status, 'cancelled');
    await query('SELECT COUNT(*) FROM rb_spring_person;');
    const entries = activity.snapshot().entries;
    const recent = entries.find(row => row.category === 'query' && row.status === 'succeeded');
    assert.notEqual(recent.id, running.id);
    assert.ok(entries.some(row => row.category === 'query' && row.status === 'failed'));
    assert.ok(entries.some(row => row.category === 'script' && row.operation === 'UPDATE' && row.status === 'succeeded'));
    assert.ok(entries.some(row => row.category === 'script' && row.operation === 'SELECT' && row.status === 'succeeded'));
    assert.equal(new Set(entries.map(row => row.id)).size, entries.length);
    assert.equal(new Set(entries.map(row => row.connection)).size, 1);
    assert.ok(new Set(entries.map(row => row.session)).size > 2);
    const allowed = ['category', 'connection', 'durationMs', 'id', 'operation', 'session', 'startedAt', 'status'];
    assert.ok(entries.every(row => Number.isFinite(row.durationMs) && row.durationMs >= 0 &&
      Number.isFinite(Date.parse(row.startedAt)) && Object.keys(row).sort().join(',') === allowed.join(',')));
    const log = JSON.stringify(entries);
    for (const secret of [literal, parameter, column, 'rb_spring_person', 'private_value', config.password, config.database, session.id].filter(Boolean)) {
      assert.equal(log.includes(secret), false, 'Sensitive query or connection fields are absent from the activity log.');
    }
    await activity.setEnabled(false);
    assert.equal(activity.snapshot().entries.length, 0);
    await query('SELECT 2;');
    assert.equal(activity.snapshot().entries.length, 0);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6000) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('SQL Activity records actual console and script dispatch, metadata, duration, server failure and cancellation while omitting literals, parameters, identifiers and connection configuration.');
    const output = path.join(__dirname, '../test-output', (process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.33') +
      '-native-sql-activity-' + runtime.dbEngine + '.json');
    const evidence={ version: process.env.ROCKETBRAIN_RELEASE_VERSION || '0.33.0', engine: runtime.dbEngine,
      nativeWebview: true, metadataCount, recordedRequests: entries.length, consoleQuery: true, parameterizedScript: true,
      realDmlDispatch: true, actualCancellation: true, serverErrorStatus: true, correlationIdsUnique: true,
      secretFieldsAbsent: true, optedIn: true, disabledClears: true, isolation };
    await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');
    return evidence;
  } finally {
    await activity.setEnabled(previous);
    activity.close();
    if (scriptSession) await api.closeConsoleSession(scriptSession);
    if (cancelSession) await api.closeConsoleSession(cancelSession);
    await vscode.commands.executeCommand('rocketbrain.useDemo');
  }
}

module.exports = { runSqlActivityLogChecks };
