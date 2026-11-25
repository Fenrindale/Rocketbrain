'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');
const {expectedCompletionFixture,springJdbcClasspath,executeExpectedFixture}=require('./helpers/expected-completion-fixture');

async function runJavaExpectedCompletionChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath,project=await importedSpring(api,workspace);
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
  const config=JSON.parse(await fs.readFile(runtime.dbConfigPath,'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const classpath=await springJdbcClasspath(path.join(runtime.projectPath,'build/runtime-classpath.txt'),runtime.dbEngine);
  const name='RbExpectedValue'+randomBytes(5).toString('hex'),namespace='fixture.boot';
  const sample=expectedCompletionFixture(namespace,name,{spring:true});
  const file=path.join(workspace,'src/main/java/fixture/boot',name+'.java'),uri=vscode.Uri.file(file);
  const parent=await fs.realpath(os.tmpdir()),owned=await fs.mkdtemp(path.join(parent,'rb-native-java-completion-'));
  const service=api.javaSourceAnalysis;
  let document,created=false;

  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.completeExpectedValue'));
    await fs.writeFile(file,sample.source,{flag:'wx'});created=true;
    document=await vscode.workspace.openTextDocument(uri);
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    const source=document.getText();
    const point=source.indexOf('rows.stream().map')+'rows.'.length;
    assert.ok(point>5);
    await until(async()=>{
      const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',uri,document.positionAt(point));
      return completion?.items.some(item=>/\bstream\b/u.test(typeof item.label==='string'?item.label:item.label.label));
    },35000);
    const start=source.indexOf(sample.marker)+'row -> '.length;
    const draft=source.slice(0,start)+sample.prefix+source.slice(start+sample.value.length);
    const sourceRange=new vscode.Range(document.positionAt(start),document.positionAt(start+sample.value.length));
    assert.equal(await editor.edit(edit=>edit.replace(sourceRange,sample.prefix)),true);
    assert.equal(document.getText(),draft);
    assert.ok(document.isDirty);
    const position=document.positionAt(start+sample.prefix.length);
    async function retry(fn) {
      for (let attempt=0;;attempt++) {
        try { return await fn(); }
        catch (error) {
          if (attempt>=2||!/Compiler classpath file membership changed|A compiler runtime or classpath changed|classpath changed/iu.test(error.message)) throw error;
          await new Promise(resolve=>setTimeout(resolve,600));
        }
      }
    }
    const inspect=()=>retry(()=>service.inspectExpectedCompletion({document,position}));
    const stale=await inspect();
    assert.equal(stale.expectedType,sample.type);
    assert.equal(stale.context,'lambda');
    assert.match(stale.call,/java\.util\.stream\.Stream#map/u);
    assert.deepEqual(stale.candidates.map(item=>item.name),[sample.value]);
    await assert.rejects(service.applyExpectedCompletion(stale,'ticketWrong'),/type-compatible value/u);
    await assert.rejects(service.applyExpectedCompletion({...stale},sample.value),/type-compatible value/u);
    assert.equal(await editor.edit(edit=>edit.insert(document.positionAt(draft.length),'// stale edit\n')),true);
    await assert.rejects(service.applyExpectedCompletion(stale,sample.value),/changed/u);
    await vscode.commands.executeCommand('undo');
    await until(()=>document.getText()===draft,10000);
    assert.ok(document.isDirty);

    const applied=await retry(async()=>service.applyExpectedCompletion(await inspect(),sample.value));
    assert.equal(applied.state,'applied');
    assert.equal(document.getText(),source);
    assert.equal(applied.choice.kind,'LOCAL_VARIABLE');
    assert.equal(await fs.readFile(file,'utf8'),sample.source);
    await vscode.commands.executeCommand('undo');
    await until(()=>document.getText()===draft&&document.isDirty,10000);
    await vscode.commands.executeCommand('redo');
    await until(()=>document.getText()===source,10000);
    const java=path.join(owned,name+'.java'),binaryDirectory=await fs.mkdtemp(path.join(owned,'classes-'));
    await fs.writeFile(java,document.getText(),{flag:'wx'});
    const observed=await executeExpectedFixture({javaHome:project.jdk||api.java.getState().javaHome,file:java,
      binaryDirectory,className:namespace+'.'+name,classpath,config,engine:runtime.dbEngine});
    assert.equal(observed.output,sample.output);
    const jdbc=await jdbcReadback();assert.ok(jdbc);
    checks.push('Ordinary JDT completion and expected-type completion both worked in the imported Spring document.');
    checks.push('The dirty Stream lambda offered one correctly typed value, rejected forged and stale choices, and preserved the previous draft with Undo.');
    return {...observed,jdbc,expectedType:sample.type,selected:applied.choice.name,ordinaryJdtCompletion:true,
      exactGenericBinding:true,dirtyBuffer:true,forgedRefused:true,staleRefused:true,diskPreserved:true,nativeUndo:true};
  } finally {
    try {
      if(document?.isDirty){
        const editor=await vscode.window.showTextDocument(document,{preview:false});
        const text=new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length));
        await editor.edit(edit=>edit.replace(text,sample.source));
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

module.exports={runJavaExpectedCompletionChecks};
