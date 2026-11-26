'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const {sourceKey,inventory,reconcileRename,referenceParameters,verifyName} = require('../src/java/kotlin-rename');
const {editedText} = require('../src/java/refactoring');
const {StdioLsp,until,positionOf} = require('./helpers/stdio-lsp');
const {buildSpec} = require('../src/java/workbench-tasks');
const {execute} = require('../src/java/testing/provision');
const {kotlinEditorLaunch,kotlinProtocolUri} = require('../src/java/kotlin-editor-runtime');
const {runJavaFixture,springJdbcClasspath} = require('./helpers/instance-inline-fixture');
const {kotlinOnly,mixed,kotlinPath,javaPath,populate,jdbcSource} = require('./helpers/kotlin-rename-fixture');

test('Kotlin rename reconciles real symbol spans and refuses unrelated edits, resource actions, or invalid names',()=>{
  const file = path.resolve('Invoice.kt'), use = path.resolve('Order.kt'), outside = path.resolve('..','Sibling.kt');
  const uri = value=>pathToFileURL(value).href;
  const range = (start,end)=>({start:{line:0,character:start},end:{line:0,character:end}});
  const files = new Map([[file,'val number = "unchanged"'],[use,'invoice.number']].map(([file,text])=>
    [sourceKey(uri(file)),{file,text,key:sourceKey(uri(file))}]));
  const input = {files,uri:uri(use),position:{line:0,character:9},prepared:{range:range(8,14),placeholder:'number'},
    definitions:[{uri:uri(file),range:range(4,10)}],references:[{uri:uri(use),range:range(8,14)}],newName:'code',
    edit:{changes:{[uri(file)]:[{range:range(4,10),newText:'code'}],[uri(use)]:[{range:range(8,14),newText:'code'}]}}};
  const verified = reconcileRename(input);
  assert.equal(verified.referenceCount,1);
  assert.equal(verified.changed.size,2);
  assert.equal(referenceParameters({textDocument:{uri:uri(use)},position:input.position},input.definitions,files).textDocument.uri,uri(file));
  assert.equal(reconcileRename({...input,prepared:{range:range(4,10),placeholder:'number'}}).referenceCount,1);
  assert.throws(()=>reconcileRename({...input,prepared:{range:range(2,8),placeholder:'number'}}),/preparation does not agree/u);
  assert.throws(()=>reconcileRename({...input,edit:{changes:{[uri(outside)]:[{range:range(4,10),newText:'code'}]}}}),/leaves the reviewed project/u);
  assert.throws(()=>reconcileRename({...input,references:[]}),/does not agree/u);
  assert.throws(()=>reconcileRename({...input,edit:{documentChanges:[{kind:'rename',oldUri:uri(file),newUri:uri(outside)}]}}),/exact text changes/u);
  assert.throws(()=>reconcileRename({...input,edit:{documentChanges:[{
    textDocument:{uri:uri(file),version:4},edits:[{range:range(4,10),newText:'code'}]}]}}),/exact text changes/u);
  assert.throws(()=>reconcileRename({...input,edit:{changes:{[uri(file)]:[{range:range(4,10),newText:'code; injected'}]}}}),/outside the reviewed identifier/u);
  assert.throws(()=>verifyName('when'),/plain Kotlin identifier/u);
  assert.throws(()=>verifyName('foo$bar'),/plain Kotlin identifier/u);
});

const runtime = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const serverHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const gradleUserHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
const jdbcClasspath = process.env.ROCKETBRAIN_KOTLIN_RENAME_JDBC_CLASSPATH;
const runPairs = process.env.ROCKETBRAIN_KOTLIN_RENAME_LIVE_DB === '1';

async function toolchain() {
  const jvm = JSON.parse(await fs.readFile(runtime,'utf8'));
  const cache = path.join(gradleUserHome,'caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.3.20');
  const directories = await fs.readdir(cache);
  const candidates = (await Promise.all(directories.map(dir=>fs.readdir(path.join(cache,dir)).then(names=>
    names.filter(name=>name==='kotlin-stdlib-2.3.20.jar').map(name=>path.join(cache,dir,name)))))).flat();
  assert.equal(candidates.length,1);
  return {...jvm,serverHome,gradleUserHome,stdlib:candidates[0]};
}

async function gradle(root,engine) {
  const spec = buildSpec({tool:'gradle',name:'Kotlin rename',root,uri:pathToFileURL(root).href},engine,['classes']);
  const result = await execute(spec.command,[...spec.args,'--offline'],{cwd:root,env:{...spec.env,GRADLE_USER_HOME:gradleUserHome},timeoutMs:110000});
  assert.equal(result.code,0,result.output.slice(-4500));
  assert.match(result.output,/BUILD SUCCESSFUL/u);
}

