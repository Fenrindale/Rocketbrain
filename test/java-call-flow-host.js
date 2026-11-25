'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {callFlowFixture}=require('./helpers/java-call-flow-fixture');

async function stableClasspath(operation) {
  for(let attempt=1;;attempt++) {
    try {return await operation();}
    catch(error) {
      if(attempt===4||!/compiler (?:runtime or )?classpath (?:file membership )?changed after/iu.test(error.message)) throw error;
      await new Promise(resolve=>setTimeout(resolve,650));
    }
  }
}

async function runJavaCallFlowChecks(api,vscode,checks) {
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,root);
  const service=api.javaSourceAnalysis, fixture=callFlowFixture('fixture.boot','RbCallFlow'+randomBytes(5).toString('hex'));
  const directory=path.join(root,'src/main/java/fixture/boot'), files=[];
  const open=async role=>{
    const file=path.join(directory,fixture[role+'Name']+'.java');
    await fs.writeFile(file,fixture[role],{flag:'wx'});
    files.push(file);
    return vscode.workspace.openTextDocument(vscode.Uri.file(file));
  };
  const selection=(document,term,shift=0)=>document.positionAt(document.getText().indexOf(term)+shift);
  let caller,helper;
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.traceCallDataFlow'));
    caller=await open('caller');helper=await open('helper');
    const tracked={document:caller,position:selection(caller,'var output',4)};
    const initial=await stableClasspath(async()=>{
      const report=await service.traceCalls(tracked);
      const definition=report.inputs.find(event=>event.kind==='definition'&&event.name==='shifted');
      assert.ok(definition);
      const editor=await service.revealCallFlow(report,definition.id);
      assert.equal(path.relative(editor.document.uri.fsPath,helper.uri.fsPath),'');
      assert.equal(editor.document.getText(editor.selection),'shifted');
      return {report,definition};
    });
    assert.ok(initial.report.inputs.some(event=>event.kind==='call-result'&&event.name===fixture.scaleKey));
    await assert.rejects(service.revealCallFlow({...initial.report},initial.definition.id),/current Java call flow/u);
    await assert.rejects(service.reveal(initial.report,initial.definition),/current Java call flow/u);
    const inside=await stableClasspath(async()=>{
      const report=await service.traceCalls({document:helper,position:selection(helper,'int value)',4)});
      assert.equal(report.contexts.length,3);
      const context=report.contexts.find(item=>item.method===fixture.alternateKey);
      return service.selectCallContext(report,context.id);
    });
    assert.ok(inside.inputs.some(event=>event.kind==='parameter'&&event.name==='incoming'));
    assert.ok(!inside.inputs.some(event=>event.name==='raw'));
    assert.ok(inside.uses.some(event=>event.kind==='return'&&event.method===fixture.alternateKey));
    const alternatives=await stableClasspath(()=>service.traceCalls({document:caller,position:selection(caller,'var selected',4)}));
    assert.ok(alternatives.inputs.some(event=>event.kind==='false-value'));
    assert.ok(alternatives.inputs.some(event=>event.kind==='literal'&&event.name==='null'));

    const edit=new vscode.WorkspaceEdit(), number=selection(helper,'value * 2',8);
    edit.replace(helper.uri,new vscode.Range(number,number.translate(0,1)),'3');
    assert.equal(await vscode.workspace.applyEdit(edit),true);
    assert.equal(await helper.save(),true);
    await assert.rejects(service.revealCallFlow(initial.report,initial.definition.id),/changed|Trace the value again/u);
    const updated=await stableClasspath(()=>service.traceCalls(tracked));
    assert.ok(updated.inputs.some(event=>event.kind==='literal'&&event.name==='3'));
    assert.ok(!updated.inputs.some(event=>event.kind==='literal'&&event.name==='2'));
    await assert.rejects(stableClasspath(()=>service.traceCalls({document:helper,position:selection(helper,'int recursive')})),/Recursive calls/u);
    const jdbc=await jdbcReadback();assert.ok(jdbc);
    checks.push('Native Java call flow traversed exact cross-file argument and return values, isolated a selected caller context, linked the callee declaration, modeled null and value alternatives, and rejected stale or recursive flow.');
    return {nativeCommand:true,overload:fixture.scaleKey,sourceNavigation:true,isolatedCaller:true,possibleNull:true,
      staleRefused:true,recursiveRefused:true,reanalysis:true,jdbc};
  } finally {
    for(const doc of [caller,helper])if(doc?.isDirty)await doc.save();
    for(const file of files)await fs.unlink(file);
  }
}

module.exports={runJavaCallFlowChecks};
