'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { test } = require('node:test');
const { registerKotlinRename } = require('../src/java/kotlin-rename-vscode');
const { inventory } = require('../src/java/kotlin-rename');
const { classCandidate, kotlinTypeReferences } = require('../src/java/kotlin-mixed-type-rename');
const { registerJavaRefactoring, editedText } = require('../src/java/refactoring');
const { kotlinEditorLaunch } = require('../src/java/kotlin-editor-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { execute } = require('../src/java/testing/provision');
const { StdioLsp, until, positionOf } = require('./helpers/stdio-lsp');
const { input, ownerFile, kotlinCaller, javaCaller, sameName, resource, newName, populate, rebuild, runJdbc } =
  require('./helpers/mixed-type-rename-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const serverHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const gradleHome = process.env.ROCKETBRAIN_MIXED_RENAME_GRADLE_HOME;
const gradleUserHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
const engines = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_MIXED_RENAME_' + engine.toUpperCase() + '_CONFIG']]);
const uri = file => ({ scheme:'file', fsPath:file, toString:()=>pathToFileURL(file).href });
const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('a proposed Kotlin class reference needs one type or primary constructor definition', async () => {
  const files=inventory(input), file=path.join(input,ownerFile), typeUri=uri(file).toString();
  const position=positionOf(await fs.readFile(file,'utf8'),'class Invoice',7);
  const selection=classCandidate(files,typeUri,position,input);
  const definitions=[{uri:typeUri,range:selection.range},{uri:typeUri,range:selection.constructor}];
  await assert.rejects(kotlinTypeReferences({root:input,sources:files,selection,references:[],request:async()=>definitions}),
    /could not be attributed to one declaration/u);
});

test('Kotlin LSP and Javac jointly review a compiled public class rename on real mixed Gradle and Spring JDBC', {
  skip: !runtimeFile || !serverHome || !gradleHome || !gradleUserHome || !engines.every(([, file])=>file), timeout: 300000
}, async t => {
  const base = await fs.realpath(os.tmpdir()), scope = await fs.mkdtemp(path.join(base, 'rb-mixed-rename-proof-'));
  const root = path.join(scope, 'project'), runtime = await load(runtimeFile);
  const tools = {javaHome:runtime.javaHome,gradleHome,gradleUserHome};
  let java, kotlin, launch, review, service;
  t.after(async () => {
    await service?.dispose();
    await review?.dispose();
    await Promise.allSettled([java?.close(),kotlin?.close()]);
    await launch?.dispose();
    assert.equal(await fs.realpath(scope), scope);
    assert.equal(path.dirname(scope), base);
    await fs.rm(scope, {recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await populate(root, tools);
  const projectUri = uri(root).toString();
  const original = Object.fromEntries(await Promise.all([ownerFile,kotlinCaller,javaCaller,sameName,resource].map(async file=>
    [file,await fs.readFile(path.join(root,file),'utf8')])));
  const database = await Promise.all(engines.map(async ([engine,file])=>[engine,await load(file)]));
  const before = await Promise.all(database.map(([engine,config])=>runJdbc(root,tools,config,engine)));

  java = new StdioLsp(resolveLaunch({javaHome:tools.javaHome,serverPath:runtime.serverPath,storagePath:path.join(scope,'jdt')}));
  const settings=serverSettings([{name:'JavaSE-25',path:tools.javaHome,default:true}]);
  settings.java.autobuild.enabled=false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled=false;
  await java.request('initialize',{processId:process.pid,rootUri:projectUri,workspaceFolders:[{uri:projectUri,name:'mixed rename'}],
    capabilities:{workspace:{configuration:true,workspaceFolders:true}},
    initializationOptions:{bundles:[],workspaceFolders:[projectUri],settings}},90000);
  java.notify('initialized',{});
  const classpath=()=>java.request('workspace/executeCommand',{command:'java.project.getClasspaths',
    arguments:[projectUri,{scope:'runtime'}]},20000);
  const model=await until(async()=>{
    const cp=await classpath();
    return cp?.projectRoot && cp.classpaths.some(file=>file.endsWith('spring-jdbc-7.0.10.jar')) ? cp : undefined;
  },70000);
  assert.ok(model.projectRoot);

  launch = await kotlinEditorLaunch({ ...tools, serverHome, root, storageRoot:path.join(scope,'ktlsp') });
  kotlin = new StdioLsp(launch);
  const initialization = await kotlin.request('initialize',{processId:process.pid,rootUri:projectUri,rootPath:root,
    workspaceFolders:[{uri:projectUri,name:'mixed rename'}],capabilities:{workspace:{configuration:true,workspaceFolders:true,
      workspaceEdit:{documentChanges:true}},textDocument:{rename:{prepareSupport:true}}}},90000);
  assert.equal(initialization.capabilities.renameProvider.prepareProvider,true);
  kotlin.notify('initialized',{});
  const docs = new Map();
  const vscode = {
    Uri:{file:uri,parse:value=>uri(fileURLToPath(value))},
    Range:class {constructor(sl,sc,el,ec){this.start={line:sl,character:sc};this.end={line:el,character:ec};}},
    TextEdit:class {constructor(range,newText){Object.assign(this,{range,newText});}},
    WorkspaceEdit:class {entries=[];set(value,edits){this.entries.push([value,edits]);}},
    workspace:{isTrusted:true,get textDocuments(){return [...docs.values()];},getWorkspaceFolder:()=>({uri:uri(root)}),
      async openTextDocument(value){
        if (!docs.has(value.fsPath)){
          const doc={uri:value,version:1,languageId:value.fsPath.endsWith('.kt')?'kotlin':'java',
            isDirty:false,isClosed:false,text:await fs.readFile(value.fsPath,'utf8'),getText:()=>doc.text,
            validatePosition:position=>position};
          docs.set(value.fsPath,doc);
          if(doc.languageId==='kotlin') kotlin.notify('textDocument/didOpen',
            {textDocument:{uri:value.toString(),languageId:'kotlin',version:1,text:doc.text}});
        }
        return docs.get(value.fsPath);
      },
      async applyEdit(edit){
        for(const [value,changes] of edit.entries){
          const doc=docs.get(value.fsPath);
          doc.text=editedText(doc.text,changes);
          doc.version++;
          doc.isDirty=true;
        }
        return true;
      },
      registerTextDocumentContentProvider:()=>({dispose(){}})},
    commands:{registerCommand:()=>({dispose(){}})}
  };
  review=registerJavaRefactoring({},vscode);
  let competingArtifact;
  service=registerKotlinRename(vscode,{
    begin:async()=>({root,compiler:launch.compiler,check(){},request:(method,params)=>kotlin.request(method,params,30000),
      classpath:async()=>{
        const cp=await classpath();
        return competingArtifact?{...cp,classpaths:[...cp.classpaths,competingArtifact]}:cp;
      }}),
    refactoring:review,output:{appendLine(){}}
  });
  const document=await vscode.workspace.openTextDocument(uri(path.join(root,ownerFile)));
  await vscode.workspace.openTextDocument(uri(path.join(root,kotlinCaller)));
  const position=positionOf(document.getText(),'class Invoice',7);
  await until(()=>kotlin.request('textDocument/prepareRename',{textDocument:{uri:document.uri.toString()},position},20000),70000);
  await assert.rejects(service.prepare({document,position,newName:'InvoiceExtra'}), /name already appears|destination name/u);

  const prepare=()=>service.prepare({document,position,newName});
  const jar=path.join(tools.javaHome,'bin',process.platform==='win32'?'jar.exe':'jar');
  competingArtifact=path.join(scope,'competing-type.jar');
  const packed=await execute(jar,['--create','--file',competingArtifact,'-C',path.join(root,'build/classes/kotlin/main'),
    'mixed/rename/domain/Invoice.class'],{cwd:root,timeoutMs:12000});
  assert.equal(packed.code,0,packed.output);
  await assert.rejects(prepare(), /dependency already supplies/u);
  competingArtifact=undefined;
  const stale=await prepare();
  await fs.appendFile(path.join(root,resource), '\nreport.modified=true\n');
  await assert.rejects(review.apply(stale.id), /source or membership changed/u);
  await fs.writeFile(path.join(root,resource), original[resource] + 'bean.ref=mixed.rename.domain.Invoice\n');
  await assert.rejects(prepare(), /test, build or resource declaration/u);
  await fs.writeFile(path.join(root,resource), original[resource]);

  const plan=await prepare();
  assert.equal(plan.rename.scope,'mixed-public-class');
  assert.equal(plan.rename.referenceCount,3);
  assert.equal(plan.rename.javaReferences,3);
  assert.equal(plan.rename.kotlinAndJavacVerified,true);
  assert.equal(plan.documents.length,3);
  assert.deepEqual(plan.resourceOperations,[]);
  const affected=plan.documents.find(file=>file.uri.endsWith('/JdbcConsumer.java'));
  assert.match(affected.after,/import mixed\.rename\.domain\.ReviewedInvoice;/u);
  assert.match(affected.after,/ReviewedInvoice invoice = makeInvoice/u);
  assert.match(affected.after,/new mixed\.rename\.domain\.ReviewedInvoice/u);
  assert.match(affected.after,/new InvoiceExtra/u);
  assert.match(affected.after,/mixed\.rename\.shadow\.Invoice\.label/u);
  assert.equal((await review.apply(plan.id)).state,'applied');
  for(const doc of docs.values()) if(doc.isDirty)await fs.writeFile(doc.uri.fsPath,doc.getText());
  assert.equal(await fs.readFile(path.join(root,sameName),'utf8'),original[sameName]);
  assert.equal(await fs.readFile(path.join(root,resource),'utf8'),original[resource]);
  await rebuild(root,tools);
  const after=await Promise.all(database.map(([engine,config])=>runJdbc(root,tools,config,engine)));
  assert.deepEqual(before,after);
  await assert.rejects(fs.stat(path.join(root,'build/classes/kotlin/main/mixed/rename/domain/Invoice.class')),{code:'ENOENT'});
  await fs.stat(path.join(root,'build/classes/kotlin/main/mixed/rename/domain/ReviewedInvoice.class'));

  if(process.env.ROCKETBRAIN_MIXED_RENAME_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_MIXED_RENAME_RECEIPT,
    JSON.stringify({scope:plan.rename.scope,javaReferences:plan.rename.javaReferences,kotlinReferences:plan.rename.referenceCount,
      editedFiles:plan.documents.length,verifiedJdtClasspath:true,kotlinServer:launch.serverVersion,compiler:launch.compilerVersion,
      caseOrNameCollisionRefused:true,competingDependencyRefused:true,staleResourceRefused:true,configuredClassRefused:true,shadowAndPrefixUntouched:true,
      gradleRebuilt:true,previousBinaryGone:true,results:after},null,2)+'\n');
});
