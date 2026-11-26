'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {pathToFileURL,fileURLToPath}=require('node:url');
const {StdioLsp,positionOf,until}=require('./helpers/stdio-lsp');
const {populateScala,scala2,scala3}=require('./helpers/scala-fixture');
const {scalaEditorLaunch}=require('../src/java/scala-editor-runtime');
const {indexSemanticdb,renameAt}=require('../src/java/scala-semanticdb');
const {validateRename}=require('../src/java/scala-editor-vscode');
const {jdbcReadback}=require('./java-source-analysis-host');
const {stageCleanup}=require('./helpers/kotlin-native-fixture-cleanup');

const execute=promisify(execFile);
const appRelative='app/src/main/scala/scalafixture/Application.scala';
const coreRelative='core/src/main/scala/scalafixture/Message.scala';

function runtimeSettings() {
  const {ROCKETBRAIN_SBT_LAUNCHER:launcher,ROCKETBRAIN_SBT_CACHE:cache,
    ROCKETBRAIN_SBT_REPOSITORIES:repositories,ROCKETBRAIN_SCALA_METALS_CLASSPATH:classpathFile,
    ROCKETBRAIN_SPRING_JAVA_HOME:javaHome}=process.env;
  assert.ok([launcher,cache,repositories,classpathFile,javaHome].every(value=>path.isAbsolute(value||'')));
  return {launcher,cache,repositories,classpathFile,javaHome};
}

async function runSbt(root,settings,...tasks) {
  const {launcher,cache,repositories,javaHome}=settings;
  const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
  const env={...process.env,JAVA_HOME:javaHome,COURSIER_CACHE:path.join(cache,'coursier')};
  const args=['-XX:ActiveProcessorCount=4','-Dfile.encoding=UTF-8','-Dsbt.supershell=false','-Dsbt.color=false',
    '-Dsbt.log.noformat=true','-Dsbt.server.autostart=false','-Dsbt.boot.directory='+path.join(cache,'boot'),
    '-Dsbt.global.base='+path.join(cache,'global'),'-Dsbt.ivy.home='+path.join(cache,'ivy'),
    '-Dsbt.override.build.repos=true','-Dsbt.repository.config='+repositories,
    '-jar',launcher,...tasks];
  return (await execute(java,args,{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024})).stdout;
}

async function preservingFailure(work,cleanup) {
  let original;
  try {return await work();}
  catch (error) {original=error;throw error;}
  finally {
    try {await cleanup();}
    catch (error) {
      if (original) throw new AggregateError([original,error],original.message+'\nFixture cleanup also failed: '+error.message);
      throw error;
    }
  }
}

async function fixture(parent,version,work,{cleanupManifest,progress=()=>{}}={}) {
  const owning=await fs.realpath(parent);
  const root=await fs.mkdtemp(path.join(owning,'rb-scala-language-'));
  if (cleanupManifest) await stageCleanup(cleanupManifest,owning,root,process.pid,{fixtureKind:'scalaLanguage'});
  progress('scala-fixture-created',{version});
  return preservingFailure(async()=>{
    const settings=runtimeSettings();
    await populateScala(root,version);
    await fs.writeFile(path.join(root,'project/plugins.sbt'),
      'addSbtPlugin("ch.epfl.scala" % "sbt-bloop" % "2.1.3")\n',{flag:'wx'});
    await runSbt(root,settings,'bloopInstall');
    await fs.stat(path.join(root,'.bloop/app.json'));
    progress('scala-bloop-configured',{version});
    return await work(root,settings);
  },async()=>{
    if (cleanupManifest) return;
    const physical=await fs.realpath(root);
    assert.equal(path.relative(path.dirname(physical),owning),'');
    assert.match(path.basename(physical),/^rb-scala-language-/);
    await fs.rm(physical,{recursive:true,force:true,maxRetries:15,retryDelay:300});
  });
}

function editsByFile(edit) {
  return edit.documentChanges ?
    edit.documentChanges.map(({textDocument,edits})=>[textDocument.uri,edits]) :
    Object.entries(edit.changes);
}

function offsetIn(text,position) {
  let offset=0;
  for(let line=0;line<position.line;line++) {
    const found=text.indexOf('\n',offset);
    assert.notEqual(found,-1);
    offset=found+1;
  }
  return offset+position.character;
}

