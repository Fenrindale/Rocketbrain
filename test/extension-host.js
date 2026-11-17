'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async function () {
  const checks = [];
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension, 'Development extension is registered');
  const api = await extension.activate();
  const phase = async (name, work, timeoutMs = 240000) => {
    console.log('[Rocketbrain test] starting ' + name);
    let timer;
    try {
      await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ' exceeded ' + timeoutMs + 'ms')), timeoutMs); })]);
      console.log('[Rocketbrain test] passed ' + name);
    } finally { clearTimeout(timer); }
  };
  try {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('workbench.view.extension.rocketbrain-query-panel'), 'Result panel is registered as a native panel container');
  checks.push('Rocketbrain activates from the selected extension path in an isolated VS Code profile with other extensions disabled.');
  assert.deepEqual(api.schema().map(t => t.name).sort(), ['people', 'projects', 'tasks']);
  checks.push('Bundled SQL worker and WASM load and expose the real demo schema.');
  await vscode.commands.executeCommand('rocketbrain.openConsole');
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor && editor.document.languageId === 'sql', 'SQL editor retains focus');
  await vscode.commands.executeCommand('rocketbrain.runQuery');
  const first = api.results().at(-1);
  assert.equal(first.state, 'done'); assert.equal(first.result.rowCount, 3);
  assert.ok(first.result.columns.includes('name'));
  checks.push('Open Console and Run Query produce database results through registered commands.');
  const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', editor.document.uri, new vscode.Position(1, 7));
  assert.ok(completion.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'name'));
  checks.push('SQL completion includes the active connection schema.');
  const errorDoc = await vscode.workspace.openTextDocument({ language: 'sql', content: 'DELETE FROM projects;' });
  await vscode.window.showTextDocument(errorDoc);
  await vscode.commands.executeCommand('rocketbrain.runQuery');
  assert.equal(api.results().at(-1).state, 'error');
  assert.equal((await api.queryDemo('SELECT count(*) AS n FROM projects')).rows[0][0], 3);
  checks.push('A write fails visibly and leaves the sample data unchanged.');
  await vscode.commands.executeCommand('rocketbrain.openTable', 'tasks');
  assert.equal(api.results().at(-1).result.rowCount, 10);
  assert.ok(api.results().at(-1).result.rows.some(row => row.some(value => String(value).includes('<img'))));
  checks.push('Table preview returns real rows, including HTML-looking text for safe rendering.');
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Rocketbrain Dark', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.view.extension.rocketbrain');
  let liveMysqlVerified = false, javaCoreVerified = false;
  if (process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG) {
    const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG, 'utf8'));
    await api.connectMysql(config);
    const consolePath = path.join(__dirname, '..', 'test-output', 'persistent-console.sql');
    fs.mkdirSync(path.dirname(consolePath), { recursive: true });
    fs.writeFileSync(consolePath, 'SELECT CONNECTION_ID() AS id, VERSION() AS version;');
    const doc1 = await vscode.workspace.openTextDocument(vscode.Uri.file(consolePath));
    await vscode.window.showTextDocument(doc1);
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    const firstSession = api.sessionState();
    assert.equal(api.results().at(-1).state, 'done');
    assert.equal(firstSession.readOnly, true);
    assert.ok(firstSession.connectionId > 0);
    const doc2 = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT CONNECTION_ID() AS id;' });
    await vscode.window.showTextDocument(doc2);
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    assert.notEqual(api.sessionState().connectionId, firstSession.connectionId);
    await vscode.window.showTextDocument(doc1);
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    assert.equal(api.sessionState().connectionId, firstSession.connectionId);
    checks.push('Real MySQL/MariaDB queries use distinct, persistent connections per SQL editor.');
    await vscode.commands.executeCommand('rocketbrain.beginTransaction');
    assert.equal(api.sessionState().inTransaction, true);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.ok(api.sessions().some(session => session.id === firstSession.id && session.inTransaction), 'Closing a SQL editor must preserve its transaction.');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(consolePath)));
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    assert.equal(api.sessionState().connectionId, firstSession.connectionId);
    assert.equal(api.sessionState().inTransaction, true);
    checks.push('Closing and reopening a SQL editor preserves its active server transaction and connection.');
    await vscode.commands.executeCommand('rocketbrain.rollback');
    assert.equal(api.sessionState().inTransaction, false);
    checks.push('Registered console transaction commands begin and roll back a real server transaction.');
    const observer = await require('mysql2/promise').createConnection(config);
    const table = 'rb_host_grid';
    let gridSession;
    try {
      await observer.query('CREATE TABLE `' + table + '` (id int PRIMARY KEY, label varchar(100) NOT NULL) ENGINE=InnoDB');
      await observer.execute('INSERT INTO `' + table + '` VALUES (?,?)', [1, 'Before']);
      await vscode.commands.executeCommand('rocketbrain.refresh');
      await vscode.commands.executeCommand('rocketbrain.openTable', table);
      let record = api.results().at(-1); gridSession = record.sessionId;
      assert.equal(record.result.edit.canEdit, true, record.result.edit.reason);
      await api.tableAction(record.id, { type: 'enableEdit' });
      record = api.results().at(-1);
      await api.tableAction(record.id, { type: 'reviewChanges', changes: { updates: [{ rowId: record.result.edit.rowIds[0], values: { label: { kind: 'value', text: 'After' } } }], inserts: [], deletes: [] } });
      record = api.results().at(-1); assert.ok(record.review?.reviewId, record.editError);
      await api.tableAction(record.id, { type: 'applyChanges', reviewId: record.review.reviewId });
      assert.equal((await observer.query('SELECT label FROM `' + table + '`'))[0][0].label, 'Before');
      await api.tableAction(record.id, { type: 'commitChanges' });
      assert.equal((await observer.query('SELECT label FROM `' + table + '`'))[0][0].label, 'After');
      checks.push('Packaged table editing routes preview, reviewed parameterized updates and explicit commit to the real database.');
    } finally {
      if (gridSession) await api.closeConsoleSession(gridSession);
      await observer.query('DROP TABLE IF EXISTS `' + table + '`'); await observer.end();
    }
    await vscode.commands.executeCommand('rocketbrain.useDemo');
    liveMysqlVerified = true;
  }
  if(process.env.ROCKETBRAIN_DB_FOCUSED_TEST!=='1'){
  if (process.env.ROCKETBRAIN_JAVA_TEST_CONFIG) {
    await phase('Java editor and project import', () => require('./java-host').runJavaChecks(api, vscode, checks));
    javaCoreVerified = true;
  }
  if(process.env.ROCKETBRAIN_JAVA_REFACTOR_TEST==='1')await phase('Reviewed Java semantic refactoring',()=>require('./java-refactoring-host').runJavaRefactoringChecks(api,vscode,checks),180000);
  if (process.env.ROCKETBRAIN_JAVA_DEBUG_TEST === '1') await phase('Java launch and attach', () => require('./java-debug-host').runJavaDebugChecks(api, vscode, checks));
  if (process.env.ROCKETBRAIN_JAVA_ADVANCED_DEBUG_TEST === '1') await phase('Advanced Java debugger', () => require('./java-debug-advanced-host').runJavaAdvancedDebugChecks(api, vscode, checks));
  if (process.env.ROCKETBRAIN_SPRING_TEST_CONFIG) await phase('Static Spring editor', () => require('./spring-host').runSpringChecks(api, vscode, checks));
  if (process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG) await phase('Dynamic Spring native view', () => require('./spring-host').runSpringRuntimeChecks(api, vscode, checks));
  if (process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG&&process.env.ROCKETBRAIN_JPA_NAMING_TEST!=='1') await phase('JPA editor and live catalog', () => require('./jpa-host').runJpaChecks(api, vscode, checks));
  if (process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG&&process.env.ROCKETBRAIN_JPA_ADVANCED_TEST==='1'&&process.env.ROCKETBRAIN_JPA_NAMING_TEST!=='1') await phase('Scoped JPQL and custom XML mappings',()=>require('./jpa-host').runJpaV05Checks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG&&process.env.ROCKETBRAIN_JPA_TYPES_TEST==='1')await phase('Typed dynamic queries, SpEL and naming',()=>require('./jpa-host').runJpaV06Checks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG&&process.env.ROCKETBRAIN_JPA_OBSERVER_TEST==='1')await phase('Independent Hibernate runtime observer',()=>require('./jpa-observer-host').runObserverChecks(api,vscode,checks));
  if (process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG && process.env.ROCKETBRAIN_SPRING_DEBUG_TEST === '1') await phase('Real Spring project debugger', () => require('./java-debug-spring-host').runSpringProjectDebugChecks(api, vscode, checks));
  if(process.env.ROCKETBRAIN_JAVA_TESTING_TEST==='1')await phase('Native Java testing and JVM coverage',()=>require('./java-testing-host').runJavaTestingChecks(api,vscode,checks),300000);
  if(process.env.ROCKETBRAIN_JAVA_TEST_DEBUG_TEST==='1')await phase('Native test-only Java debugger',()=>require('./java-testing-debug-host').runJavaTestingDebugChecks(api,vscode,checks),300000);
  if(process.env.ROCKETBRAIN_SQL_ANALYSIS_TEST==='1')await phase('Complex SQL native editor',()=>require('./sql-analysis-host').runSqlAnalysisChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SQL_RENAME_TEST==='1')await phase('Scoped SQL Rename native editor',()=>require('./sql-rename-host').runSqlRenameChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SQL_PROJECT_TEST==='1')await phase('Workspace SQL references and source rename',()=>require('./sql-project-host').runSqlProjectChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SCHEMA_RENAME_TEST==='1')await phase('Reviewed physical database rename',()=>require('./schema-rename-host').runSchemaRenameChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_GRID_BROWSE_TEST==='1')await phase('Server table paging sort and filter',()=>require('./grid-browse-host').runGridBrowseChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SCHEMA_COMPARE_TEST==='1')await phase('Schema snapshot comparison and migration review',()=>require('./schema-diff-host').runSchemaDiffChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_GRID_BULK_TEST==='1')await phase('Bulk grid staging and mapped CSV import',()=>require('./grid-bulk-host').runGridBulkChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SQL_SCRIPT_TEST==='1')await phase('Reviewed parameterized SQL scripts',()=>require('./sql-script-host').runSqlScriptChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_SCHEMA_APPLY_TEST==='1')await phase('Reviewed additive schema application',()=>require('./schema-apply-host').runSchemaApplyChecks(api,vscode,checks));
  if(process.env.ROCKETBRAIN_XLSX_IMPORT_TEST==='1')await phase('Mapped XLSX worksheet import',()=>require('./xlsx-import-host').runXlsxImportChecks(api,vscode,checks));
  }
  if(process.env.ROCKETBRAIN_SCHEMA_RECOVERY_TEST==='1')await phase('Complex schema rebuild and guarded recovery',()=>require('./schema-recovery-host').runSchemaRecoveryChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_STREAM_IMPORT_TEST==='1')await phase('Transactional large-file streaming import',()=>require('./stream-import-host').runStreamImportChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_SCHEMA_DEPENDENCIES_TEST==='1')await phase('Schema foreign key trigger and view dependencies',()=>require('./schema-dependencies-host').runSchemaDependencyChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_SCHEMA_CROSS_DEPENDENCIES_TEST==='1')await phase('Cross-schema dependencies and structured triggers',()=>require('./schema-cross-dependencies-host').runSchemaCrossDependencyChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_SCHEMA_PROGRAMS_TEST==='1')await phase('Stored program CALL loops and finite SQL analysis',()=>require('./schema-programs-host').runSchemaProgramChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_SCHEMA_DYNAMIC_PROGRAMS_TEST==='1')await phase('Contextual dynamic SQL paths and prepared CALL state',()=>require('./schema-dynamic-programs-host').runDynamicProgramChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_SCHEMA_CONVERSIONS_TEST==='1')await phase('Explicit schema type conversions and recovery',()=>require('./schema-conversions-host').runSchemaConversionChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_SCHEMA_SPATIAL_ADVANCED_TEST==='1')await phase('Spatial indexes and explicit Web Mercator reprojection',()=>require('./schema-spatial-advanced-host').runAdvancedSpatialChecks(api,vscode,checks),240000);
  if(process.env.ROCKETBRAIN_SCHEMA_COORDINATOR_TEST==='1')await phase('Coordinated multi-server schema publication and recovery',()=>require('./schema-coordinator-host').runSchemaCoordinatorChecks(api,vscode,checks),300000);
  if(process.env.ROCKETBRAIN_SCHEMA_ATOMIC_DDL_TEST==='1')await phase('Explicit DDL guarantees and atomic-mode refusal',()=>require('./schema-atomic-ddl-host').runAtomicDdlChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_JAVA_WORKBENCH_TEST==='1'&&process.env.ROCKETBRAIN_DB_FOCUSED_TEST!=='1')await phase('Daily Java project build and run workbench',()=>require('./java-workbench-host').runJavaWorkbenchChecks(api,vscode,checks),600000);
  if(process.env.ROCKETBRAIN_SPRING_PROJECT_TOOLS_TEST==='1')await phase('Spring project creation and starter editing',()=>require('./spring-project-tools-host').runSpringProjectToolsChecks(api,vscode,checks,{buildRun:process.env.ROCKETBRAIN_DB_FOCUSED_TEST!=='1'}),600000);
  if(process.env.ROCKETBRAIN_DB_CONNECTIONS_TEST==='1')await phase('Saved database connections and profile editor',()=>require('./db-connections-host').runDbConnectionChecks(api,vscode,checks),180000);
  if(process.env.ROCKETBRAIN_DB_AUTHORING_TEST==='1')await phase('Visual database table and object authoring',()=>require('./db-authoring-host').runDbAuthoringChecks(api,vscode,checks),240000);
  const report = { vscode: vscode.version, extensionPath: extension.extensionPath, version: extension.packageJSON.version, passed: checks.length, checks, liveMysqlVerified, javaCoreVerified, javaSpringParityVerified: false };
  if (process.env.ROCKETBRAIN_TEST_OUTPUT) { fs.mkdirSync(path.dirname(process.env.ROCKETBRAIN_TEST_OUTPUT), { recursive: true }); fs.writeFileSync(process.env.ROCKETBRAIN_TEST_OUTPUT, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report));
  if (process.env.ROCKETBRAIN_CAPTURE === '1') await new Promise(() => {});
  } finally { await api.javaTesting?.dispose();await api.java.stop(); }
};
