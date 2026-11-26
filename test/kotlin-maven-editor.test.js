'use strict';

const assert=require('node:assert/strict');
const os=require('node:os');
const path=require('node:path');
const fs=require('node:fs/promises');
const {fileURLToPath}=require('node:url');
const {test}=require('node:test');
const {kotlinEditorLaunch,kotlinProtocolUri,kotlinProjectRoot,kotlinBuildTool}=require('../src/java/kotlin-editor-runtime');
const {StdioLsp,positionOf,until}=require('./helpers/stdio-lsp');
const fixture=require('./helpers/kotlin-maven-editor');

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const serverHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const mavenHome=process.env.ROCKETBRAIN_KOTLIN_MAVEN_HOME;
const configs=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_KOTLIN_MAVEN_'+engine.toUpperCase()+'_CONFIG']]);

async function useTemp(t,callback) {
  const parent=await fs.realpath(os.tmpdir()),owned=await fs.mkdtemp(path.join(parent,'rb-kotlin-maven-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(owned),owned);
    assert.equal(path.dirname(owned),parent);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  return callback(owned);
}

test('Kotlin source selects its exact Maven component and rejects mixed and aggregate build roots',t=>useTemp(t,async owned=>{
  const maven=path.join(owned,'app'),nested=path.join(maven,'demo');
  await fs.mkdir(nested,{recursive:true});
  const pom=path.join(maven,'pom.xml');
  await fs.writeFile(pom,'<project/>');
  const source=path.join(maven,'src/main/kotlin/Demo.kt');
  const check=()=>kotlinEditorLaunch({root:maven,serverHome:owned});
  assert.equal(kotlinProjectRoot(source,owned),maven);
  assert.equal(kotlinBuildTool(maven),'maven');
  await fs.writeFile(path.join(nested,'pom.xml'),'<project/>');
  assert.equal(kotlinProjectRoot(path.join(nested,'src/Demo.kt'),owned),nested);
  await assert.rejects(check(),/one POM and no additional classpath provider/u);
  await fs.unlink(path.join(nested,'pom.xml'));
  await fs.writeFile(pom,'<project><modules><module>../elsewhere</module></modules></project>');
  await assert.rejects(check(),/Reactor aggregation/u);
  await fs.writeFile(pom,'<!DOCTYPE project><project/>');
  await assert.rejects(check(),/document type declaration/u);
  await fs.writeFile(pom,'<project/>');
  const script=path.join(nested,'kls-classpath.cmd');
  await fs.writeFile(script,'@exit /b 1');
  await assert.rejects(check(),/additional classpath provider/u);
  await fs.unlink(script);
  await fs.writeFile(path.join(maven,'build.gradle.kts'),'');
  await fs.writeFile(path.join(maven,'settings.gradle.kts'),'');
  assert.throws(()=>kotlinProjectRoot(source,owned),/both Maven and Gradle/u);
}));

test('Kotlin Maven imports real Spring types for completion, declaration and live diagnostics', {
  skip:!config || !serverHome || !mavenHome || !configs.every(([,file])=>file),timeout:270000
},t=>useTemp(t,async owned=>{
  const root=path.join(owned,'Maven Project');
  await fs.cp(fixture.fixture,root,{recursive:true});
  const {javaHome}=JSON.parse(await fs.readFile(config,'utf8'));
  const spec=await fixture.build(root,{javaHome,mavenHome});
  const storageRoot=path.join(owned,'vscode-profile-'.padEnd(80,'a'),'workspaceStorage-'.padEnd(80,'a'),'rocketbrain-local.rocketbrain');
  const launch=await kotlinEditorLaunch({root,serverHome,javaHome,mavenHome,storageRoot});
  assert.equal(launch.buildTool,'maven');
  const pathKey=Object.keys(launch.options.env).find(key=>key.toLowerCase()==='path');
  assert.equal(path.relative(path.join(mavenHome,'bin'),launch.options.env[pathKey].split(path.delimiter)[0]),'');
  const lsp=new StdioLsp(launch);
  const entry=path.join(root,fixture.source),target=path.join(root,fixture.definition),uri=kotlinProtocolUri(entry),rootUri=kotlinProtocolUri(root);
  const source=await fs.readFile(entry,'utf8');
  let semantic;
  try {
    const ready=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:root,workspaceFolders:[{uri:rootUri,name:'Maven Kotlin'}],
      capabilities:{workspace:{configuration:true,workspaceFolders:true},textDocument:{completion:{
        completionItem:{snippetSupport:false}},hover:{contentFormat:['markdown','plaintext']}}}},90000);
    assert.ok(ready.capabilities.completionProvider&&ready.capabilities.definitionProvider);
    lsp.notify('initialized',{});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'kotlin',version:1,text:source}});
    const request=(method,text,needle,offset)=>lsp.request(method,{textDocument:{uri},position:positionOf(text,needle,offset)},25000);
    const reference=await until(async()=>{
      const definitions=await request('textDocument/definition',source,'invoice.number',10);
      return definitions?.find(item=>!path.relative(fileURLToPath(item.uri||item.targetUri),target));
    },50000);
    const range=reference.range||reference.targetSelectionRange;
    assert.deepEqual(range.start,{line:2,character:23});
    const hover=await request('textDocument/hover',source,'invoice.number',10);
    assert.match(JSON.stringify(hover),/number: String/u);
    const change=(version,text)=>lsp.notify('textDocument/didChange',{textDocument:{uri,version},contentChanges:[{text}]});
    const partial=fixture.partial(source);
    change(2,partial);
    const completion=await until(async()=>{
      const list=await request('textDocument/completion',partial,fixture.completeText,fixture.completeText.length);
      return (list?.items||list||[]).find(fixture.isTypedCompletion);
    },55000);
    const diagnostics=from=>lsp.notifications.slice(from).filter(msg=>msg.method==='textDocument/publishDiagnostics'&&
      msg.params.uri&&!path.relative(fileURLToPath(msg.params.uri),entry));
    const from=lsp.notifications.length;
    change(3,fixture.invalid(source));
    const problem=await until(()=>diagnostics(from).flatMap(msg=>msg.params.diagnostics)
      .find(item=>item.severity===1&&fixture.findMismatch(item)),45000);
    assert.equal(problem.range.start.line,8);
    assert.equal(await fs.readFile(entry,'utf8'),source);
    const reset=lsp.notifications.length;
    change(4,source);
    await until(()=>diagnostics(reset).some(msg=>msg.params.diagnostics.every(item=>item.severity!==1)),45000);
    semantic={completion:completion.label,detail:completion.detail,definition:{file:'Invoice.kt',line:3,column:24},hover:'String',
      diagnostic:{code:problem.code,line:9,unsaved:true,cleared:true}};
  } finally {
    try {await lsp.close();}
    finally {await launch.dispose();}
  }
  const reports=[];
  for (const [engine,file] of configs) reports.push(await fixture.jdbc(root,spec,engine,file));
  if (process.env.ROCKETBRAIN_KOTLIN_MAVEN_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_KOTLIN_MAVEN_RECEIPT,
    JSON.stringify({buildTool:launch.buildTool,maven:spec.mavenVersion,server:launch.serverVersion,compiler:launch.compilerVersion,
      semantic,reports,stopped:true},null,2)+'\n');
}));
