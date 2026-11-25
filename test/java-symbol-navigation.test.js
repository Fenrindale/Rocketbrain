'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath,pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { StdioLsp,positionOf,until } = require('./helpers/stdio-lsp');
const { buildSpec } = require('../src/java/workbench-tasks');
const { execute } = require('../src/java/testing/provision');
const { kotlinEditorLaunch,kotlinProtocolUri } = require('../src/java/kotlin-editor-runtime');
const { createSymbolNavigation } = require('../src/java/navigation-symbols');
const { javaNavigationFixture,kotlinExtensionSources } = require('./helpers/java-symbol-navigation-fixture');

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const serverHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const resources = record => record.uri || record.targetUri;
const span = record => record.targetSelectionRange || record.range;

async function ownedDirectory(t,prefix) {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent,prefix));
  t.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(real,owned);
    assert.equal(path.dirname(real),parent);
    assert.ok(path.basename(real).startsWith(prefix));
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  return owned;
}

test('navigation reveals the selected local source and refuses fabricated, stale and external targets',async t => {
  const owned = await ownedDirectory(t,'rb-symbol-guard-');
  const origin = path.join(owned,'Origin.java'),target = path.join(owned,'Target.java');
  await fs.writeFile(origin,'Target target;\n');
  await fs.writeFile(target,'class Target {}\n');
  const parse = value => {
    const url = new URL(value),scheme=url.protocol.slice(0,-1);
    return {scheme,authority:url.host,fragment:url.hash,query:url.search,path:url.pathname,
      fsPath:scheme==='file'?fileURLToPath(value):url.pathname,toString:()=>value};
  };
  const uri = file => parse(pathToFileURL(file).href);
  const originUri=uri(origin),targetUri=uri(target),documents=new Map();
  const folder={uri:uri(owned)};
  let displayed;
  const vscode={Uri:{parse},Position:class {constructor(line,character){Object.assign(this,{line,character});}},
    Range:class {constructor(l,c,r,d){this.start={line:l,character:c};this.end={line:r,character:d};}},
    CancellationTokenSource:class {token={isCancellationRequested:false};cancel(){} dispose(){}},
    workspace:{isTrusted:true,get textDocuments(){return [...documents.values()];},getWorkspaceFolder(value){
      const relative=path.relative(owned,value.fsPath);
      return value.scheme==='file'&&!relative.startsWith('..')&&!path.isAbsolute(relative)?folder:undefined;
    },async openTextDocument(value){
      if(!documents.has(value.toString()))documents.set(value.toString(),{uri:value,languageId:'java',version:1,
        getText:()=>value.fsPath===origin?'Target target;\n':'class Target {}\n',validatePosition:position=>position});
      return documents.get(value.toString());
    }},window:{async showTextDocument(document,options){displayed={document,options};}}};
  const range={start:{line:0,character:6},end:{line:0,character:12}};
  const location={targetUri:targetUri.toString(),targetSelectionRange:range};
  const state={state:'running',runtimeIdentity:'owned-runtime'};
  const java={start:async()=>state,getState:()=>state,navigationLocations:async()=>[location,location,
    {uri:'https://example.invalid/Source.java',range},{uri:uri(path.join(path.dirname(owned),'outside.java')).toString(),range}]};
  const service=createSymbolNavigation(vscode,java);
  const report=await service.inspect({kind:'declaration',uri:originUri,position:{line:0,character:2}});
  assert.equal(report.total,4);
  assert.deepEqual(report.targets.map(item=>item.uri),[targetUri.toString()]);
  await assert.rejects(service.reveal({...report},0),/current navigation result/);
  await service.reveal(report,0);
  assert.equal(displayed.document.uri.toString(),targetUri.toString());
  assert.deepEqual(displayed.options.selection.start,range.start);
  await fs.appendFile(target,'// moved after review\n');
  await assert.rejects(service.reveal(report,0),/destination changed/);
  const reread=await service.inspect({kind:'declaration',uri:originUri,position:{line:0,character:2}});
  documents.get(originUri.toString()).version++;
  await assert.rejects(service.reveal(reread,0),/source or its language server changed/);
  vscode.workspace.isTrusted=false;
  await assert.rejects(service.reveal(reread,0),/Trust the workspace/);
  service.dispose();
});

