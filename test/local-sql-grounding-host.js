'use strict';

const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { relationshipOptions, compileGroundedQuery, projectGrounding, prepareGroundedRequest, executeGroundedRequest } = require('../src/db/local-sql-grounding');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const tables = ['rb_grounding_assignment', 'rb_grounding_branch', 'rb_spring_person', 'rb_spring_department'];
const original = 'Return only department name (rb_spring_department.name) and SUM of assignment points (rb_grounding_assignment.points). Sort by department name ASC. Limit 20.';
const followup = 'Keep the previous department name and add branch label (rb_grounding_branch.label). Replace SUM with COUNT of person ID (rb_spring_person.id). Sort by branch label ASC. Limit 20.';
const join = ' FROM rb_grounding_assignment a JOIN rb_grounding_branch b ON b.region_id=a.region_id AND b.branch_id=a.branch_id' +
  ' JOIN rb_spring_person p ON p.id=a.person_id JOIN rb_spring_department d ON d.id=p.department_id';
const expected = [
  'SELECT d.name, SUM(a.points)' + join + ' GROUP BY d.name ORDER BY d.name ASC LIMIT 20',
  'SELECT d.name, b.label, COUNT(p.id)' + join + ' GROUP BY d.name,b.label ORDER BY b.label ASC LIMIT 20'
];

async function fixtures(connection) {
  await connection.query('CREATE TABLE rb_grounding_branch (region_id INT NOT NULL, branch_id INT NOT NULL, label VARCHAR(30) NOT NULL, ' +
    'PRIMARY KEY(region_id,branch_id)) ENGINE=InnoDB');
  await connection.query('CREATE TABLE rb_grounding_assignment (id INT NOT NULL PRIMARY KEY, region_id INT NOT NULL, branch_id INT NOT NULL, ' +
    'person_id BIGINT NOT NULL, points INT NOT NULL, secret_label VARCHAR(30), ' +
    'CONSTRAINT rb_grounding_branch_fk FOREIGN KEY(region_id,branch_id) REFERENCES rb_grounding_branch(region_id,branch_id), ' +
    'CONSTRAINT rb_grounding_person_fk FOREIGN KEY(person_id) REFERENCES rb_spring_person(id)) ENGINE=InnoDB');
  await connection.query("INSERT INTO rb_grounding_branch VALUES (1,1,'North'),(2,1,'South')");
  await connection.query("INSERT INTO rb_grounding_assignment SELECT id, ROW_NUMBER() OVER (ORDER BY id), 1, id, id * 10, 'fixture-private-sentinel' FROM rb_spring_person");
}

function selectRoute(catalog) {
  const edges = relationshipOptions(catalog);
  const route = [[0,1],[0,2],[2,3]].map(([from, to]) => edges.find(edge => edge.table === tables[from] && edge.parent === tables[to]));
  assert.deepEqual(route[0].pairs, [['region_id','region_id'],['branch_id','branch_id']]);
  return { root: tables[0], edgeIds: route.map(edge => edge.id), selections: tables.map((table, i) => ({
    table, columns: [['points'], ['label'], ['id'], ['name']][i]
  })) };
}

