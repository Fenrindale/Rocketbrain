'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {resolveRequest,sendRequest} = require('../src/http/client');
const {previewWorkflow,runWorkflow} = require('../src/http/workflow');

const requestText = config => [
  '@base = '+config.baseUrl,
  '# @step countRows',
  '# @capture rowCount $.people',
  '# @expect status 200',
  'GET {{base}}/probe/testing-state',
  '###',
  '# @step verifyRows',
  '# @expect json $.captureMatches == true',
  'GET {{base}}/probe/http-workflow/verify?expected={{capture.rowCount}}',
  ''
].join('\n');

async function verify(config, invoke) {
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const text=requestText(config);
  const report=await invoke(text);
  assert.deepEqual(report,{state:'completed',executed:[
    {name:'countRows',status:200,checks:[{kind:'status',name:undefined,passed:true}],captured:1},
    {name:'verifyRows',status:200,checks:[{kind:'json',name:'$.captureMatches',passed:true}],captured:0}
  ]});
  const bad=text.replace('$.people','$.unknown');
  const blocked=await invoke(bad);
  assert.equal(blocked.state,'stopped');
  assert.equal(blocked.reason,'capture-invalid');
  assert.deepEqual(blocked.executed.map(step=>step.name),['countRows']);
  return {engine:config.dbEngine,sameOrigin:true,capturedJdbcCount:true,missingCaptureStopped:true,steps:report.executed.length};
}

async function runHttpWorkflowChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.http.runWorkflow'));
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const workflow=api.httpTools.workflow;
  let verifiedReview=false,staleReview=false;
  const result=await verify(config,async text=>{
    const file=path.join(root,'rb-http-workflow-'+randomUUID()+'.http');
    await fs.writeFile(file,text,{flag:'wx'});
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    try {
      const first=await workflow.review(document);
      assert.equal(first.origin,config.baseUrl);
      assert.deepEqual(first.steps.map(step=>step.path),['/probe/testing-state','/probe/http-workflow/verify']);
      await assert.rejects(workflow.run(first.id),/Approve/);
      assert.ok(await editor.edit(edit=>edit.insert(document.positionAt(0),'# workflow changed\n')));
      assert.equal(document.isDirty,true);
      await assert.rejects(workflow.run(first.id,{approved:true}),/workflow document or environment changed/i);
      await vscode.commands.executeCommand('undo');
      assert.equal(document.getText(),text);
      staleReview=true;
      const second=await workflow.review(document);
      const proof=await workflow.run(second.id,{approved:true});
      await assert.rejects(workflow.run(second.id,{approved:true}),/Review/);
      verifiedReview=true;
      return proof;
    } finally {
      if (document.isDirty) await document.save();
      if (vscode.window.activeTextEditor?.document===document) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await fs.unlink(file);
    }
  });
  checks.push('The installed HTTP workflow reviewed two requests against the same Spring origin, captured an actual JDBC count, rejected stale review and stopped on an unavailable capture.');
  return {...result,nativeWorkflowReview:verifiedReview,staleReviewRefused:staleReview};
}

module.exports={runHttpWorkflowChecks};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const proof=await verify(config,async text=>{
    const plan=await previewWorkflow(text,{});
    return runWorkflow(plan,{signal:AbortSignal.timeout(15000),assertFresh(){},
      prepare:(request,captureValues)=>resolveRequest(request,{},()=>{}, {captureValues}),
      send:ready=>sendRequest(ready)
    });
  });
  console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
