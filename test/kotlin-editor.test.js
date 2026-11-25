'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath,pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StdioLsp,until,positionOf } = require('./helpers/stdio-lsp');
const { buildSpec } = require('../src/java/workbench-tasks');
const { kotlinEditorLaunch,hasGradleFiles,kotlinProtocolUri } = require('../src/java/kotlin-editor-runtime');

const execute=promisify(execFile), fixture=path.join(__dirname,'fixtures','java','kotlin-editor');
const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, serverHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;

test('Kotlin editor URIs retain Unicode spelling while preserving reserved path delimiters',async () => {
  const file=path.join(fixture,'한글 #!.kt'), uri=kotlinProtocolUri(file);
  assert.match(uri,/한글%20%23/);
  assert.equal(fileURLToPath(uri),file);
  assert.equal(hasGradleFiles(fixture),true);
  await assert.rejects(kotlinEditorLaunch({root:fixture,serverHome:'relative'}),/extracted open ktlsp/);
});

test('open ktlsp on a compiled Gradle JVM fixture serves typed completion, definitions, hover and live diagnostics',{
  skip:!serverHome || !javaConfig,timeout:280000
},async context => {
  const parent=await fs.realpath(os.tmpdir()), owned=await fs.mkdtemp(path.join(parent,'rb-ktlsp-test-'));
  const root=path.join(owned,'project');
  context.after(async () => {
    const resolved=await fs.realpath(owned);
    assert.equal(resolved,owned);
    assert.equal(path.dirname(resolved),parent);
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await fs.cp(fixture,root,{recursive:true});
  const {javaHome,gradleHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const gradleUserHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME || path.join(owned,'gradle-cache');
  const spec=buildSpec({root,tool:'gradle',uri:pathToFileURL(root).href,name:'Kotlin editor'},{javaHome,gradleHome},['compileKotlin']);
  const built=await execute(spec.command,spec.args,{cwd:spec.cwd,env:{...spec.env,GRADLE_USER_HOME:gradleUserHome},
    windowsHide:true,timeout:110000,maxBuffer:3*1024*1024});
  assert.match(built.stdout,/BUILD SUCCESSFUL/);
  assert.ok((await fs.stat(path.join(root,'build/classes/kotlin/main/editor/fixture/Invoice.class'))).size>200);
  const launch=await kotlinEditorLaunch({serverHome,javaHome,gradleHome,gradleUserHome,storageRoot:path.join(owned,'language-data'),root});
  assert.equal(launch.windowsPathAdapter,process.platform==='win32');
  const lsp=new StdioLsp(launch);
  const entry=path.join(root,'src/main/kotlin/editor/fixture/OrderSummary.kt');
  const target=path.join(root,'src/main/kotlin/editor/fixture/Invoice.kt');
  const uri=kotlinProtocolUri(entry), rootUri=kotlinProtocolUri(root);
  const realSource=await fs.readFile(entry,'utf8');
  const params={textDocument:{uri},position:positionOf(realSource,'invoice.number',10)};
  let proof;
  try {
    const init=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:root,
      workspaceFolders:[{uri:rootUri,name:'kotlin-editor'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
        textDocument:{completion:{completionItem:{snippetSupport:false}},hover:{contentFormat:['markdown','plaintext']}}}},90000);
    assert.ok(init.capabilities.completionProvider && init.capabilities.definitionProvider && init.capabilities.hoverProvider);
    lsp.notify('initialized',{});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'kotlin',version:1,text:realSource}});
    const definition=await until(async()=>{
      const locations=await lsp.request('textDocument/definition',params,30000);
      return locations?.find(item => !path.relative(fileURLToPath(item.uri || item.targetUri),target));
    },65000);
    assert.equal(definition.range.start.line,3);
    const hover=await lsp.request('textDocument/hover',params);
    assert.match(JSON.stringify(hover),/number: String/);
    const edit=(version,text)=>lsp.notify('textDocument/didChange',{textDocument:{uri,version},contentChanges:[{text}]});
    const partial=realSource.replace('invoice.number','invoice.num');
    edit(2,partial);
    const completion=await until(async()=>{
      const list=await lsp.request('textDocument/completion',{textDocument:{uri},position:positionOf(partial,'invoice.num',11)},30000);
      return (list?.items || list || []).find(item=>item.label==='number' && /String/.test(item.detail));
    },50000);
    const diagnosticUpdates=after=>lsp.notifications.slice(after).filter(item => item.method==='textDocument/publishDiagnostics' &&
      item.params.uri && !path.relative(fileURLToPath(item.params.uri),entry));
    const bad=realSource.replace('val number = invoice.number','val number: String = 42'), before=lsp.notifications.length;
    edit(3,bad);
    const problem=await until(()=>diagnosticUpdates(before).flatMap(item=>item.params.diagnostics)
      .find(item=>item.code==='CONSTANT_EXPECTED_TYPE_MISMATCH' && item.severity===1),65000);
    assert.equal(problem.range.start.line,3);
    assert.equal(await fs.readFile(entry,'utf8'),realSource);
    const repaired=lsp.notifications.length;
    edit(4,realSource);
    await until(()=>diagnosticUpdates(repaired).find(item=>item.params.diagnostics.length===0),45000);
    proof={server:launch.serverVersion,compiler:launch.compilerVersion,gradleCompiled:true,
      completion:completion.label,hoverType:'String',definition:{name:path.basename(target),line:definition.range.start.line+1},
      diagnostic:{code:problem.code,line:problem.range.start.line+1,unsaved:true,cleared:true},windowsPathAdapter:launch.windowsPathAdapter};
  } finally {
    try {await lsp.close();}
    finally {await launch.dispose();}
  }
  if (process.platform==='win32') await assert.rejects(fs.stat(launch.args.at(-2).split(path.delimiter)[0]));
  if (process.env.ROCKETBRAIN_KOTLIN_EDITOR_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_KOTLIN_EDITOR_RECEIPT,JSON.stringify({...proof,stopped:true},null,2)+'\n');
  }
});
