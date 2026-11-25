'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {branchFlowFixture}=require('./helpers/java-branch-flow-fixture');

async function stableClasspath(operation) {
  for(let attempt=1;;attempt++) {
    try {return await operation();}
    catch(error) {
      if(attempt===4||!/compiler (?:runtime or )?classpath (?:file membership )?changed after/iu.test(error.message)) throw error;
      await new Promise(resolve=>setTimeout(resolve,650));
    }
  }
}

async function runJavaBranchFlowChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const service=api.javaSourceAnalysis,fixture=branchFlowFixture('fixture.boot','RbBranches'+randomBytes(5).toString('hex'));
  const owns=[],directory=path.join(workspace,'src/main/java/fixture/boot');
  async function add(role) {
    const file=path.join(directory,fixture[role+'Name']+'.java');
    await fs.writeFile(file,fixture[role],{flag:'wx'});
    owns.push(file);
    return vscode.workspace.openTextDocument(vscode.Uri.file(file));
  }
  const position=(document,text,shift=0)=>document.positionAt(document.getText().indexOf(text)+shift);
  const trace=(document,text,shift=0)=>stableClasspath(()=>service.traceCalls({document,position:position(document,text,shift)}));
  let caller,helper;
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.traceCallDataFlow'));
    caller=await add('caller');helper=await add('helper');
    const report=await trace(caller,'var outcome',4);
    const join=report.inputs.find(event=>event.kind==='branch-merge'&&event.name==='Join result');
    assert.ok(join);
    assert.equal(report.inputs.filter(event=>event.kind==='assignment'&&event.name==='result').length,2);
    assert.deepEqual(new Set(report.inputs.filter(event=>event.kind==='branch').map(event=>event.name)),new Set(['True branch','False branch']));
    const source=await stableClasspath(()=>service.revealCallFlow(report,join.id));
    assert.equal(path.relative(source.document.uri.fsPath,helper.uri.fsPath),'');
    assert.equal(source.document.getText(source.selection),'if');

    const fixed=await trace(caller,'var knownOn',4);
    assert.ok(fixed.inputs.some(event=>event.kind==='condition'&&event.name==='Condition is true'));
    assert.ok(!fixed.inputs.some(event=>event.name==='"disabled"'||event.name==='False branch'));
    const narrowed=await trace(caller,'var selected',4);
    assert.ok(narrowed.inputs.some(event=>event.kind==='narrowed'&&event.name==='value is non-null'));
    assert.ok(narrowed.inputs.some(event=>event.kind==='return-merge'));
    assert.ok(!narrowed.inputs.some(event=>event.name==='"impossible"'));

    const change=new vscode.WorkspaceEdit(), from=position(helper,'"disabled"');
    change.replace(helper.uri,new vscode.Range(from,from.translate(0,'"disabled"'.length)),'"muted"');
    assert.equal(await vscode.workspace.applyEdit(change),true);
    assert.equal(await helper.save(),true);
    await assert.rejects(service.revealCallFlow(report,join.id),/changed|Trace the value again/u);
    const fresh=await trace(caller,'var outcome',4);
    assert.ok(fresh.inputs.some(event=>event.kind==='literal'&&event.name==='"muted"'));
    assert.ok(!fresh.inputs.some(event=>event.name==='"disabled"'));
    const jdbc=await jdbcReadback();assert.ok(jdbc);
    checks.push('Java call flow retained independent if/else assignments, pruned a known caller branch, linked null narrowing and early returns, and rebuilt after a saved source edit.');
    return {branchJoin:true,preciseConditionSource:true,knownArgumentFiltered:true,nullNarrowing:true,earlyReturns:true,
      staleLinkRefused:true,reanalysis:true,jdbc};
  } finally {
    for(const document of [caller,helper])if(document?.isDirty)await document.save();
    for(const file of owns)await fs.unlink(file);
  }
}

module.exports={runJavaBranchFlowChecks};