test('real JDT resolves Java declarations, attributed types, exact overload implementations and the nearest super method',{
  skip:!javaConfig,timeout:185000
},async t => {
  const runtime = JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const settings = runtime.settings || runtime;
  const javaHome = runtime.javaHome || settings['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || settings['rocketbrain.java.serverPath'];
  const owned = await ownedDirectory(t,'rb-symbol-java-');
  const project = path.join(owned,'project'), rootUri = pathToFileURL(project).href;
  const sourceRoot = path.join(project,'src/main/java/navfixture');
  const sources = javaNavigationFixture('navfixture');
  const file = name => path.join(sourceRoot,name+'.java');
  const uri = name => pathToFileURL(file(name)).href;
  await fs.mkdir(sourceRoot,{recursive:true});
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  for (const [name,text] of Object.entries(sources)) await fs.writeFile(file(name),text,{flag:'wx'});
  const jdkSettings = serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const lsp = new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(owned,'jdt')}));
  const at = (name,marker,shift=0) => ({textDocument:{uri:uri(name)},position:positionOf(sources[name],marker,shift)});
  let proof;
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'navigation-fixture'}],
      capabilities:{workspace:{configuration:true},textDocument:{definition:{linkSupport:true},typeDefinition:{linkSupport:true},implementation:{linkSupport:true}}},
      initializationOptions:{workspaceFolders:[rootUri],settings:jdkSettings,extendedClientCapabilities:{classFileContentsSupport:true}}},75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings:jdkSettings});
    for (const [name,text] of Object.entries(sources)) lsp.notify('textDocument/didOpen',{textDocument:{uri:uri(name),languageId:'java',version:1,text}});
    const declaration = await until(async () => (await lsp.request('textDocument/definition',at('Navigator','renderer.render(42)',11)))?.[0],65000);
    assert.equal(path.relative(fileURLToPath(resources(declaration)),file('Renderer')),'');
    assert.equal(span(declaration).start.line,3);
    const [type] = await lsp.request('textDocument/typeDefinition',at('Navigator','renderer.render(42)',3));
    assert.equal(path.relative(fileURLToPath(resources(type)),file('Renderer')),'');
    assert.equal(span(type).start.line,2);
    const implementations = await until(async () => {
      const rows = await lsp.request('textDocument/implementation',at('Renderer','render(int value)',2));
      return rows?.length >= 2 ? rows : undefined;
    },65000);
    const owners = implementations.map(item => path.basename(fileURLToPath(resources(item)),'.java')).sort();
    assert.ok(owners.includes('FirstRenderer')&&owners.includes('SecondRenderer'),JSON.stringify(owners));
    assert.ok(implementations.every(item => span(item).start.line === 3),JSON.stringify(implementations));
    const referenced = await lsp.request('textDocument/references',{...at('Renderer','render(int value)',2),context:{includeDeclaration:false}});
    assert.deepEqual(referenced.filter(item => !path.relative(fileURLToPath(resources(item)),file('Navigator')))
      .map(item => span(item).start.line),[4]);
    const superLink = await lsp.request('java/findLinks',{type:'superImplementation',position:at('FirstRenderer','render(int value)',2)});
    assert.equal(superLink.length,1);
    assert.equal(superLink[0].displayName,'navfixture.BaseRenderer.render');
    assert.equal(path.relative(fileURLToPath(resources(superLink[0])),file('BaseRenderer')),'');
    assert.equal(span(superLink[0]).start.line,3);
    assert.deepEqual(await lsp.request('java/findLinks',{type:'superImplementation',position:at('Navigator','String run()',8)}),[]);
    const [library] = await lsp.request('textDocument/definition',at('Navigator','Integer.toHexString(42)',11));
    assert.match(resources(library),/^jdt:\/\/contents\//);
    assert.match(decodeURIComponent(resources(library)),/Integer\.class/);
    const jdkSource = await lsp.request('java/classFileContents',{uri:resources(library)});
    const {start,end} = span(library);
    assert.equal(start.line,end.line);
    assert.equal(jdkSource.split(/\r?\n/)[start.line].slice(start.character,end.character),'toHexString');
    proof={jdt:'1.63.0',declaration:true,typeDeclaration:true,implementationOwners:owners,sameNameOverloadExcluded:true,exactReferenceLines:[5],
      nearestSuper:true,noSuperHandled:true,jdkSourceOpened:true};
  } finally { await lsp.close(); }
  const bin = name => path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  const classes = path.join(owned,'classes');
  await fs.mkdir(classes);
  const compiled = await execute(bin('javac'),['-d',classes,...Object.keys(sources).map(file)]);
  assert.equal(compiled.code,0,compiled.output);
  const run = await execute(bin('java'),['-cp',classes,'navfixture.Navigator']);
  assert.equal(run.code,0,run.output);
  assert.equal(run.output,'first:42');
  if (process.env.ROCKETBRAIN_JAVA_NAVIGATION_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_JAVA_NAVIGATION_RECEIPT,
    JSON.stringify({...proof,compiledAndRan:true,output:run.output},null,2)+'\n');
});

