'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');
const { projectSbt,createSbtRunner,observedProjects,mainClasses } = require('./scala-sbt');
const { indexSemanticdb,definitionAt,configSnapshot } = require('./scala-semanticdb');

const COMMANDS={discover:'rocketbrain.scala.discover',compile:'rocketbrain.scala.compile',test:'rocketbrain.scala.test',
  run:'rocketbrain.scala.run',definition:'rocketbrain.scala.definition',stop:'rocketbrain.scala.stop'};

function registerScalaWorkbench(context,vscode,java) {
  const output=vscode.window.createOutputChannel('Rocketbrain Scala / sbt');
  const runner=createSbtRunner({log:text => output.append(text)});
  const projects=new Map(), indexes=new Map(), subscriptions=[output], operations=new Set();
  let disposed=false, closing, epoch=0;

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

  async function task(root,name,options,details={}) {
    trusted(options.cancellation);
    if (options.allowProjectExecution!==true) throw fail('Explicitly choose the sbt task before executing project code.');
    ensureSaved(root);
    const scala=vscode.workspace.getConfiguration('rocketbrain.scala');
    const javaSettings=vscode.workspace.getConfiguration('rocketbrain.java');
    const config=() => JSON.stringify(configSnapshot(root));
    const reviewed=config(), version=epoch;
    const result=await runner.run({root,action:name,projectId:options.projectId,main:details.main,
      javaHome:javaSettings.get('javaHome')||java.getState().javaHome,launcher:scala.get('sbtLauncher'),
      cache:scala.get('cacheDirectory')||path.join(context.globalStorageUri.fsPath,'scala-sbt'),
      repositoryConfig:scala.get('repositoryConfig'),cancellation:options.cancellation,
      workspaceTrusted:vscode.workspace.isTrusted,allowProjectExecution:options.allowProjectExecution});
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
    if (name==='compile') indexes.delete(root);
    const result=await task(root,name,options);
    if (result.state==='succeeded' && name==='compile') {
      trusted(options.cancellation);
      const index=indexSemanticdb(root,options.cancellation);
      if (JSON.stringify(index.configs)!==result.configs) throw fail('Scala build files changed during SemanticDB indexing.');
      remember(indexes,root,index);
      return {...result,indexedDocuments:index.documents.size};
    }
    if (name==='mains') return {...result,classes:result.state==='succeeded' ? mainClasses(result.output) : []};
    return result;
  }

  async function runMain(options={}) {
    const observed=await selected(options,'mains');
    if (!observed.classes.includes(options.mainClass)) throw fail('Choose a main class reported by this sbt project.');
    if (observed.configs!==JSON.stringify(configSnapshot(observed.root))) throw fail('Discover main classes again after editing sbt settings.');
    return task(observed.root,'run',options,{main:options.mainClass});
  }

  function definition({document,position}={},cancellation) {
    trusted(cancellation);
    if (!document || document.uri.scheme!=='file' || document.uri.authority || !document.uri.fsPath.endsWith('.scala')) return undefined;
    const file=workspacePath(document.uri.fsPath,roots(),{directory:false});
    const owner=[...indexes.values()].sort((a,b) => b.root.length-a.root.length).find(index => inside(index.root,file));
    const result=definitionAt(owner,{file,text:document.getText(),position});
    if (!result) return undefined;
    const uri=vscode.Uri.parse(result.uri);
    if (uri.scheme!=='file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    workspacePath(uri.fsPath,roots(),{directory:false});
    const {start,end}=result.range;
    return {symbol:result.symbol,uri,range:new vscode.Range(start.line,start.character,end.line,end.character)};
  }

  subscriptions.push(vscode.languages.registerDefinitionProvider({scheme:'file',language:'scala',pattern:'**/*.scala'}, {
    provideDefinition(document,position,cancellation) {
      try {
        const found=definition({document,position},cancellation);
        return found ? new vscode.Location(found.uri,found.range) : undefined;
      } catch {return undefined;}
    }
  }));

  if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    epoch++;
    indexes.clear();projects.clear();
    void runner.stop().catch(error => output.appendLine(error.message));
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
  register(COMMANDS.test,async () => {
    const options=await contextFor('Select sbt Project to Test');
    if (options) return progress('Run sbt Tests',cancellation => selected({...options,cancellation},'test'));
  });
  register(COMMANDS.run,async () => {
    const options=await contextFor('Select sbt Project to Run');
    if (!options) return;
    const report=await progress('Find sbt Main Classes',cancellation => selected({...options,cancellation},'mains'));
    if (!report.classes.length) throw fail('No main class was reported for this sbt project.');
    const mainClass=await vscode.window.showQuickPick(report.classes,{title:'Select sbt Main Class'});
    if (mainClass) return progress('Run sbt Main Class',cancellation => runMain({...options,mainClass,cancellation}));
  });
  register(COMMANDS.definition,async () => {
    const editor=vscode.window.activeTextEditor;
    const found=editor && definition({document:editor.document,position:editor.selection.active});
    if (!found) throw fail('Compile and index the sbt project, then select a resolved Scala reference.');
    return vscode.window.showTextDocument(found.uri,{preview:true,selection:found.range});
  });
  register(COMMANDS.stop,runner.stop);

  return {discover:options => track(() => discover(options)),compile:options => track(() => selected(options,'compile')),
    test:options => track(() => selected(options,'test')),mainClasses:options => track(() => selected(options,'mains')),
    run:options => track(() => runMain(options)),definition,stop:runner.stop,dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try {await runner.dispose();}
        finally {await Promise.allSettled(operations);for (const item of subscriptions) item.dispose();}
      })();
      return closing;
    }};
}

module.exports={registerScalaWorkbench,COMMANDS};
