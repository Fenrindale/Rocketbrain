'use strict';

const assert=require('node:assert/strict');
const { test }=require('node:test');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const { analyzeQuality,parseQualitySarif,resolveQualityLocation }=require('../src/java/quality-gate');
const { createQualityFixture,runQualityCli }=require('./helpers/java-quality-fixture');

test('Java gate reads exact committed blobs and compares validated SARIF baselines',async t=>{
  const fixture=await createQualityFixture(os.tmpdir());
  t.after(fixture.cleanup);
  const cli=path.resolve(__dirname,'../scripts/java-quality-gate.js');
  const {root,baseline,current,git,write,stable}=fixture;
  const call=(...args)=>runQualityCli(process.execPath,cli,['--repo',root,...args]);
  const baselineFile=path.join(root,'baseline.sarif'), currentFile=path.join(root,'current.sarif');
  const before=await call('--revision',baseline,'--output',baselineFile,'--fail-on','never');
  assert.equal(before.exit,0,before.stderr);
  const baseJson=JSON.parse(await fs.readFile(baselineFile,'utf8'));
  assert.equal(parseQualitySarif(baseJson).items.length,2);
  await write(stable,'package sample; // Uncommitted Java editor.\n');
  await git('add','--',stable);
  const index=await git('diff','--cached','--raw');
  const gate=await call('--revision',current,'--baseline',baselineFile,'--output',currentFile);
  assert.equal(gate.exit,1,gate.stderr);
  const sarif=JSON.parse(await fs.readFile(currentFile,'utf8'));
  assert.deepEqual(sarif.runs[0].properties.rocketbrainSummary,{revision:current,baseline,files:3,
    new:1,unchanged:1,fixed:1,blocking:1,failOn:'warning'});
  const report=parseQualitySarif(sarif);
  assert.equal(report.revision,current);
  const moved=report.items.find(item=>item.rule==='emptyIf');
  assert.equal(moved.state,'unchanged');
  assert.equal(moved.range.start.line,5);
  assert.equal((await resolveQualityLocation(root,report,moved)).text,fixture.committed);
  assert.equal(await git('diff','--cached','--raw'),index);
  const passing=await call('--revision',current,'--baseline-revision',baseline,'--fail-on','error');
  assert.equal(passing.exit,0,passing.stderr);
  assert.equal(JSON.parse(passing.stdout).runs[0].properties.rocketbrainSummary.blocking,0);
  const tampered=structuredClone(baseJson);
  tampered.runs[0].results.pop();
  const tamperFile=path.join(root,'tampered.sarif');
  await fs.writeFile(tamperFile,JSON.stringify(tampered));
  const rejected=await call('--baseline',tamperFile);
  assert.equal(rejected.exit,2,rejected.stderr);
  assert.match(rejected.stderr,/differ from the recorded commit/);
  assert.equal((await call('--revision','no-such-ref')).exit,2);
  await assert.rejects(analyzeQuality({directory:root,baselineRef:current,ref:baseline}),/ancestor/);
  await assert.rejects(analyzeQuality({directory:root,baselinePath:baselineFile,
    profile:{name:'Restricted',rules:{emptyIf:'off'}}}),/different inspection policy/);
  const unsafe=structuredClone(sarif);
  unsafe.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri='%2E%2E/escape.java';
  assert.throws(()=>parseQualitySarif(unsafe),/invalid or unsupported/);
  await assert.rejects(resolveQualityLocation(root,report,{...moved,object:'0'.repeat(40)}),/does not match/);
});