async function applyFixtureRename(root,edit) {
  validateRename(edit,root,'greet');
  const changes=editsByFile(edit);
  assert.deepEqual(changes.map(([uri])=>path.relative(root,fileURLToPath(uri)).replaceAll('\\','/')).sort(),
    [appRelative,coreRelative].sort());
  for(const [uri,edits] of changes) {
    const file=fileURLToPath(uri);
    let text=await fs.readFile(file,'utf8');
    const ranges=edits.map(({range})=>[offsetIn(text,range.start),offsetIn(text,range.end)])
      .sort((first,second)=>second[0]-first[0]);
    for(const [start,end] of ranges) {
      assert.equal(text.slice(start,end),'hello');
      text=text.slice(0,start)+'greet'+text.slice(end);
    }
    await fs.writeFile(file,text);
  }
  assert.match(await fs.readFile(path.join(root,coreRelative),'utf8'),/def hello\(number: Int\)/);
}

async function headless(version) {
  const base=path.resolve(__dirname,'../test-output');
  return fixture(base,version,async(root,settings)=>{
    const launch=await scalaEditorLaunch({root,javaHome:settings.javaHome,classpathFile:settings.classpathFile,sbtCacheDirectory:settings.cache});
    const lsp=new StdioLsp(launch);
    const rootUri=pathToFileURL(root).href;
    try {
      const result=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:root,
        workspaceFolders:[{uri:rootUri,name:'Scala fixture'}],capabilities:{workspace:{workspaceFolders:true,configuration:true},
          textDocument:{rename:{prepareSupport:true}}},
        clientInfo:{name:'Rocketbrain Scala'},initializationOptions:{isHttpEnabled:false,statusBarProvider:'off'}});
      assert.deepEqual(result.serverInfo,{name:'Metals',version:'1.6.9'});
      lsp.notify('initialized',{});
      await until(()=>lsp.notifications.some(item=>item.method==='window/logMessage'&&/indexed workspace/i.test(item.params.message)),100000);
      const file=path.join(root,appRelative),uri=pathToFileURL(file).href,text=await fs.readFile(file,'utf8');
      lsp.notify('textDocument/didOpen',{textDocument:{uri,text,languageId:'scala',version:1}});
      const position=positionOf(text,'Message.hello',10);
      const options={textDocument:{uri},position};
      const completions=await until(async()=>{
        const completion=await lsp.request('textDocument/completion',options,15000);
        const items=Array.isArray(completion)?completion:completion?.items||[];
        const labels=items.map(item=>typeof item.label==='string'?item.label:item.label?.label).filter(item=>item?.startsWith('hello('));
        return labels.length===2?labels:undefined;
      },90000);
      assert.ok(completions.some(item=>item.includes('name: String')));
      assert.ok(completions.some(item=>item.includes('number: Int')));
      const definitions=await lsp.request('textDocument/definition',options);
      assert.ok(definitions.some(item=>!path.relative(fileURLToPath(item.uri),path.join(root,coreRelative))));
      await runSbt(root,settings,'Compile / compile','Test / compile');
      const index=indexSemanticdb(root);
      assert.ok(index.documents.size>=3);
      assert.throws(()=>renameAt(index,{file,text,position,newName:'given'}),/plain Scala method name/);
      assert.throws(()=>renameAt(index,{file,text:text+'\n',position,newName:'greet'}),/changed after compile/);
      const missing=path.join(path.dirname(file),'Uncompiled.scala');
      await fs.writeFile(missing,'package scalafixture\nobject Uncompiled {}\n',{flag:'wx'});
      try {
        assert.throws(()=>renameAt(index,{file,text,position,newName:'greet'}),/all saved Scala sources/);
      } finally {
        await fs.rm(missing);
      }
      const rename=renameAt(index,{file,text,position,newName:'greet'});
      assert.ok(rename);
      await applyFixtureRename(root,rename);
      const output=await runSbt(root,settings,'app / test','app / Compile / runMain scalafixture.Application');
      assert.match(output,/Scala greets Rocketbrain \/ Scala counted 3/);
      return {version,languageServer:result.serverInfo,completions,exactDefinition:true,onlySelectedOverloadRenamed:true,
        incompleteOrDirtyIndexRejected:true,renamedProgramExecuted:true,jdbc:await jdbcReadback()};
    } finally {
      await lsp.request('workspace/executeCommand',{command:'build-disconnect-and-shutdown',arguments:[]},6000).catch(()=>{});
      await lsp.close();
    }
  });
}

