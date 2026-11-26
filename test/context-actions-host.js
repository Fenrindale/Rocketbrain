'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

const commands = plan => plan.actions.map(item => item.command);

async function runContextActionsChecks(api, vscode, checks) {
  const service = api.contextActions;
  assert.ok(service?.prepare && service?.dispatch);
  const installed = await vscode.commands.getCommands(true);
  for (const command of ['rocketbrain.contextActions', 'rocketbrain.contextActions.results']) assert.ok(installed.includes(command));
  const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api, root);
  const java = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'src/main/java/fixture/boot/FixtureApplication.java')));
  const source = await vscode.window.showTextDocument(java, { preview: false });
  const javaPlan = await until(async () => {
    const plan = await service.prepare('editor');
    return plan.surface === 'jvm' ? plan : undefined;
  }, 10000);
  assert.ok(commands(javaPlan).includes('rocketbrain.java.fileStructure'));
  assert.ok(commands(javaPlan).includes('rocketbrain.spring.beans'));
  assert.ok(!commands(javaPlan).includes('rocketbrain.runQuery'));
  const symbols = await api.java.structure.inspect({ document: java, group: 'all', position: source.selection.active });
  assert.ok(symbols.members.some(member => member.label === 'FixtureApplication'));
  const workspace = await service.prepare('workspace');
  assert.ok(commands(workspace).includes('rocketbrain.java.workbench.tasks'));
  assert.ok(commands(workspace).includes('workbench.action.openGlobalKeybindings'));
  assert.ok(!commands(workspace).includes('rocketbrain.java.fileStructure'));
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  assert.equal(database.host, '127.0.0.1');
  assert.match(database.database, /^[a-z_]+$/u);
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const file = path.join(root, 'rb-context-action-' + randomBytes(5).toString('hex') + '.sql');
  const uri = vscode.Uri.file(file);
  let created = false, connected = false;
  try {
    await fs.writeFile(file, 'SELECT 42 AS answer, VERSION() AS server;\n', { flag: 'wx' });
    created = true;
    await api.connectMysql(database);
    connected = true;
    const sql = await vscode.workspace.openTextDocument(uri);
    assert.equal(sql.languageId, 'sql');
    await vscode.window.showTextDocument(sql, { preview: false });
    await assert.rejects(service.dispatch(javaPlan, 'rocketbrain.java.fileStructure'), /editor, connection or result changed/);
    const sqlPlan = await until(async () => {
      const plan = await service.prepare('editor');
      return plan.surface === 'sql' ? plan : undefined;
    }, 10000);
    assert.ok(commands(sqlPlan).includes('rocketbrain.sql.format'));
    assert.ok(commands(sqlPlan).includes('rocketbrain.sql.explainVisual'));
    assert.ok(!commands(sqlPlan).includes('rocketbrain.java.fileStructure'));
    const run = await service.dispatch(sqlPlan, 'rocketbrain.runQuery');
    const captured = api.results().find(item => item.id === run.result);
    assert.equal(String(captured.result.rows[0][0]), '42');
    const server = captured.result.rows[0][1];
    assert.match(server, spring.dbEngine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
    await vscode.commands.executeCommand('rocketbrain.focusQueryResults');
    const resultPlan = await until(async () => {
      const plan = await service.prepare('results');
      return commands(plan).includes('rocketbrain.results.returnToQuery') ? plan : undefined;
    }, 12000);
    assert.equal(resultPlan.surface, 'results');
    assert.deepEqual(commands(resultPlan).slice(0, 2), ['rocketbrain.results.returnToQuery', 'rocketbrain.results.copyTsv']);
    assert.equal(api.resultActionContext().result, run.result);
    const restored = await service.dispatch(resultPlan, 'rocketbrain.results.returnToQuery');
    assert.equal(restored.command, 'rocketbrain.results.returnToQuery');
    assert.equal(vscode.window.activeTextEditor?.document, sql);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('Installed Context Actions focused the active Spring Java source, ran SQL against the live database, then returned from the selected captured result to its own editor.');
    return { jvm: javaPlan.surface, workspace: workspace.surface, sql: sqlPlan.surface, results: resultPlan.surface,
      server, result: Number(captured.result.rows[0][0]), sourceAction: 'File Structure', restoredQueryEditor: true, staleEditorRefused: true, jdbc };
  } finally {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input?.uri?.scheme === 'file' && !path.relative(tab.input.uri.fsPath, file));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (connected) await api.disconnectMysql();
    } finally {
      if (created) await fs.rm(file, { force: true });
    }
  }
}

module.exports = { runContextActionsChecks };
