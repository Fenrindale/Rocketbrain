'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function runExplainPlanChecks(api, vscode, checks) {
  assert.ok(api.explainPlans);
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const marker = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const sql = `SELECT p.display_name, d.name
FROM rb_spring_person AS p STRAIGHT_JOIN rb_spring_department AS d ON p.department_id = d.id
WHERE p.display_name LIKE 'J%'
ORDER BY CONCAT(p.display_name, d.name);`;
  const statement = 'SELECT 1;\n\n' + sql;
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content: statement });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(document.positionAt(statement.indexOf('SELECT p')), document.positionAt(statement.length));
  const actor = await mysql.createConnection({ ...config, rowsAsArray: true, jsonStrings: true });
  let report;
  try {
    await api.connectMysql(config);
    await vscode.window.showTextDocument(document);
    report = await vscode.commands.executeCommand('rocketbrain.sql.explainVisual');
    assert.ok(report?.id, 'Registered visual EXPLAIN opened a native Webview panel.');
    assert.equal(report.engine, runtime.dbEngine);
    assert.equal(report.database, config.database);
    assert.equal(report.rootIds.length, 1);
    assert.ok(report.nodes.some(node => /p\b/.test(node.name) && node.rows.length));
    assert.ok(report.nodes.some(node => /d\b/.test(node.name) && node.rows.length));
    assert.ok(report.nodes.some(node => /Nested loop|Block nested loop/i.test(node.name)));
    assert.ok(report.nodes.some(node => /Ordering|Filesort|Sort:/i.test(node.name)));
    assert.ok(report.nodes.some(node => node.expressions.some(expression => /display_name.*like/i.test(expression.value))));
    const [expectedRows] = await actor.query('EXPLAIN FORMAT=JSON\n' + sql);
    assert.equal(expectedRows.length, 1);
    assert.deepEqual(JSON.parse(report.raw), JSON.parse(expectedRows[0][0]));
    const costs = report.nodes.flatMap(node => node.costs);
    if (runtime.dbEngine === 'mysql') assert.ok(costs.some(metric => ['query_cost', 'estimated_total_cost'].includes(metric.key)));
    assert.ok(costs.length || report.warnings.some(note => /no numeric optimizer costs/.test(note)));
    const estimates = report.nodes.flatMap(node => node.rows);
    assert.ok(estimates.length && [...costs, ...estimates].every(metric => report.raw.includes(metric.value)));
    let originalTree = false;
    if (runtime.dbEngine === 'mysql') {
      const tree = await api.explainPlans.loadTree(report.id);
      const [expectedTree] = await actor.query('EXPLAIN FORMAT=TREE\n' + sql);
      assert.equal(tree.format, 'tree');
      assert.equal(tree.raw, expectedTree[0][0]);
      assert.match(tree.raw, /cost=.*rows=/);
      assert.match(tree.raw, /join/i);
      originalTree = true;
    } else await assert.rejects(api.explainPlans.loadTree(report.id), /MySQL visual EXPLAIN/);
    assert.equal(await api.explainPlans.revealSource(report.id), document.uri.toString());
    assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection), sql);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), '-- Changed after capture\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await assert.rejects(api.explainPlans.revealSource(report.id), /SQL source changed/);
    await assert.rejects(api.explainQueryPlan('EXPLAIN ANALYZE ' + sql), /SELECT or WITH SELECT statement/);
    await assert.rejects(api.explainQueryPlan("UPDATE rb_spring_person SET display_name = 'changed'"), /read-only/);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6500) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('Visual EXPLAIN shows the actual Spring query join, order and filter plan with exact server-supplied row and cost estimates, retains raw JSON and reopens the captured SQL.');

    const evidence = { version: process.env.ROCKETBRAIN_RELEASE_VERSION || '0.33.0', engine: runtime.dbEngine, serverVersion: report.version,
      springSeedQuery: true, realTableJoin: true, orderingNode: true, filterCondition: true, nodes: report.nodes.length,
      rowMetrics: estimates.length, costMetrics: costs.length, absentCostExplicit: !costs.length,
      rawPlanMatchesDirectQuery: true, originalTree, exactSourceLocation: true, changedSourceGuard: true,
      mutationAndAnalyzeRejected: true, nativeExposedWebview: true, isolation };
    const output = path.resolve(__dirname, '../test-output', (process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.33') +
      '-native-explain-plan-' + runtime.dbEngine + '.json');
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    return evidence;
  } finally {
    if (report?.id) api.explainPlans.close(report.id);
    await actor.end();
    await vscode.commands.executeCommand('rocketbrain.useDemo');
  }
}

module.exports = { runExplainPlanChecks };
