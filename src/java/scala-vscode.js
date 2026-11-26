'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');
const { projectSbt,createSbtRunner,observedProjects,mainClasses } = require('./scala-sbt');
const { indexSemanticdb,definitionAt,referencesAt,renameAt,configSnapshot } = require('./scala-semanticdb');

const COMMANDS={discover:'rocketbrain.scala.discover',compile:'rocketbrain.scala.compile',test:'rocketbrain.scala.test',
  run:'rocketbrain.scala.run',debug:'rocketbrain.scala.debug',definition:'rocketbrain.scala.definition',
  renameIndex:'rocketbrain.scala.renameIndex',stop:'rocketbrain.scala.stop'};
const debugType='rocketbrain-scala';

function registerScalaWorkbench(context,vscode,java) {
  const output=vscode.window.createOutputChannel('Rocketbrain Scala / sbt');
  const runner=createSbtRunner({log:text => output.append(text)});
  const projects=new Map(), indexes=new Map(), subscriptions=[output], operations=new Set();
  let disposed=false, closing, epoch=0, debugSession;

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before using Scala/sbt.');
    if (cancelled(cancellation)) throw fail('The Scala operation was cancelled.');
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders||[]);}
  async function rootFor(uri,cancellation) {
    trusted(cancellation);
    const root=workspacePath(uri,roots());
    await projectSbt(root);
    trusted(cancellation);
    return root;
  }

  function ensureSaved(root) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme==='file' &&
        inside(root,document.uri.fsPath) && /\.(?:scala|sbt|java|properties)$/.test(document.uri.fsPath))) {
      throw fail('Save modified Scala/sbt project files before executing the build.');
    }
  }

  function remember(map,key,value) {
    map.delete(key);
    if (map.size>=6) map.delete(map.keys().next().value);
    map.set(key,value);
  }

  function executionOptions(root,options) {
    trusted(options.cancellation);
    if (options.allowProjectExecution!==true) throw fail('Explicitly choose the sbt task before executing project code.');
    ensureSaved(root);
    const scala=vscode.workspace.getConfiguration('rocketbrain.scala');
    const javaSettings=vscode.workspace.getConfiguration('rocketbrain.java');
    return {root,projectId:options.projectId,javaHome:javaSettings.get('javaHome')||java.getState().javaHome,
      launcher:scala.get('sbtLauncher'),cache:scala.get('cacheDirectory')||path.join(context.globalStorageUri.fsPath,'scala-sbt'),
      repositoryConfig:scala.get('repositoryConfig'),cancellation:options.cancellation,
      workspaceTrusted:vscode.workspace.isTrusted,allowProjectExecution:options.allowProjectExecution};
  }

  async function task(root,name,options,details={}) {
    const owned=executionOptions(root,options);
    const config=() => JSON.stringify(configSnapshot(root));
    const reviewed=config(), version=epoch;
    const result=await runner.run({...owned,action:name,main:details.main});
    if (result.state==='succeeded' && (disposed || epoch!==version || reviewed!==config())) {
      throw fail('Scala build settings changed while the task was running. Discover or compile again.');
    }
    return {...result,root,configs:reviewed};
  }

  async function discover(options={}) {
    const root=await rootFor(options.projectUri,options.cancellation), result=await task(root,'discover',options);
    if (result.state!=='succeeded') return {...result,projects:[]};
    const found=observedProjects(result.output);
    if (!found.length) throw fail('sbt did not report supported project IDs. Check its Output channel.');
    remember(projects,root,{known:found,configs:result.configs});
    return {...result,projects:found};
  }

  async function selected(options,name) {
    if (options.allowProjectExecution!==true) throw fail('Explicitly choose the sbt task before executing project code.');
    const root=await rootFor(options.projectUri,options.cancellation);
    const observed=projects.get(root);
    if (options.projectId && (!observed?.known.some(item => item.id===options.projectId) ||
        observed.configs!==JSON.stringify(configSnapshot(root)))) {
      throw fail('Discover current sbt project IDs before choosing a subproject.');
    }
    const createsIndex=name==='compile' || name==='renameIndex';
    if (createsIndex) indexes.delete(root);
    const result=await task(root,name,options);
    if (result.state==='succeeded' && createsIndex) {
      trusted(options.cancellation);
      ensureSaved(root);
      const index=indexSemanticdb(root,options.cancellation);
      if (JSON.stringify(index.configs)!==result.configs) throw fail('Scala build files changed during SemanticDB indexing.');
      remember(indexes,root,{...index,renameReady:name==='renameIndex'});
      return {...result,indexedDocuments:index.documents.size};
    }
    if (name==='mains') return {...result,classes:result.state==='succeeded' ? mainClasses(result.output) : []};
    return result;
  }

  async function admittedMain(options) {
    const observed=await selected(options,'mains');
    if (!observed.classes.includes(options.mainClass)) throw fail('Choose a main class reported by this sbt project.');
    if (observed.configs!==JSON.stringify(configSnapshot(observed.root))) throw fail('Discover main classes again after editing sbt settings.');
    return observed;
  }

  async function runMain(options={}) {
    const observed=await admittedMain(options);
    return task(observed.root,'run',options,{main:options.mainClass});
  }

  async function stopDebug() {
    const selected=debugSession;
    debugSession=undefined;
    try { if (selected?.session) await vscode.debug.stopDebugging(selected.session); }
    finally { await runner.stop(); }
    return {state:'stopped'};
  }

  async function debugMain(options={}) {
    if (debugSession) throw fail('Stop the current Scala debugger before starting another.');
    const observed=await admittedMain(options);
    if (debugSession) throw fail('Stop the current Scala debugger before starting another.');
    const owned=executionOptions(observed.root,options);
    const selected={token:randomUUID(),version:epoch,root:observed.root,configs:observed.configs};
    debugSession=selected;
    try {
      selected.target=await runner.debug({...owned,main:options.mainClass});
      trusted(options.cancellation);
      if (debugSession!==selected || selected.version!==epoch ||
          selected.configs!==JSON.stringify(configSnapshot(observed.root))) {
        throw fail('Scala build settings changed before the debugger connected.');
      }
      const folder=vscode.workspace.getWorkspaceFolder(vscode.Uri.file(observed.root));
      const started=await vscode.debug.startDebugging(folder,{type:debugType,request:'launch',
        name:'Scala: '+options.mainClass,rocketbrainOwnedSession:selected.token},{suppressSaveBeforeStart:true});
      if (!started || !selected.session) throw fail('VS Code did not start the owned Scala debugger.');
      return {sessionId:selected.session.id,mainClass:options.mainClass,verifiedLoopback:true};
    } catch (error) {
      if (debugSession===selected) await stopDebug();
      throw error;
    }
  }

  subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(debugType,{
    async createDebugAdapterDescriptor(session) {
      trusted();
      const selected=debugSession;
      if (session.configuration.request!=='launch' || !selected?.target || selected.session ||
          selected.token!==session.configuration.rocketbrainOwnedSession) {
        throw fail('Start the debugger with Debug sbt Main Class.');
      }
      selected.session=session;
      const target=await runner.verifyDebug(selected.target);
      trusted();
      if (debugSession!==selected || selected.version!==epoch ||
          selected.configs!==JSON.stringify(configSnapshot(selected.root))) {
        throw fail('The Scala debugging session changed before attaching.');
      }
      return new vscode.DebugAdapterServer(target.port,target.address);
    }
  }),vscode.debug.onDidTerminateDebugSession(session=>{
    if (debugSession?.session?.id===session.id) {
      debugSession=undefined;
      void runner.stop().catch(error=>output.appendLine(error.message));
    }
  }));

  function indexedSource(document,cancellation) {
    trusted(cancellation);
    if (!document || document.uri.scheme!=='file' || document.uri.authority || !document.uri.fsPath.endsWith('.scala')) return undefined;
    const file=workspacePath(document.uri.fsPath,roots(),{directory:false});
    const index=[...indexes.values()].sort((a,b) => b.root.length-a.root.length).find(index => inside(index.root,file));
    return {file,index};
  }

  function codeLocation(result) {
    if (!result) return undefined;
    const uri=vscode.Uri.parse(result.uri);
    if (uri.scheme!=='file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    workspacePath(uri.fsPath,roots(),{directory:false});
    const {start,end}=result.range;
    return {symbol:result.symbol,uri,range:new vscode.Range(start.line,start.character,end.line,end.character)};
  }

  function definition({document,position}={},cancellation) {
    const source=indexedSource(document,cancellation);
    return source && codeLocation(definitionAt(source.index,{file:source.file,text:document.getText(),position}));
  }

  function references({document,position,includeDeclaration}={},cancellation) {
    const source=indexedSource(document,cancellation);
    if (!source) return [];
    return referencesAt(source.index,{file:source.file,text:document.getText(),position,includeDeclaration},cancellation)
      .map(codeLocation).filter(Boolean);
  }

  function prepareRenameIndex(options={}) {
    return selected({...options,projectId:undefined},'renameIndex');
  }

  function planRename({document,position,newName,root}={},cancellation) {
    const source=indexedSource(document,cancellation);
    if (!source) return undefined;
    if (!source.index?.renameReady || !root || path.relative(root,source.index.root)) {
      throw fail('Run Index Scala Sources for Rename for the selected build first.');
    }
    ensureSaved(source.index.root);
    return renameAt(source.index,{file:source.file,text:document.getText(),position,newName},cancellation);
  }

  const selector={scheme:'file',language:'scala',pattern:'**/*.scala'};
  subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition(document,position,cancellation) {
      try {
        const found=definition({document,position},cancellation);
        return found ? new vscode.Location(found.uri,found.range) : undefined;
      } catch {return undefined;}
    }
  }));
  subscriptions.push(vscode.languages.registerReferenceProvider(selector,{
    provideReferences(document,position,context,cancellation) {
      try {
        return references({document,position,includeDeclaration:context.includeDeclaration},cancellation)
          .map(item=>new vscode.Location(item.uri,item.range));
      } catch {return [];}
    }
  }));

  if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    epoch++;
    indexes.clear();projects.clear();
    void stopDebug().catch(error => output.appendLine(error.message));
  }));

  async function chooseRoot() {
    trusted();
    const files=await vscode.workspace.findFiles('**/project/build.properties','**/{target,node_modules,.git,.metals,.bloop}/**',24);
    const candidates=[];
    for (const uri of files.filter(uri => uri.scheme==='file' && !uri.authority)) {
      const directory=path.dirname(path.dirname(uri.fsPath));
      try {
        const root=await rootFor(directory);
        candidates.push({label:path.basename(root),description:root,root,uri:pathToFileURL(root).href});
      } catch { /* Only observed sbt roots are selectable. */ }
    }
    const active=vscode.window.activeTextEditor?.document.uri;
    const owners=candidates.filter(item => active?.scheme==='file' && inside(item.root,active.fsPath)).sort((a,b) => b.root.length-a.root.length);
    if (!candidates.length) throw fail('Open a workspace containing build.sbt and project/build.properties.');
    if (owners.length) return owners[0].uri;
    if (candidates.length===1) return candidates[0].uri;
    return (await vscode.window.showQuickPick(candidates,{title:'Select sbt Build'}))?.uri;
  }

  function progress(title,action) {
    return vscode.window.withProgress({title,location:vscode.ProgressLocation.Notification,cancellable:true},
      (_progress,cancellation) => action(cancellation));
  }

  function track(action) {
    const work=Promise.resolve().then(action);
    operations.add(work);
    void work.finally(() => operations.delete(work)).catch(() => {});
    return work;
  }

  function register(id,action) {
    subscriptions.push(vscode.commands.registerCommand(id,() => track(async () => {
      try {trusted();return await action();}
      catch (error) {void vscode.window.showErrorMessage('Rocketbrain Scala: '+error.message);return undefined;}
    })));
  }

  async function contextFor(title,choice=true) {
    const projectUri=await chooseRoot();
    if (!projectUri) return undefined;
    const options={projectUri,allowProjectExecution:true};
    output.show(true);
    const report=await progress('Discover sbt Projects',cancellation => discover({...options,cancellation}));
    if (report.state!=='succeeded') return undefined;
    if (!choice) return report;
    const project=await vscode.window.showQuickPick(report.projects.map(item => ({label:item.id,sbtProject:item})),{title});
    return project ? {...options,projectId:project.sbtProject.id} : undefined;
  }

  register(COMMANDS.discover,async () => {
    const report=await contextFor('Discover sbt Projects',false);
    if (report) void vscode.window.showInformationMessage('sbt '+report.sbtVersion+' projects: '+report.projects.map(item => item.id).join(', '));
    return report;
  });
  register(COMMANDS.compile,async () => {
    const options=await contextFor('Select sbt Project to Compile');
    if (!options) return;
    const result=await progress('Compile and Index Scala',cancellation => selected({...options,cancellation},'compile'));
    if (result.state==='succeeded') void vscode.window.showInformationMessage(`Indexed ${result.indexedDocuments} Scala source files from SemanticDB.`);
    return result;
  });
  register(COMMANDS.renameIndex,async () => {
    const projectUri=await chooseRoot();
    if (!projectUri) return;
    output.show(true);
    const result=await progress('Index Scala Sources for Rename',
      cancellation => prepareRenameIndex({projectUri,allowProjectExecution:true,cancellation}));
    if (result.state==='succeeded') {
      void vscode.window.showInformationMessage(`Indexed ${result.indexedDocuments} Scala production and test source files for rename.`);
    }
    return result;
  });
  register(COMMANDS.test,async () => {
    const options=await contextFor('Select sbt Project to Test');
    if (options) return progress('Run sbt Tests',cancellation => selected({...options,cancellation},'test'));
  });
  async function chooseMain(verb) {
    const options=await contextFor('Select sbt Project to '+verb);
    if (!options) return;
    const report=await progress('Find sbt Main Classes',cancellation => selected({...options,cancellation},'mains'));
    if (!report.classes.length) throw fail('No main class was reported for this sbt project.');
    const mainClass=await vscode.window.showQuickPick(report.classes,{title:'Select sbt Main Class'});
    if (mainClass) return {...options,mainClass};
  }
  register(COMMANDS.run,async () => {
    const options=await chooseMain('Run');
    if (options) return progress('Run sbt Main Class',cancellation => runMain({...options,cancellation}));
  });
  register(COMMANDS.debug,async () => {
    const options=await chooseMain('Debug');
    if (options) return progress('Start Scala Debugger',cancellation => debugMain({...options,cancellation}));
  });
  register(COMMANDS.definition,async () => {
    const editor=vscode.window.activeTextEditor;
    const found=editor && definition({document:editor.document,position:editor.selection.active});
    if (!found) throw fail('Compile and index the sbt project, then select a resolved Scala reference.');
    return vscode.window.showTextDocument(found.uri,{preview:true,selection:found.range});
  });
  register(COMMANDS.stop,stopDebug);

  return {discover:options => track(() => discover(options)),compile:options => track(() => selected(options,'compile')),
    test:options => track(() => selected(options,'test')),mainClasses:options => track(() => selected(options,'mains')),
    run:options => track(() => runMain(options)),debug:options => track(() => debugMain(options)),
    prepareRenameIndex:options => track(() => prepareRenameIndex(options)),planRename,definition,references,stop:stopDebug,dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try {
          try {await stopDebug();}
          finally {await runner.dispose();}
        } finally {
          await Promise.allSettled(operations);
          for (const item of subscriptions) item.dispose();
        }
      })();
      return closing;
    }};
}

module.exports={registerScalaWorkbench,COMMANDS};
