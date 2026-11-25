'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MysqlService } = require('../src/db/mysql');
const { prepareLocalSqlRequest, executeLocalSqlRequest } = require('../src/db/local-sql-assistant');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

const selections = [{ table: 'rb_spring_person', columns: ['id', 'display_name'] }];
const prompt = 'List the display names of the people in alphabetical order. Return only the display_name column.';
const privateMarker = 'fixture-do-not-share';
const explanationInput = `SELECT display_name FROM rb_spring_person WHERE display_name <> '${privateMarker}' AND id > 987654321 /* ${privateMarker} */;`;

async function fixtureConfig() {
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const folder = path.dirname(await fs.realpath(spring.dbConfigPath));
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1','RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(path.basename(folder), owner.id);
  const configuration = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  assert.equal(configuration.host, '127.0.0.1');
  assert.equal(configuration.database, 'rocketbrain_fixture');
  assert.equal(spring.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  return configuration;
}

async function verifyLocalSqlModel(server, config) {
  const database = new MysqlService(config);
  try {
    const catalog = await database.metadata();
    const approve = (mode, input) => prepareLocalSqlRequest({ endpoint: server.endpoint, model: server.model, catalog, selections, mode, input });
    const prepared = approve('draft', prompt);
    assert.equal(prepared.preview.tables.length, 1);
    assert.deepEqual(prepared.preview.tables[0].columns.map(column => column.name), ['id', 'display_name']);
    assert.ok(!JSON.stringify(prepared.payload).includes(config.password));
    const draft = await executeLocalSqlRequest(prepared);
    assert.equal(draft.execution, 'not-run');
    assert.deepEqual(draft.tables, ['rb_spring_person']);
    assert.ok(draft.explanation.length > 5);
    const explained = approve('explain', explanationInput);
    for (const outside of [privateMarker, '987654321', 'department_id', config.password]) assert.ok(!JSON.stringify(explained.payload).includes(outside));
    assert.equal(explained.preview.sql.split('?').length - 1, 2);
    const explanation = await executeLocalSqlRequest(explained);
    assert.equal(explanation.execution, 'not-run');
    assert.match(explanation.explanation, /display|name|people|person/i);
    await database.openSession('default', { readOnly: true });
    const expected = await database.query('SELECT display_name FROM rb_spring_person ORDER BY display_name');
    const manualReview = await database.query(draft.sql);
    assert.equal(manualReview.rows.length, 2);
    assert.deepEqual(manualReview.rows, expected.rows);
    return { engine: catalog.dialect, localModel: true, draftResolved: true, explanationReturned: true, literalRedaction: true,
      activeScopeOnly: true, noAutomaticSqlExecution: true, manualReadOnlyExecutionRows: manualReview.rows.length,
      jdbc: await jdbcReadback() };
  } finally { await database.dispose(); }
}

async function runLocalSqlAssistantChecks(api, vscode, checks) {
  const config = await fixtureConfig();
  const model = await startLocalModel();
  const settings = vscode.workspace.getConfiguration('rocketbrain.localSqlAssistant');
  const old = Object.fromEntries(['endpoint','model'].map(key => [key, settings.inspect(key)?.workspaceValue]));
  try {
    for (const key of ['endpoint','model']) await settings.update(key, model[key], vscode.ConfigurationTarget.Workspace);
    await api.connectMysql(config);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.localSqlAssistant.draft'));
    assert.ok(commands.includes('rocketbrain.localSqlAssistant.explain'));
    const preview = api.localSqlAssistant.preview({ mode: 'explain', input: explanationInput, selections });
    assert.equal(preview.endpoint, model.endpoint);
    assert.equal(preview.model, model.model);
    assert.ok(!JSON.stringify(preview).includes(privateMarker));
    assert.deepEqual(preview.input.tables[0].columns.map(column => column.name), ['id', 'display_name']);
    const result = await verifyLocalSqlModel(model, config);
    checks.push('The packaged local SQL commands and redacted catalog preview were registered. Genuine loopback inference produced a read-only draft matching the Spring fixture query.');
    return { ...result, nativePreview: true };
  } finally {
    try {
      await api.disconnectMysql();
      for (const key of ['endpoint','model']) await settings.update(key, old[key], vscode.ConfigurationTarget.Workspace);
    } finally { await model.close(); }
  }
}

if (require.main === module) fixtureConfig().then(async config => {
  const model = await startLocalModel();
  try { console.log(JSON.stringify(await verifyLocalSqlModel(model, config))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { runLocalSqlAssistantChecks, verifyLocalSqlModel, fixtureConfig };
