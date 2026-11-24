'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function runExplainMeasurementChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const service = api.explainPlans, activity = api.activityLog;
  const previous = activity.snapshot().enabled;
  const connection = await mysql.createConnection(config);
  const panels = [];
  const query = where => 'SELECT p.id,d.name FROM rb_spring_person p STRAIGHT_JOIN rb_spring_department d ON d.id=p.department_id ' +
    where + ' ORDER BY p.display_name;';
  const baseline = query('');
  const candidate = query('WHERE p.id=1');
  const review = async sql => {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    const selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    return { document, selection, review: service.prepareMeasurement({ document, selection }) };
  };
  try {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.sql.measurePlan') && commands.includes('rocketbrain.sql.comparePlans'));
    await api.connectMysql(config);
    await activity.setEnabled(true);
    const firstReview = (await review(baseline)).review;
    await assert.rejects(service.measure(firstReview.id), /Approve execution/);
    await assert.rejects(api.measureQueryPlan('SELECT 1'), /Approve execution/);
    await assert.rejects(api.measureQueryPlan('UPDATE rb_spring_person SET id=1', { confirmed:true }), /read-only/);
    await assert.rejects(api.measureQueryPlan('SELECT /*+ MAX_EXECUTION_TIME(90000) */ 1', { confirmed:true }), /Remove optimizer hints/);
    const first = await service.measure(firstReview.id, { confirmed:true });
    panels.push(first.id);
    assert.equal(first.engine, runtime.dbEngine);
    assert.equal(first.measured, true);
    assert.equal(first.format, first.engine === 'mysql' ? 'tree' : 'json');
    assert.ok(first.nodes.length >= 3);
    const metrics = first.nodes.flatMap(node => node.actual);
    const measuredValues = new Map(metrics.map(metric => [metric.key, metric.value]));
    const expectedKeys = first.engine === 'mysql' ? ['first_ms','last_ms','actual_rows','loops'] : ['r_total_time_ms','r_loops','r_rows'];
    assert.ok(expectedKeys.every(key => measuredValues.has(key)));
    assert.ok(metrics.every(metric => first.raw.includes(metric.value)));
    assert.ok(first.nodes.some(node => node.rows.length && node.actual.length));
    const rowKey = first.engine === 'mysql' ? 'actual_rows' : 'r_rows';
    const [expected] = await connection.query(baseline);
    assert.equal(expected.length, 2);
    assert.ok(metrics.some(metric => metric.key === rowKey && Number(metric.value) === expected.length));
    const secondReview = (await review(candidate)).review;
    const second = await service.measure(secondReview.id, { confirmed:true });
    panels.push(second.id);
    const beforeCompare = activity.snapshot().entries.length;
    const diff = service.showComparison(first.id, second.id);
    assert.ok(diff.measured && diff.rows.length >= first.nodes.length);
    assert.ok(diff.counts.changed + diff.counts.added + diff.counts.removed > 0);
    assert.equal(activity.snapshot().entries.length, beforeCompare);
    await assert.rejects(service.measure(secondReview.id, { confirmed:true }), /expired/);

    const stale = await review('SELECT 1;');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(stale.document.uri, new vscode.Position(0,0), '-- changed after approval\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await assert.rejects(service.measure(stale.review.id,{confirmed:true}), /source changed/);

    const token = new vscode.CancellationTokenSource();
    const verb = first.engine === 'mysql' ? 'EXPLAIN' : 'ANALYZE';
    try {
      const slow = api.measureQueryPlan('SELECT id FROM rb_spring_person WHERE SLEEP(3)=0',
        { confirmed:true,cancellation:token.token });
      const settled = slow.then(value=>({ value }),error=>({ error }));
      let dispatched = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        dispatched = activity.snapshot().entries.some(row => row.operation === verb && row.category === 'query' && row.status === 'running');
        if (dispatched) break;
        await new Promise(resolve => setTimeout(resolve,25));
      }
      token.cancel();
      assert.equal(dispatched,true);
      assert.match((await settled).error?.message || '', /cancelled/);
      assert.ok(activity.snapshot().entries.some(row=>row.operation===verb&&row.status==='cancelled'));
    } finally { token.dispose(); }
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(9000) });
    assert.equal(response.ok,true);
    const jdbc = await response.json();
    assert.deepEqual(jdbc, {people:2,departments:1,rolledBackNames:0});
    checks.push('The installed extension measured a Spring join on the current engine, displayed exact server row, loop and timing fields, compared two captures without another dispatch, rejected stale and write selections, and cancelled an in-flight measurement.');
    return { engine:first.engine, format:first.format, nodes:first.nodes.length, metrics:metrics.length, observedRows:expected.length,
      comparedNodes:diff.rows.length, differingNodes:diff.counts.changed+diff.counts.added+diff.counts.removed,
      approved:true, staleRefused:true, cancelledDuringDispatch:true, compareWithoutExecution:true, jdbc };
  } finally {
    for (const id of panels) service.close(id);
    await activity.setEnabled(previous);
    await Promise.allSettled([connection.end(), api.disconnectMysql()]);
  }
}

module.exports = { runExplainMeasurementChecks };
