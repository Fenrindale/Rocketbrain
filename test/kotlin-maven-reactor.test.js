'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {fileURLToPath}=require('node:url');
const {reviewKotlinReactor,prepareKotlinReactor}=require('../src/java/kotlin-maven-reactor');
const {kotlinEditorLaunch,kotlinProtocolUri}=require('../src/java/kotlin-editor-runtime');
const {positionOf,StdioLsp,until}=require('./helpers/stdio-lsp');
const app=require('./helpers/kotlin-maven-editor');
const reactor=require('./helpers/kotlin-maven-reactor');

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, serverHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const mavenHome=process.env.ROCKETBRAIN_KOTLIN_MAVEN_HOME;
const configs=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_KOTLIN_MAVEN_'+engine.toUpperCase()+'_CONFIG']]);

test('selected Kotlin Maven module sees an isolated sibling artifact with invalid app source left editable', {
  skip:!config||!serverHome||!mavenHome||configs.some(([,file])=>!file),timeout:330000
},async t=>{
  const temp=await fs.realpath(os.tmpdir()),owned=await fs.mkdtemp(path.join(temp,'rb-maven-reactor-test-'));
  t.after(async()=>{
    const real=await fs.realpath(owned);
    assert.equal(real,owned);
    assert.equal(path.dirname(real),temp);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const root=path.join(owned,'Maven Reactor'),project=path.join(root,'app'),source=path.join(project,app.source);
  await fs.cp(reactor.fixture,root,{recursive:true});
  const original=await fs.readFile(source,'utf8'),invalid=reactor.invalid(original);
  await fs.writeFile(source,invalid);
  const {javaHome}=JSON.parse(await fs.readFile(config,'utf8'));
  const options={project,workspace:owned,tools:{javaHome,mavenHome}};
  const plan=reviewKotlinReactor(options);
  assert.deepEqual(plan.report.steps,['.','contract']);
  assert.equal(plan.report.module,'app');
  assert.equal(plan.report.dependencies[0].coordinates,'rocketbrain.fixture:inventory-contract:1.0.0');
  const descriptor=path.join(project,'pom.xml'),pom=await fs.readFile(descriptor,'utf8');
  await fs.writeFile(descriptor,pom.replace('<artifactId>inventory-contract</artifactId>',
    '<artifactId>inventory-contract</artifactId><scope>test</scope>'));
  assert.throws(()=>reviewKotlinReactor(options),/compile or provided scope/u);
  await fs.writeFile(descriptor,pom);
  assert.throws(()=>reviewKotlinReactor({...options,dirty:file=>!path.relative(file,path.join(root,reactor.moduleSource))}),
    /Save bounded Maven dependency source files/u);
  const child=path.join(root,reactor.moduleSource),definition=await fs.readFile(child,'utf8');
  await fs.appendFile(child,'\n');
  assert.notEqual(reviewKotlinReactor(options).fingerprint,plan.fingerprint);
  await fs.writeFile(child,definition);
  await assert.rejects(fs.stat(path.join(project,'target')));
  let prepared;
  try {
    prepared=await prepareKotlinReactor(plan);
    assert.equal(prepared.artifacts.length,1);
    assert.ok((await fs.stat(prepared.artifacts[0].file)).size>1000);
    await assert.rejects(fs.stat(path.join(project,'target')));
    await assert.rejects(fs.stat(path.join(root,'unrelated','target')));
    assert.equal(await fs.readFile(source,'utf8'),invalid);
    const launch=await kotlinEditorLaunch({serverHome,javaHome,mavenHome,root:project,storageRoot:owned,reactor:prepared});
    const lsp=new StdioLsp(launch);
    const rootUri=kotlinProtocolUri(project),uri=kotlinProtocolUri(source);
    let semantic;
    try {
      const init=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
        workspaceFolders:[{uri:rootUri,name:'Kotlin Maven app'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
          textDocument:{completion:{completionItem:{snippetSupport:false}},hover:{contentFormat:['markdown','plaintext']}}}},120000);
      assert.ok(init.capabilities.completionProvider&&init.capabilities.hoverProvider&&init.capabilities.definitionProvider);
      lsp.notify('initialized',{});
      lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'kotlin',version:1,text:invalid}});
      const diagnostics=from=>lsp.notifications.slice(from).filter(entry=>entry.method==='textDocument/publishDiagnostics'&&
        entry.params.uri&&!path.relative(fileURLToPath(entry.params.uri),source));
      const error=await until(()=>diagnostics(0).flatMap(entry=>entry.params.diagnostics)
        .find(item=>item.severity===1&&reactor.mismatch(item)),50000);
      assert.equal(error.range.start.line,9);
      const change=(version,text)=>lsp.notify('textDocument/didChange',{textDocument:{uri,version},contentChanges:[{text}]});
      const partial=reactor.partial(original);
      change(2,partial);
      const list=await until(async()=>{
        const response=await lsp.request('textDocument/completion',{textDocument:{uri},
          position:positionOf(partial,reactor.receiver,reactor.receiver.length)},25000);
        return (response?.items||response||[]).find(reactor.completion);
      },50000);
      const from=lsp.notifications.length;
      change(3,original);
      await until(()=>diagnostics(from).some(entry=>entry.params.diagnostics.every(item=>item.severity!==1)),45000);
      assert.equal(await fs.readFile(source,'utf8'),invalid);
      const local={textDocument:{uri},position:positionOf(original,'invoice.number',10)};
      const definition=await until(async()=>{
        const locations=await lsp.request('textDocument/definition',local,25000);
        return locations?.find(location=>!path.relative(fileURLToPath(location.uri||location.targetUri),path.join(project,app.definition)));
      },35000);
      assert.equal((definition.range||definition.targetSelectionRange).start.line,2);
      const hover=await lsp.request('textDocument/hover',local);
      assert.match(JSON.stringify(hover),/number: String/u);
      semantic={completion:list.label,type:'String',diagnostic:{code:error.code,line:10,clearedInUnsavedBuffer:true},localDeclaration:'Invoice.kt'};
    } finally {
      try {await lsp.close();}
      finally {await launch.dispose();}
    }
    await fs.writeFile(source,original);
    const built=await app.build(project,{javaHome,mavenHome,repository:prepared.repository});
    const jdbc=[];
    for (const [engine,file] of configs) jdbc.push(await app.jdbc(project,built,engine,file));
    await assert.rejects(fs.stat(path.join(root,'unrelated','target')));
    const repository=prepared.repository;
    await prepared.dispose();
    await assert.rejects(fs.stat(repository));
    const receipt=process.env.ROCKETBRAIN_KOTLIN_MAVEN_RECEIPT;
    if (receipt) await fs.writeFile(receipt,JSON.stringify({module:plan.report.module,prepared:plan.report.steps,
      artifact:plan.report.dependencies[0].coordinates,maven:built.mavenVersion,server:launch.serverVersion,compiler:launch.compilerVersion,
      semantic,jdbc,applicationExcludedDuringPreparation:true,unrelatedModuleExcluded:true,repositoryCleaned:true},null,2)+'\n');
  } finally {await prepared?.dispose();}
});
