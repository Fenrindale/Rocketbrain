'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

async function runExplainSeriesChecks(api,vscode,checks){
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const config=JSON.parse(await fs.readFile(runtime.dbConfigPath,'utf8'));
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const service=api.explainPlans,activity=api.activityLog,ids=[];
  const previous=activity.snapshot().enabled;
  const verb=runtime.dbEngine==='mysql'?'EXPLAIN':'ANALYZE';
  const completed=()=>activity.snapshot().entries.filter(row=>row.category==='query'&&row.operation===verb&&row.status==='succeeded').length;
  const execute=async(where,samples)=>{
    const sql='SELECT p.id,d.name FROM rb_spring_person p STRAIGHT_JOIN rb_spring_department d ON d.id=p.department_id '+
      where+' ORDER BY p.display_name;';
    const document=await vscode.workspace.openTextDocument({language:'sql',content:sql});
    const selection=new vscode.Selection(document.positionAt(0),document.positionAt(sql.length));
    const review=service.prepareSeries({document,selection,samples});
    return {document,review};
  };
  try{
    const commands=await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.sql.measurePlanSeries')&&commands.includes('rocketbrain.sql.comparePlanSeries'));
    await api.connectMysql(config);
    await activity.setEnabled(true);
    const count=completed(), progress=[];
    const baselineRequest=await execute('',3);
    await assert.rejects(service.measureSeries(baselineRequest.review.id),/Approve the repeated executions/);
    const baseline=await service.measureSeries(baselineRequest.review.id,{confirmed:true,onProgress:({completed:done})=>progress.push(done)});
    ids.push(baseline.id);
    assert.deepEqual(progress,[1,2,3]);
    assert.equal(completed()-count,3);
    assert.equal(baseline.totalSamples,3);
    assert.equal(baseline.engine,runtime.dbEngine);
    const rows=runtime.dbEngine==='mysql'?'actual_rows':'r_rows';
    const time=runtime.dbEngine==='mysql'?'last_ms':'r_total_time_ms';
    const baselineRows=baseline.metrics.find(item=>item.key===rows&&item.count===3&&Number(item.median)===2);
    assert.ok(baselineRows);
    assert.ok(baseline.metrics.some(item=>item.key===time&&item.count===3&&Number(item.max)>=Number(item.min)));
    assert.equal(baseline.shapes.flatMap(shape=>shape.samples).length,3);
    const raw=service.getSample(baseline.id,2);
    assert.equal(raw.format,runtime.dbEngine==='mysql'?'tree':'json');
    assert.ok(raw.raw.length>100);
    const candidateRequest=await execute('WHERE p.id+0<=1',2);
    const candidate=await service.measureSeries(candidateRequest.review.id,{confirmed:true});
    ids.push(candidate.id);
    assert.equal(completed()-count,5);
    assert.ok(candidate.metrics.some(item=>item.key===rows&&item.count===2&&Number(item.median)===1));
    const diff=service.showSeriesComparison(baseline.id,candidate.id);
    const matched=diff.metrics.filter(item=>item.baseline&&item.candidate).length;
    assert.ok(matched>0);
    assert.deepEqual([diff.baseline.samples,diff.candidate.samples],[3,2]);
    assert.equal(completed()-count,5);
    const stopped=await execute('',3);
    const token=new vscode.CancellationTokenSource();
    try{
      await assert.rejects(service.measureSeries(stopped.review.id,{confirmed:true,cancellation:token.token,
        onProgress:()=>token.cancel()}),/cancelled/i);
    }finally{token.dispose();}
    assert.equal(completed()-count,6);
    const result=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(9000)});
    assert.ok(result.ok);
    const jdbc=await result.json();
    assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
    checks.push('Native SQL plan series captured three baseline and two candidate samples from the Spring join. Server statistics retained their numeric distributions, real shapes and raw samples. Comparison sent no query and cancellation stopped additional runs.');
    return {engine:baseline.engine,format:raw.format,baselineSamples:3,candidateSamples:2,matchedMetrics:matched,
      actualRows:[2,1],rawPreserved:true,approvalRequired:true,cancellationStoppedNext:true,comparisonDidNotExecute:true,jdbc};
  }finally{
    for(const id of ids)service.closeSeries(id);
    await activity.setEnabled(previous);
    await api.disconnectMysql();
  }
}

module.exports={runExplainSeriesChecks};
