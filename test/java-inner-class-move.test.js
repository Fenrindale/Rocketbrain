'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {fileURLToPath,pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const {test} = require('node:test');
const {StdioLsp,until,positionOf} = require('./helpers/stdio-lsp');
const {resolveLaunch,serverSettings} = require('../src/java/runtime');
const {analyzeJavaSources} = require('../src/java/signature-compiler');
const {registerJavaRefactoring,editedText} = require('../src/java/refactoring');
const {createInnerClassMove} = require('../src/java/inner-class-move-vscode');
const {innerMoveFixture,innerMoveRuntime} = require('./helpers/java-inner-class-move-fixture');
const {springTypeRenameClasspath} = require('./helpers/java-type-rename-fixture');

test('qualified move overlays one exact constructor owner reference and preserves arguments', () => {
  const {preserveQualifiedNullCheck} = require('../src/java/inner-class-move');
  const file = pathToFileURL(path.resolve('Caller.java')).href;
  const original = 'class Caller { Object read() { return owner().new Report(++calls); } }\r\n';
  const proposed = original.replace('owner().new Report(++calls)','new Report(owner(), ++calls)');
  const span = proposed.indexOf('owner()');
  const plan = preserveQualifiedNullCheck({
    updated:[{uri:file,text:proposed}],
    edit:{documentChanges:[{textDocument:{uri:file,version:9},edits:[]}]}
  },new Map([[file,{text:original}]]),new Map([[file,[{start:span,end:span+7,text:'owner()'}]]]));
  const [change] = plan.edit.documentChanges;
  assert.equal(change.textDocument.version,9);
  assert.equal(editedText(original,change.edits),plan.updated[0].text);
  assert.match(plan.updated[0].text,/requireNonNull\(owner\(\)\), \+\+calls\)/);
});

const stateFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_INNER_MOVE_CLASSPATH;
const dbFiles = ['mysql','mariadb'].map(engine => [engine,process.env['ROCKETBRAIN_INNER_MOVE_'+engine.toUpperCase()+'_CONFIG']]);
const uri = fsPath => ({scheme:'file',fsPath,toString:() => pathToFileURL(fsPath).href});
const absent = async file => assert.rejects(fs.stat(file),{code:'ENOENT'});