async function runScalaLanguageChecks(api,vscode,checks,version=scala2,{cleanupManifest,progress=()=>{}}={}) {
  const workspace=vscode.workspace.workspaceFolders[0];
  const config=vscode.workspace.getConfiguration('rocketbrain.scala');
  const scope=vscode.ConfigurationTarget.Global;
  const settings=runtimeSettings();
  const old=new Map();
  const service=api.java.scalaEditor;
  return preservingFailure(async()=>{
    for(const [key,value] of [['languageClasspath',settings.classpathFile],['cacheDirectory',settings.cache],
      ['sbtLauncher',settings.launcher],['repositoryConfig',settings.repositories]]) {
      old.set(key,config.inspect(key)?.globalValue);
      await config.update(key,value,scope);
    }
    return await fixture(workspace.uri.fsPath,version,async root=>{
      const file=path.join(root,appRelative);
      const folder={uri:vscode.Uri.file(root),name:path.basename(root),index:workspace.index};
      const evidence=await preservingFailure(async()=>{
        assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.scala.startLanguage'));
        await assert.rejects(service.start({folder}),/explicitly start/);
        progress('scala-language-starting',{version});
        assert.equal((await service.start({folder,allowProjectExecution:true})).state,'ready');
        progress('scala-language-ready',{version});
        const document=await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document);
        const where=positionOf(document.getText(),'Message.hello',10);
        const position=new vscode.Position(where.line,where.character);
        progress('scala-completion-waiting',{version});
        let observed=[];
        const labels=await until(async()=>{
          const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,position);
          observed=(completion?.items||[]).map(item=>typeof item.label==='string'?item.label:item.label?.label)
            .filter(label=>label?.startsWith('hello('));
          return observed.length===2 && observed.some(label=>label.includes('name: String')) &&
            observed.some(label=>label.includes('number: Int')) ? observed : undefined;
        },90000).catch(error=>{
          throw new Error('Native Scala completion did not return both typed overloads. Observed '+JSON.stringify(observed.slice(0,5)),{cause:error});
        });
        progress('scala-completion-verified',{version,labels});
        const core=path.join(root,coreRelative);
        const expected=positionOf(await fs.readFile(core,'utf8'),'def hello(name:',4);
        progress('scala-definition-waiting',{version});
        await until(async()=>{
          const targets=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,position);
          return (targets||[]).some(item=>{
            const uri=item.uri||item.targetUri, range=item.targetSelectionRange||item.range;
            return uri?.scheme==='file' && !path.relative(uri.fsPath,core) && range?.start.line===expected.line;
          });
        },90000).catch(error=>{throw new Error('Native Scala definition did not resolve the exact string-overload declaration.',{cause:error});});
        progress('scala-definition-verified',{version,line:expected.line+1});
        progress('scala-rename-index-starting',{version});
        const index=await api.java.scala.prepareRenameIndex({projectUri:folder.uri.toString(),allowProjectExecution:true});
        assert.equal(index.state,'succeeded');
        assert.ok(index.indexedDocuments>=3);
        const edit=await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider',document.uri,position,'greet');
        assert.ok(edit);
        assert.equal(edit.entries().length,2);
        progress('scala-rename-verified',{version,files:edit.entries().length});
        return {version,typedOverloads:labels.length,definition:true,crossFileRename:true,jdbc:await jdbcReadback()};
      },async()=>{
        await service.stop();
        assert.equal(service.getState().state,'stopped');
        progress('scala-language-stopped',{version});
        const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>
          tab.input?.uri?.scheme==='file' && !path.relative(tab.input.uri.fsPath,file));
        if(tabs.length)await vscode.window.tabGroups.close(tabs);
      });
      checks.push('Installed Scala language support completed both sbt module overloads, opened the exact definition and proposed a scoped source rename.');
      return evidence;
    },{cleanupManifest,progress});
  },async()=>{
    for(const [key,value] of old)await config.update(key,value,scope);
  });
}

module.exports={runScalaLanguageChecks};
if(require.main===module)headless(process.argv.includes('--scala3')?scala3:scala2).then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