test('real Kotlin analysis follows distinct same-name extension declarations by receiver type',{
  skip:!javaConfig || !serverHome,timeout:240000
},async t => {
  const {javaHome,gradleHome} = JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const owned = await ownedDirectory(t,'rb-symbol-kotlin-');
  const project = path.join(owned,'project');
  await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),project,{recursive:true});
  const sources = kotlinExtensionSources();
  const directory = path.join(project,'src/main/kotlin/editor/fixture');
  for (const [file,text] of Object.entries(sources)) await fs.writeFile(path.join(directory,file),text,{flag:'wx'});
  const gradleUserHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME || path.join(owned,'gradle');
  const spec = buildSpec({root:project,tool:'gradle',uri:pathToFileURL(project).href,name:'Kotlin navigation'},
    {javaHome,gradleHome},['compileKotlin']);
  const built = await execute(spec.command,spec.args,{cwd:spec.cwd,env:{...spec.env,GRADLE_USER_HOME:gradleUserHome},timeoutMs:110000});
  assert.equal(built.code,0,built.output);
  assert.match(built.output,/BUILD SUCCESSFUL/);
  const launch = await kotlinEditorLaunch({serverHome,javaHome,gradleHome,gradleUserHome,storageRoot:path.join(owned,'kotlin-storage'),root:project});
  const lsp = new StdioLsp(launch), rootUri = kotlinProtocolUri(project);
  const source = sources['ExtensionCaller.kt'], sourceUri = kotlinProtocolUri(path.join(directory,'ExtensionCaller.kt'));
  const proof = {};
  try {
    const started = await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'Kotlin navigation'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},textDocument:{definition:{linkSupport:true}}}},90000);
    assert.ok(started.capabilities.definitionProvider);
    assert.ok(started.capabilities.referencesProvider,'The pinned Kotlin server advertises exact references.');
    lsp.notify('initialized',{});
    for (const [filename,text] of Object.entries(sources)) lsp.notify('textDocument/didOpen',{textDocument:{
      uri:kotlinProtocolUri(path.join(directory,filename)),languageId:'kotlin',version:1,text}});
    for (const [receiver,target] of [['invoice','InvoiceExtension.kt'],['value','StringExtension.kt']]) {
      const params = {textDocument:{uri:sourceUri},position:positionOf(source,receiver+'.ticketLabel()',receiver.length+3)};
      const locations = await until(async () => {
        const result = await lsp.request('textDocument/definition',params,35000);
        return result?.length ? result : undefined;
      },65000);
      assert.equal(locations.length,1);
      const [location] = locations;
      assert.equal(path.relative(fileURLToPath(resources(location)),path.join(directory,target)),'');
      assert.equal(span(location).start.line,2);
      const references = await lsp.request('textDocument/references',{textDocument:{uri:kotlinProtocolUri(path.join(directory,target))},
        position:positionOf(sources[target],'ticketLabel',3),context:{includeDeclaration:false}},45000);
      const uses = references.filter(reference => !path.relative(fileURLToPath(resources(reference)),fileURLToPath(sourceUri)));
      assert.deepEqual(uses.map(reference => span(reference).start.line),[receiver==='invoice'?2:3],JSON.stringify(references));
      const {start,end} = span(uses[0]);
      assert.equal(source.split('\n')[start.line].slice(start.character,end.character),'ticketLabel');
      proof[receiver]=target;
    }
  } finally { try { await lsp.close(); } finally { await launch.dispose(); } }
  if (process.env.ROCKETBRAIN_KOTLIN_NAVIGATION_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_KOTLIN_NAVIGATION_RECEIPT,
    JSON.stringify({server:launch.serverVersion,compiler:launch.compilerVersion,gradleCompiled:true,
      sameNameReceiverOverloads:proof,sourceDeclarations:true,exactReferenceLines:[3,4]},null,2)+'\n');
});
