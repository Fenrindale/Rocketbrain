'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { instanceInlineFixture, springJdbcClasspath, runInstanceInline } = require('./helpers/instance-inline-fixture');

async function runJavaInstanceInlineChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, workspace);
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath,'utf8'));
  const classpath = await springJdbcClasspath(path.join(runtime.projectPath,'build/runtime-classpath.txt'),runtime.dbEngine);
  const name = 'RbInlineInstance' + randomBytes(5).toString('hex'), namespace = 'fixture.boot';
  const sample = instanceInlineFixture(namespace,name,{spring:true});
  const file = path.join(workspace,'src/main/java/fixture/boot',name+'.java'), uri = vscode.Uri.file(file);
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent,'rb-native-inline-instance-'));
  const service = api.javaSourceAnalysis;
  const run = async source => {
    const binaryDirectory = await fs.mkdtemp(path.join(owned,'classes-')), java = path.join(owned,name+'.java');
    await fs.writeFile(java,source);
    return runInstanceInline({javaHome:project.jdk||api.java.getState().javaHome,file:java,binaryDirectory,
      className:namespace+'.'+name,classpath,config,engine:runtime.dbEngine});
  };
  let document, created = false;
  try {
    await fs.writeFile(file,sample.source,{flag:'wx'});
    created = true;
    document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document,{preview:false});
    const source = document.getText();
    const range = (marker,offset) => {
      const index = source.indexOf(marker,offset||0);
      assert.ok(index>=0,marker);
      return new vscode.Range(document.positionAt(index),document.positionAt(index+marker.length));
    };
    const selected = range(sample.call), explicit = range('calculate',source.indexOf('var value = this.'));
    for (const selection of [selected,explicit]) {
      const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',uri,selection,'refactor.inline',25);
      const action = actions?.find(item=>item.command?.command==='rocketbrain.java.inlineMethod');
      assert.ok(action,'Both instance forms have a native Inline Method action.');
      assert.equal(action.edit,undefined);
    }
    async function preview(selection) {
      for (let attempt=0;;attempt++) {
        try { return await service.prepareInlineMethod({document,range:selection}); }
        catch (error) {
          if (attempt>=2||document.isDirty||!/Compiler classpath file membership changed|A compiler runtime or classpath changed|classpath changed/iu.test(error.message)) throw error;
          await new Promise(resolve=>setTimeout(resolve,600));
        }
      }
    }
    await assert.rejects(preview(range(sample.nullable)),/newly constructed same-class receiver/u);
    const plan = await preview(selected);
    assert.deepEqual(plan.inline,{method:'calculate',owner:namespace+'.'+name,returnType:'int',arguments:3,
      parameterReferences:3,selectedCalls:1,receiverKind:'new',fieldReads:2});
    assert.equal(plan.documents.length,1);
    assert.equal(plan.documents[0].edits.length,1);
    assert.deepEqual(plan.resourceOperations,[]);
    const after=plan.documents[0].after;
    assert.ok(after.includes(namespace+'.'+name+' rbInlineReceiver2 = new '+name+'(10);'));
    assert.ok(after.includes('rbInlineReceiver2.offset + rbInlineReceiver2.bias'));
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
    assert.equal(diff.getText().replace(/\r\n/g,'\n'),after.replace(/\r\n/g,'\n'));
    assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
    assert.equal(document.getText(),after);
    assert.equal(await fs.readFile(file,'utf8'),sample.source);
    const beforeRun=await run(source), afterRun=await run(after);
    assert.deepEqual(afterRun,beforeRun);
    assert.equal(afterRun.output,sample.output);
    await vscode.window.showTextDocument(document,{preview:false});
    await vscode.commands.executeCommand('undo');
    await until(()=>document.getText()===source&&!document.isDirty,10000);
    const stale = await preview(explicit);
    assert.equal(stale.inline.receiverKind,'this');
    assert.match(stale.documents[0].after,/this\.offset \+ this\.bias/u);
    assert.equal(await editor.edit(change=>change.insert(document.positionAt(source.length),'// owned stale review\n')),true);
    await assert.rejects(api.java.refactoring.apply(stale.id),/changed/u);
    await vscode.commands.executeCommand('undo');
    await until(()=>document.getText()===source&&!document.isDirty,10000);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc);
    checks.push('The installed Java inline action previews constructed and explicit this receivers, with isolated receiver and field bindings.');
    checks.push('Source preview and Undo preserved disk bytes. Original and inlined programs produced identical constructor, argument and field results on Spring JDBC.');
    return {...afterRun,jdbc,nativeAction:true,constructorBeforeArguments:true,argumentOrder:[1,2,3],fieldReads:2,
      nullableRefused:true,staleRefused:true,nativeDiff:true,nativeUndo:true,sourceDiskPreserved:true};
  } finally {
    try {
      if (document?.isDirty) {
        const editor=await vscode.window.showTextDocument(document,{preview:false});
        await editor.edit(change=>change.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),sample.source));
        await document.save();
      }
    } finally {
      if(created)await fs.rm(file,{force:true});
      assert.equal(await fs.realpath(owned),owned);
      assert.equal(path.dirname(owned),parent);
      await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:200});
    }
  }
}

module.exports={runJavaInstanceInlineChecks};
