'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const { normalizePlan }=require('../src/db/explain-plan');
const { sampleCount,summarizeSeries,compareSeries }=require('../src/db/explain-plan-series');
const { seriesHtml }=require('../src/db/explain-plan-view');

const mysql=raw=>normalizePlan({raw,engine:'mysql',version:'8.4',database:'test',format:'tree',measured:true});
const tree=(root,rows,child='')=>'-> '+root+' (cost=1 rows=7) (actual time=.010..2e-2 rows='+rows+' loops=1)\n'+child;

test('measurement series computes exact server sample distributions and keeps shape changes',()=>{
  const one=mysql(tree('Scan <literal>','9007199254740993'));
  const two=mysql(tree('Scan <literal>','9007199254740994','    -> Later iterator (actual time=0.010..0.020 rows=1 loops=1)\n'));
  const summary=summarizeSeries([one,two]);
  assert.deepEqual(summary.shapes.map(shape=>shape.samples),[[1],[2]]);
  const row=summary.metrics.find(item=>item.name==='Scan <literal>'&&item.key==='actual_rows');
  assert.deepEqual([row.count,row.min,row.median,row.max],[2,'9007199254740993','9007199254740993.5','9007199254740994']);
  const timing=summary.metrics.find(item=>item.name==='Scan <literal>'&&item.key==='first_ms');
  assert.deepEqual([timing.count,timing.min,timing.median,timing.max],[2,'.010','0.01','.010']);
  assert.equal(summary.metrics.find(item=>item.name==='Later iterator').count,1);
  const html=seriesHtml(summary,[one,two],'test');
  assert.match(html,/Scan &lt;literal&gt;/);
  assert.match(html,/2 sequential samples · 2 decoded plan shapes/);
  assert.match(html,/Raw captures/);
  assert.throws(()=>sampleCount(6),/2 to 5/);
});

test('series comparison pairs exact metric paths and labels absent samples without inventing data',()=>{
  const plan=mysql(tree('Index lookup','8'));
  const added=mysql(tree('Different scan','3'));
  const left=summarizeSeries([plan,plan,plan]), right=summarizeSeries([plan,added]);
  const report=compareSeries(left,right);
  assert.ok(report.metrics.some(item=>item.baseline?.key==='actual_rows'&&item.baseline.count===3&&item.candidate.count===1));
  assert.ok(report.metrics.some(item=>!item.baseline&&item.candidate?.name==='Different scan'));
  assert.match(seriesHtml(report,null,'test'),/Baseline · 3 samples.*Candidate · 2 samples/);
  assert.throws(()=>compareSeries(left,{...right,version:'different'}),/same server/);
  assert.throws(()=>summarizeSeries([plan,{...plan,measured:false}]),/inconsistent/);
});