test('owned JDT/Javac inner-class Move keeps Spring instances, early-null evaluation and both JDBC engines', {
  skip:!stateFile || !classpathFile || !dbFiles.every(([,file]) => file),timeout:180000
},async t => {
  const config = JSON.parse(await fs.readFile(stateFile,'utf8'));
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent,'rb-javac-inner-move-'));
  const lsp = new StdioLsp(resolveLaunch({...config,storagePath:path.join(owned,'jdt')}));
  t.after(async () => {
    await lsp.close();
    assert.equal(path.dirname(await fs.realpath(owned)),parent);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const root = path.join(owned,'project'), src = path.join(root,'src'), dir = path.join(src,'demo');
  const rootUri = uri(root).toString();
  const fixture = innerMoveFixture('demo','River');
  const [owner,caller,destination] = [fixture.owner,fixture.caller,fixture.inner].map(name => path.join(dir,name+'.java'));
  await fs.mkdir(dir,{recursive:true});
  await fs.mkdir(path.join(root,'bin'));
  await fs.writeFile(owner,fixture.ownerText);
  await fs.writeFile(caller,fixture.callerText);
  await fs.writeFile(path.join(root,'.project'),'<projectDescription><name>rb-inner-move</name><buildSpec>'+
    '<buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>'+
    '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
  const classpath = await springTypeRenameClasspath(classpathFile,'mysql');
  await fs.writeFile(path.join(root,'.classpath'),'<classpath><classpathentry kind="src" path="src"/>'+
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>'+
    classpath.map(file => '<classpathentry kind="lib" path="'+file.replaceAll('\\','/').replaceAll('&','&amp;')+'"/>').join('')+
    '<classpathentry kind="output" path="bin"/></classpath>');
  const settings = serverSettings([{name:'JavaSE-25',path:config.javaHome,default:true}]);
  settings.java.autobuild.enabled = false;
  await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'inner-move'}],
    capabilities:{workspace:{configuration:true,workspaceFolders:true,applyEdit:false,workspaceEdit:{documentChanges:true,resourceOperations:['create','rename','delete']}},
      textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},
    initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings}},90000);
  lsp.notify('initialized',{});
  lsp.notify('workspace/didChangeConfiguration',{settings});

  const docs = new Map();
  const applied = [];
  const vscode = {
    Uri:{file:uri,parse:value => uri(fileURLToPath(value))},
    Range:class{constructor(sl,sc,el,ec){this.start={line:sl,character:sc};this.end={line:el,character:ec};}},
    TextEdit:class{constructor(range,newText){this.range=range;this.newText=newText;}},
    WorkspaceEdit:class{
      constructor(){this.text=[];this.create=[];}
      set(uri,edits){this.text.push({file:uri.fsPath,edits});}
      createFile(uri,options){this.create.push({file:uri.fsPath,options});}
    },
    workspace:{
      isTrusted:true,
      get textDocuments(){return [...docs.values()];},
      getWorkspaceFolder:() => ({uri:uri(root)}),
      openTextDocument:async value => {
        if (!docs.has(value.fsPath)) {
          const text = await fs.readFile(value.fsPath,'utf8');
          docs.set(value.fsPath,{uri:value,languageId:'java',version:1,isDirty:false,isClosed:false,getText:() => text});
          lsp.notify('textDocument/didOpen',{textDocument:{uri:value.toString(),languageId:'java',version:1,text}});
        }
        return docs.get(value.fsPath);
      },
      applyEdit:async edit => {
        applied.push(edit);
        for (const operation of edit.create) {
          assert.equal(operation.options.overwrite,false);
          assert.equal(operation.options.ignoreIfExists,false);
          await fs.writeFile(operation.file,operation.options.contents,{flag:'wx'});
        }
        for (const change of edit.text) {
          const text = await fs.readFile(change.file,'utf8');
          await fs.writeFile(change.file,editedText(text,change.edits));
        }
        return true;
      },
      registerTextDocumentContentProvider:() => ({dispose(){}})
    },
    commands:{registerCommand:() => ({dispose(){}})}
  };
  const refactoring = registerJavaRefactoring({},vscode);
  t.after(() => refactoring.dispose());
  const document = await vscode.workspace.openTextDocument(uri(owner));
  await vscode.workspace.openTextDocument(uri(caller));
  const state = {state:'running',javaHome:config.javaHome,runtimeIdentity:'owned-jdt'};
  const project = {root,uri:rootUri,sourceRoots:[{path:src}]};
  const command = (command,args) => lsp.request('workspace/executeCommand',{command,arguments:args},30000);
  await until(async () => {
    const cp = await command('java.project.getClasspaths',[document.uri.toString(),{scope:'runtime'}]);
    return cp?.projectRoot && cp.classpaths.some(file => file.includes('spring-context'));
  },90000);
  let alterJdt = false;
  const api = {
    getState:() => state,refactoring,requestWorkspaceCommand:command,
    async innerClassMoveEdit(options) {
      const result = await lsp.request('java/move',options,40000);
      if (alterJdt) {
        assert.ok(Array.isArray(result.edit?.documentChanges),JSON.stringify(result).slice(0,4500));
        const edit = result.edit.documentChanges.find(change => change.textDocument?.uri.endsWith('/'+fixture.caller+'.java'));
        const at = positionOf(fixture.callerText,'trace = trace * 10 + 2');
        edit.edits.push({range:{start:at,end:{...at,character:at.character+22}},newText:'trace = trace * 10 + 3'});
      }
      return result;
    }
  };
  const snapshot = async value => {
    const data = await fs.readFile(value.fsPath);
    return {uri:value.toString(),text:data.toString('utf8'),sha:createHash('sha256').update(data).digest('hex'),bytes:data.length};
  };
  const actualClasspath = async () => (await command('java.project.getClasspaths',[rootUri,{scope:'runtime'}])).classpaths;
  const service = createInnerClassMove(vscode,{
    java:api,assertReady:() => {},projects:async () => state,findProject:() => project,
    classSources:async () => Promise.all([owner,caller].map(file => snapshot(uri(file)))),classpaths:actualClasspath,snapshot,
    assertUnchangedSourceSnapshots:() => {},
    async compile(_state,_project,sources,inspection,_token,{newSources=[]}={}) {
      const classpath = await actualClasspath();
      const report = await analyzeJavaSources({javaHome:config.javaHome,classpath,
        sources:[...sources,...newSources],inspection,storagePath:path.join(owned,'inspection')});
      assert.deepEqual(report.errors,[]);
      return {...report,classpathEntries:classpath};
    }
  });
  const prepare = name => {
    const position = positionOf(fixture.ownerText,'class '+name);
    return service.prepare({document,position:{...position,character:position.character+6}});
  };

  const run = files => Promise.all(dbFiles.map(([engine,configFile]) => innerMoveRuntime({
    javaHome:config.javaHome,classpathFile,engine,configFile,files,fixture,workspace:owned
  })));
  const before = await run([owner,caller]);
  await assert.rejects(prepare('RiverStatic'),/regular non-static/);
  const metadata = path.join(root,'beans.xml');
  await fs.writeFile(metadata,'<bean class="demo.RiverOwner$RiverReport"/>');
  await assert.rejects(prepare(fixture.inner),/registration refers to this type/);
  await fs.unlink(metadata);
  alterJdt = true;
  await assert.rejects(prepare(fixture.inner),/changes unrelated Java source/);
  alterJdt = false;

  const plan = await prepare(fixture.inner);
  assert.equal(plan.qualifiedCallers,1);
  assert.equal(plan.constructorCallers,2);
  await absent(destination);
  await fs.writeFile(metadata,'<beans/>');
  await assert.rejects(refactoring.apply(plan.id),/dependency, test or resource changed/);
  await fs.unlink(metadata);
  assert.equal(applied.length,0);
  assert.equal((await refactoring.apply(plan.id)).state,'applied');
  assert.equal(applied.length,1);
  assert.equal(applied[0].text.length,2);
  assert.equal(applied[0].create.length,1);
  const after = await run([owner,caller,destination]);
  assert.deepEqual(before,after);
  await assert.rejects(refactoring.apply(plan.id),/expired/);
  const receipt = {springRuntime:after,qualifiedCallers:plan.qualifiedCallers,constructorCallers:plan.constructorCallers,
    previews:plan.documents.length,jdtUnrelatedEditRefused:true,staticMemberRefused:true,metadataRefused:true,
    staleResourceRefused:true,oneWorkspaceEdit:true,launchesNativeCode:false};
  if (process.env.ROCKETBRAIN_INNER_MOVE_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_INNER_MOVE_RECEIPT,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  }
});
