'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function runHttpToolsChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  assert.equal(path.relative(root,config.projectPath),'');
  const file=path.join(root,'rb-http-fixture-'+randomUUID()+'.http');
  const uri=vscode.Uri.file(file);
  const contents='@host = '+config.baseUrl+'\n'+
    '# @expect status 200\n# @expect json $.people == 2\n# @expect json $.departments == 1\n'+
    '# @expect json $.rolledBackNames == 0\nGET {{host}}/probe/testing-state\n';
  await fs.writeFile(file,contents,{encoding:'utf8',flag:'wx'});
  try {
    const document=await vscode.workspace.openTextDocument(uri);
    assert.equal(document.languageId,'rocketbrain-http');
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    const where=document.positionAt(contents.indexOf('GET'));
    editor.selection=new vscode.Selection(where,where);
    const result=await vscode.commands.executeCommand('rocketbrain.http.run');
    assert.equal(result.status,200);
    assert.equal(result.assertions.length,4);
    assert.ok(result.assertions.every(item=>item.passed));
    const jdbc=JSON.parse(result.body);
    assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
    checks.push('The native HTTP file command resolved a document variable and verified four status/JSON assertions against the real Spring/JDBC endpoint.');
    const openApi=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify({
      openapi:'3.1.1',info:{title:'Spring Fixture',version:'1'},
      paths:{'/probe/testing-state':{get:{operationId:'databaseCounts',responses:{200:{description:'JDBC counts'}}}}}
    },null,2)});
    const report=api.openApi.analyze(openApi);
    assert.deepEqual(report.diagnostics,[]);
    assert.equal(report.operations[0].id,'databaseCounts');
    const generated='@baseUrl = '+config.baseUrl+'\n'+api.openApi.createRequest(openApi,'GET /probe/testing-state');
    const target=new vscode.WorkspaceEdit();
    target.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),generated);
    assert.equal(await vscode.workspace.applyEdit(target),true);
    assert.equal(await document.save(),true);
    const replay=await api.httpTools.run(document,generated.lastIndexOf('GET'));
    assert.equal(replay.status,200);
    assert.deepEqual(replay.assertions.map(item=>item.passed),[true]);
    assert.deepEqual(JSON.parse(replay.body),jdbc);
    checks.push('The OpenAPI JSON operation creates an HTTP draft that successfully reruns the same actual Spring database endpoint.');
    return { status:result.status,assertions:result.assertions.length,successful:true,openApiOperation:report.operations[0].id,
      generatedRequestRan:true,jdbc };
  } finally {
    if (vscode.window.activeTextEditor?.document.uri.toString()===uri.toString()) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await fs.unlink(file);
  }
}

async function exerciseHttpResponseChecks(config,run) {
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const contents=[
    '@host = '+config.baseUrl,
    '@resource = testing-state',
    '# @derive endpoint url-component "{{resource}}"',
    '# @expect status 200',
    '# @check jdbc ["all",["gte","status",200],["lt","status",300],["gte","json:$.people",2],["eq","json:$.departments",1],["eq","json:$.rolledBackNames",0]]',
    '# @check alternative ["any",["eq","json:$.unavailable",0],["exists","header:Content-Type"]]',
    '# @check absent ["not",["exists","json:$.unavailable"]]',
    '# @check too-many ["gt","json:$.people",2]',
    '# @check indeterminate ["not",["eq","json:$.unavailable",0]]',
    'GET {{host}}/probe/{{endpoint}}',''
  ].join('\n');
  const result=await run(contents);
  assert.equal(result.status,200);
  assert.deepEqual(result.assertions.map(({name,passed})=>[name,passed]),[
    [undefined,true],['jdbc',true],['alternative',true],['absent',true],['too-many',false],['indeterminate',false]
  ]);
  const jdbc=JSON.parse(result.body);
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  return {engine:config.dbEngine,derivedEndpoint:true,passedChecks:4,failedChecks:2,jdbc};
}

async function runHttpResponseChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  for (const name of ['build.gradle','settings.gradle']) {
    assert.deepEqual(await fs.readFile(path.join(root,name)),await fs.readFile(path.join(config.projectPath,name)));
  }
  const file=path.join(root,'rb-response-checks-'+randomUUID()+'.http');
  const uri=vscode.Uri.file(file);
  const proof=await exerciseHttpResponseChecks(config,async contents=>{
    await fs.writeFile(file,contents,{encoding:'utf8',flag:'wx'});
    try {
      const document=await vscode.workspace.openTextDocument(uri);
      assert.equal(document.languageId,'rocketbrain-http');
      const editor=await vscode.window.showTextDocument(document,{preview:false});
      const where=document.positionAt(contents.lastIndexOf('GET'));
      editor.selection=new vscode.Selection(where,where);
      return await vscode.commands.executeCommand('rocketbrain.http.run');
    } finally {
      if (vscode.window.activeTextEditor?.document.uri.toString()===uri.toString()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      await fs.unlink(file);
    }
  });
  checks.push('The installed HTTP command derived a route variable and separated passing Spring JDBC response expressions from failed and unknown expressions.');
  return {...proof,nativeCommand:true};
}

module.exports = { runHttpToolsChecks, exerciseHttpResponseChecks, runHttpResponseChecks };