async function verify(db, model, adapter, config) {
  const catalog = await db.metadata();
  const choices = selectRoute(catalog);
  const scope = projectGrounding(catalog, choices);
  assert.deepEqual(scope.names, tables);
  const result = [];
  await db.openSession('default', { readOnly: true });
  let previous;
  for (const [index, input] of [original, followup].entries()) {
    const request = adapter
      ? await adapter.stage({ input, ...(previous ? { previousId: previous.id } : { choices }) })
      : prepareGroundedRequest({ ...model, context: scope, input, previous });
    const report = request.input ?? request.preview;
    assert.equal(report.joins.length, 3);
    assert.equal(report.joins[0].pairs.length, 2);
    assert.ok(typeof config.password === 'string' && !JSON.stringify(report).includes(config.password));
    for (const hidden of ['secret_label', 'fixture-private-sentinel', 'North', 'South']) assert.ok(!JSON.stringify(report).includes(hidden));
    if (previous) assert.ok(report.previousPlan && !JSON.stringify(report.previousPlan).includes('SELECT') && !('explanation' in report.previousPlan));
    if (adapter) await assert.rejects(adapter.draft(request.id, { confirmed: false }), /exact schema context/);
    const draft = adapter ? await adapter.draft(request.id, { confirmed: true }) : await executeGroundedRequest(request);
    assert.equal(draft.execution, 'not-run');
    assert.match(draft.sql, /ON t1\.`region_id` = t2\.`region_id` AND t1\.`branch_id` = t2\.`branch_id`/);
    if (adapter) {
      await assert.rejects(adapter.draft(request.id, { confirmed: true }), /expired/);
      await assert.rejects(adapter.stage({ previousId: draft.id, input: followup }), /Review the current proposal/);
      await assert.rejects(adapter.inspect(draft.id, { confirmed: true, digest: draft.digest }), /exact reviewed proposal/);
      assert.throws(() => adapter.review(draft.id, { confirmed: true, digest: 'changed' }), /exact generated SQL/);
      adapter.review(draft.id, { confirmed: true, digest: draft.digest });
    }
    const plan = adapter ? await adapter.inspect(draft.id, { confirmed: true, digest: draft.digest })
      : await db.explainGroundedQuery(choices, draft.plan, scope.fingerprint);
    assert.equal(plan.engine, catalog.dialect);
    assert.equal(Boolean(plan.measured), false);
    assert.ok(plan.nodes.filter(node => node.kind === 'table').length >= 3);
    const manuallyExecuted = await db.query(draft.sql);
    const control = await db.query(expected[index]);
    assert.deepEqual(manuallyExecuted.rows, control.rows, `model plan ${JSON.stringify(draft.plan)}`);
    result.push({ rows: control.rows.length, operators: plan.nodes.length });
    previous = draft;
  }
  assert.throws(() => compileGroundedQuery(scope, { ...previous.plan, columns: ['rb_grounding_assignment.secret_label'] }), /unapproved/);
  assert.throws(() => compileGroundedQuery(scope, { ...previous.plan, sql: 'SELECT 1' }), /supported grounded SELECT/);
  return { engine: catalog.dialect, serverVersion: catalog.serverVersion, model: 'Qwen2.5-Coder-1.5B-Instruct Q4_K_M',
    tables: tables.length, approvedEdges: 3, compositeKeyColumns: 2, separateModelAndPlanApproval: true,
    metadataOnly: true, realRefinement: true, automaticSelectExecution: false, resolvedPlans: result, choices, scope, previous };
}

async function runFixture(adapter, config, model, open) {
  const connection = await mysql.createConnection(config);
  const db = new MysqlService(config);
  try {
    await fixtures(connection);
    await open?.();
    const { choices, scope, previous, ...result } = await verify(db, model, adapter, config);
    if (adapter) {
      const editor = await adapter.openDraft(previous.id, previous.digest);
      assert.equal(editor.document.languageId, 'sql');
      assert.equal(editor.document.getText().trim(), previous.sql);
      const { report, panel } = await adapter.openPlan(previous.id, { confirmed: true, digest: previous.digest });
      try { assert.equal(panel.viewType, 'rocketbrain.groundedPlan'); assert.equal(report.engine, result.engine); }
      finally { panel.dispose(); }
    }
    await connection.query('ALTER TABLE rb_grounding_assignment DROP FOREIGN KEY rb_grounding_branch_fk');
    await assert.rejects(adapter ? adapter.inspect(previous.id, { confirmed: true, digest: previous.digest })
      : db.explainGroundedQuery(choices, previous.plan, scope.fingerprint), /reviewed key|metadata changed/);
    return { ...result, changedForeignKeyRefused: true, nativeDraftAndPlan: Boolean(adapter), jdbc: await jdbcReadback() };
  } finally {
    try {
      await db.dispose();
      await connection.query('DROP TABLE IF EXISTS rb_grounding_assignment');
      await connection.query('DROP TABLE IF EXISTS rb_grounding_branch');
    } finally { await connection.end(); }
  }
}

async function runLocalSqlGroundingChecks(api, vscode, checks) {
  const config = await fixtureConfig(), model = await startLocalModel();
  const settings = vscode.workspace.getConfiguration('rocketbrain.localSqlAssistant');
  const keys = ['endpoint', 'model'];
  const old = Object.fromEntries(keys.map(key => [key, settings.inspect(key)?.workspaceValue]));
  try {
    for (const key of keys) await settings.update(key, model[key], vscode.ConfigurationTarget.Workspace);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.localSqlAssistant.grounded'));
    const result = await runFixture(api.localSqlAssistant.grounded, config, model, () => api.connectMysql(config));
    checks.push('The real local model produced and refined a four-table query over three observed foreign keys, including both composite-key columns. Reviewed estimated plans rendered and both manually executed controls matched. A removed foreign key blocked plan inspection.');
    return result;
  } finally {
    try {
      await api.disconnectMysql();
      for (const key of keys) await settings.update(key, old[key], vscode.ConfigurationTarget.Workspace);
    } finally { await model.close(); }
  }
}

if (require.main === module) fixtureConfig().then(async config => {
  const model = await startLocalModel();
  try { console.log(JSON.stringify(await runFixture(undefined, config, model))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runLocalSqlGroundingChecks };