async function useProvider(root,storageRoot,tools,operation) {
  const launch = await kotlinEditorLaunch({...tools,root,storageRoot});
  const lsp = new StdioLsp(launch);
  const rootUri = kotlinProtocolUri(root);
  try {
    const result = await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:root,
      workspaceFolders:[{uri:rootUri,name:'kotlin-rename'}],capabilities:{workspace:{configuration:true,workspaceFolders:true,
        workspaceEdit:{documentChanges:true}},textDocument:{rename:{prepareSupport:true}}}},90000);
    assert.equal(result.capabilities.renameProvider.prepareProvider,true);
    assert.equal(result.capabilities.referencesProvider,true);
    lsp.notify('initialized',{});
    const files = inventory(root);
    for (const file of files.values()) {
      if (file.file.endsWith('.kt')) lsp.notify('textDocument/didOpen',
        {textDocument:{uri:kotlinProtocolUri(file.file),languageId:'kotlin',version:1,text:file.text}});
    }
    const get = async(selection,newName)=>{
      const [relative,needle,shift] = selection, file = path.join(root,relative);
      const uri = kotlinProtocolUri(file), position = positionOf(files.get(sourceKey(uri)).text,needle,shift);
      const params = {textDocument:{uri},position};
      const prepared = await until(()=>lsp.request('textDocument/prepareRename',params,25000),70000);
      const definitions = await lsp.request('textDocument/definition',params,25000);
      const references = await lsp.request('textDocument/references',referenceParameters(params,definitions,files),25000);
      const edit = await lsp.request('textDocument/rename',{...params,newName},25000);
      return {files,uri,position,prepared,definitions,references,edit,newName};
    };
    return await operation(get);
  } finally {
    try {await lsp.close();} finally {await launch.dispose();}
  }
}

async function savePlan(plan) {
  for (const {file,edits} of plan.changed.values()) await fs.writeFile(file.file,editedText(file.text,edits));
}

test('pinned Kotlin LSP rename edits compile, retain scope and run through actual Spring JDBC on both databases',{
  skip:!(runtime&&serverHome&&gradleUserHome) && 'Use the pinned Kotlin engine and Gradle project.',
  timeout:520000
},async t=>{
  const tmp = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(tmp,'rb-krename-'));
  t.after(async()=>{
    const real = await fs.realpath(owned);
    assert.equal(real,owned); assert.equal(path.dirname(real),tmp);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const tools = await toolchain(), projects = [];
  for (const [index,specification] of [kotlinOnly,mixed].entries()) {
    const mixedProject = index===1, root = path.join(owned,mixedProject?'mixed':'kotlin');
    await populate(root,{mixedProject});
    const other = path.join(owned,'neighbor-'+index);
    await populate(other);
    const sibling = path.join(other,kotlinPath('Invoice.kt'));
    const siblingBefore = await fs.readFile(sibling,'utf8');
    await gradle(root,tools);
    const baseline = path.join(owned,'before-'+index);
    await fs.cp(path.join(root,'build/classes'),baseline,{recursive:true});
    const plan = await useProvider(root,path.join(owned,'lsp-'+index),tools,async get=>{
      const result = reconcileRename(await get(specification.begins,specification.newName));
      if (mixedProject) {
        await assert.rejects(async()=>reconcileRename(await get(kotlinOnly.begins,kotlinOnly.newName)),/Mixed Kotlin\/Java projects/u);
      } else {
        await assert.rejects(async()=>reconcileRename(await get(kotlinOnly.begins,'cents')),/already appears/u);
      }
      return result;
    });
    assert.equal(plan.referenceCount,1);
    assert.equal(plan.changed.size,mixedProject?1:2);
    assert.equal(plan.scope,mixedProject?'private-function':'kotlin-project');
    await savePlan(plan);
    assert.equal(await fs.readFile(sibling,'utf8'),siblingBefore);
    await gradle(root,tools);
    const source = await fs.readFile(path.join(root, specification.begins[0]),'utf8');
    assert.match(source,new RegExp(specification.newName,'u'));
    if (!mixedProject) assert.match(source,/val number = invoice\.invoiceNumber/u);
    else assert.match(await fs.readFile(path.join(root,javaPath('MixedCaller.java')),'utf8'),/RenameSupportKt\.publicLabel/u);
    projects.push({mixedProject,before:baseline,after:path.join(root,'build/classes'),files:plan.changed.size,
      referenceCount:plan.referenceCount,scope:plan.scope,expected:specification.output});
  }
  const results = [];
  if (runPairs) {
    assert.ok(jdbcClasspath);
    for (const [engine,start] of Object.entries({mysql:require('../scripts/integration-mysql').startMysqlFixture,
      mariadb:require('../scripts/integration-db').startFixture})) {
      const fixture = await start();
      try {
        const runtimeJars = await springJdbcClasspath(jdbcClasspath,engine), observed = [];
        for (const project of projects) {
          const java = path.join(owned,'KotlinRenameProbe.java');
          await fs.writeFile(java,jdbcSource(project.mixedProject));
          const outcomes = [];
          for (const classes of [project.before,project.after]) {
            const binaryDirectory = await fs.mkdtemp(path.join(owned,'jdbc-run-'));
            const classpath = [...runtimeJars,tools.stdlib,path.join(classes,'kotlin/main'),
              ...(project.mixedProject?[path.join(classes,'java/main')]:[])];
            outcomes.push(await runJavaFixture({javaHome:tools.javaHome,file:java,binaryDirectory,className:'fixture.KotlinRenameProbe',
              engine,config:fixture.config,classpath,jdbcPrefix:'RB_KRENAME'}));
          }
          assert.deepEqual(outcomes[0],outcomes[1]);
          assert.equal(outcomes[1].output,project.expected);
          observed.push({scope:project.scope,files:project.files,referenceCount:project.referenceCount,...outcomes[1]});
        }
        results.push({engine,observed});
      } finally {await fixture.close();}
    }
  }
  if (process.env.ROCKETBRAIN_KOTLIN_RENAME_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_KOTLIN_RENAME_RECEIPT,
    JSON.stringify({ktlsp:'1.4.0-rc1',compiler:'2.2.21',gradleKotlin:'2.3.20',springJdbc:'7.0.10',results,
      adjacentProjectUnchanged:true,compiledBeforeAndAfter:true,publicMixedRefused:true,collisionRefused:true},null,2)+'\n');
});
