'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { nativeTaskRunner } = require('./workbench-tasks');
const { projectForRoot,loadKmpModel } = require('./kmp-gradle');
const { runKmpTasks } = require('./kmp-workbench');
const { definitionForKmp } = require('./kmp-sources');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');

const COMMANDS={inspect:'rocketbrain.kotlin.multiplatform.inspect',compile:'rocketbrain.kotlin.multiplatform.compile',
  test:'rocketbrain.kotlin.multiplatform.test',run:'rocketbrain.kotlin.multiplatform.run',
  definition:'rocketbrain.kotlin.multiplatform.definition',stop:'rocketbrain.kotlin.multiplatform.stop'};

function registerKmpWorkbench(vscode,java) {
  const runner=nativeTaskRunner(vscode), models=new Map(), indexes=new Map(), subscriptions=[];
  let disposed=false, closing, active;

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before using Kotlin Multiplatform.');
    if (cancelled(cancellation)) throw fail('Kotlin Multiplatform operation cancelled.');
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders||[]);}
  function tools() {
    const settings=vscode.workspace.getConfiguration('rocketbrain.java'), kotlin=vscode.workspace.getConfiguration('rocketbrain.kotlin');
    return {javaHome:settings.get('gradleJavaHome') || settings.get('javaHome') || java.getState().javaHome,
      gradleHome:kotlin.get('gradleHome') || settings.get('gradleHome'),nodeHome:kotlin.get('nodeHome'),
      gradleUserHome:kotlin.get('gradleUserHome')};
  }

  function rootFor(projectUri) {
    const root=workspacePath(projectUri,roots());
    projectForRoot(root);
    return root;
  }

  function saved(root) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme==='file' &&
        inside(root,document.uri.fsPath) && /\.(?:kt|gradle|kts|java|properties|toml)$/.test(document.uri.fsPath))) {
      throw fail('Save modified Kotlin and Gradle input files before executing the project.');
    }
  }

  function remember(map,key,value) {
    map.delete(key);
    if (map.size>=6) map.delete(map.keys().next().value);
    map.set(key,value);
  }

  function runOwned(options={},action) {
    return Promise.resolve().then(async () => {
      if (options.allowProjectExecution!==true) throw fail('Explicitly choose the Kotlin Gradle action before executing the project.');
      trusted(options.cancellation);
      if (active) throw fail('Finish or stop the current owned Kotlin Gradle task.');
      const controller=new AbortController(), provided=options.cancellation, cancel=() => controller.abort();
      const subscription=provided?.onCancellationRequested?.(cancel);
      provided?.addEventListener?.('abort',cancel,{once:true});
      const record={controller};
      active=record;
      try {
        const root=rootFor(options.projectUri);
        saved(root);
        record.work=action({...options,root,tools:tools(),runner,cancellation:controller.signal,workspaceTrusted:vscode.workspace.isTrusted});
        return await record.work;
      } finally {
        if (active===record) active=undefined;
        subscription?.dispose();
        provided?.removeEventListener?.('abort',cancel);
      }
    });
  }

  function inspect(options) {
    return runOwned(options,async details => {
      const model=await loadKmpModel(details);
      trusted(details.cancellation);
      remember(models,model.root,model);
      return structuredClone(model);
    });
  }

  function moduleKey(root,modulePath) {return root+'\0'+modulePath;}

  function execute(options,action) {
    return runOwned(options,async details => {
      const model=models.get(details.root);
      if (!model) throw fail('Inspect the Kotlin Multiplatform Gradle model before selecting tasks.');
      const key=moduleKey(details.root,details.modulePath);
      if (action==='compile') indexes.delete(key);
      const {result,index}=await runKmpTasks({...details,model,action});
      if (index) {
        trusted(details.cancellation);
        remember(indexes,key,index);
      }
      return result;
    });
  }

  function definition({document,position}={},cancellation) {
    trusted(cancellation);
    if (!document || document.uri.scheme!=='file' || document.uri.authority || !document.uri.fsPath.endsWith('.kt')) return [];
    const file=workspacePath(document.uri.fsPath,roots(),{directory:false});
    const matches=[...indexes.values()].filter(index => index.files.has(file));
    if (matches.length!==1) return [];
    const results=definitionForKmp(matches[0],{file,text:document.getText(),position},cancellation);
    return results.map(item => {
      const uri=vscode.Uri.parse(item.uri);
      if (uri.scheme!=='file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri)) {
        throw fail('Kotlin declaration targets must be inside the local workspace.');
      }
      workspacePath(uri.fsPath,roots(),{directory:false});
      const {start,end}=item.range;
      return {...item,uri,range:new vscode.Range(start.line,start.character,end.line,end.character)};
    });
  }

  async function stop() {
    const record=active;
    record?.controller.abort();
    await runner.stop();
    if (record?.work) await record.work.catch(()=>{});
    return {state:'stopped'};
  }

  subscriptions.push(vscode.languages.registerDefinitionProvider({scheme:'file',language:'kotlin',pattern:'**/*.kt'}, {
    provideDefinition(document,position,cancellation) {
      try {return definition({document,position},cancellation).map(item => new vscode.Location(item.uri,item.range));}
      catch {return undefined;}
    }
  }));
  if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    models.clear();indexes.clear();
    void stop().catch(()=>{});
  }));

  async function chooseRoot() {
    const settings=await vscode.workspace.findFiles('**/{settings.gradle,settings.gradle.kts}','**/{node_modules,build,.gradle,.git}/**',24);
    trusted();
    const choices=new Map();
    for (const uri of settings.filter(item => item.scheme==='file' && !item.authority)) {
      try {
        const root=rootFor(path.dirname(uri.fsPath));
        choices.set(root,{label:path.basename(root),description:root,uri:pathToFileURL(root).href});
      } catch { /* Unsupported roots are omitted. */ }
    }
    const available=[...choices].sort(([left],[right]) => right.length-left.length);
    if (!available.length) throw fail('Open a Gradle Kotlin Multiplatform project first.');
    const uri=vscode.window.activeTextEditor?.document.uri;
    const selected=available.find(([root]) => uri?.scheme==='file' && inside(root,uri.fsPath))?.[1];
    return (selected || (available.length===1 ? available[0][1] : await vscode.window.showQuickPick(available.map(([,item])=>item),
      {title:'Select Kotlin Multiplatform Gradle Build'})))?.uri;
  }

  function progress(title,action) {
    return vscode.window.withProgress({title,location:vscode.ProgressLocation.Notification,cancellable:true},
      (_progress,cancellation) => action(cancellation));
  }

  function register(id,handler) {
    subscriptions.push(vscode.commands.registerCommand(id,async () => {
      try {trusted();return await handler();}
      catch (error) {void vscode.window.showErrorMessage('Rocketbrain Kotlin: '+error.message);return undefined;}
    }));
  }

  async function chooseModel() {
    const projectUri=await chooseRoot();
    if (!projectUri) return undefined;
    const root=rootFor(projectUri), existing=models.get(root);
    const options={projectUri,allowProjectExecution:true};
    return {options,model:existing || await progress('Inspect Kotlin Multiplatform Targets',cancellation => inspect({...options,cancellation}))};
  }

  register(COMMANDS.inspect,async () => {
    const projectUri=await chooseRoot();
    if (!projectUri) return;
    const model=await progress('Inspect Kotlin Multiplatform Targets',cancellation => inspect({projectUri,allowProjectExecution:true,cancellation}));
    const rows=model.modules.flatMap(module => [
      ...module.targets.map(target => ({label:module.path+' '+target.name,description:target.platform,detail:target.main.join(' · ')})),
      ...module.sourceSets.map(set => ({label:module.path+' '+set.name,
        description:set.dependsOn.length ? 'depends on '+set.dependsOn.join(', ') : 'Kotlin source set',detail:set.directories.join(' · ')}))
    ]);
    await vscode.window.showQuickPick(rows,{title:'Kotlin Multiplatform Targets and Source Sets'});
    return model;
  });

  async function chooseTask(action) {
    const choice=await chooseModel();
    if (!choice) return;
    const {model,options}=choice;
    const modules=model.modules.filter(module => module.targets.some(target => target[action+'Task']));
    if (!modules.length) throw fail('Gradle reported no runnable '+action+' tasks for the supported Kotlin targets.');
    const module=modules.length===1 ? modules[0] : (await vscode.window.showQuickPick(modules.map(item => ({label:item.path,module:item})),
      {title:'Select Kotlin Multiplatform Module'}))?.module;
    if (!module) return;
    const targets=module.targets.filter(target => target[action+'Task']).map(target => ({label:target.name,description:target.platform,
      detail:target[action+'Task'],target,picked:action!=='run'}));
    const items=action==='run' ? [await vscode.window.showQuickPick(targets,{title:'Select Kotlin Run Target'})].filter(Boolean)
      : await vscode.window.showQuickPick(targets,{title:'Select Kotlin '+action+' Targets',canPickMany:true});
    if (!items?.length) return;
    const result=await progress('Kotlin Multiplatform '+action,cancellation => execute({...options,modulePath:module.path,
      targetNames:items.map(item => item.target.name),cancellation},action));
    if (result.linkedDeclarations!==undefined) void vscode.window.showInformationMessage(`Indexed ${result.linkedDeclarations} Kotlin expect/actual declarations.`);
    return result;
  }

  for (const action of ['compile','test','run']) register(COMMANDS[action],() => chooseTask(action));
  register(COMMANDS.definition,async () => {
    const editor=vscode.window.activeTextEditor;
    const targets=editor ? definition({document:editor.document,position:editor.selection.active}) : [];
    if (!targets.length) throw fail('Compile the Kotlin targets and select an indexed expect or actual declaration.');
    const found=targets.length===1 ? targets[0] : (await vscode.window.showQuickPick(targets.map(item => ({
      label:item.name,description:item.sourceSet+' · '+item.targets.join(', '),item})),{title:'Select Kotlin Counterpart'}))?.item;
    if (found) return vscode.window.showTextDocument(found.uri,{preview:true,selection:found.range});
  });
  register(COMMANDS.stop,stop);

  return {inspect,compile:options=>execute(options,'compile'),test:options=>execute(options,'test'),run:options=>execute(options,'run'),
    definition,stop,dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try {await stop();await runner.dispose();}
        finally {for (const item of subscriptions) item.dispose();}
      })();
      return closing;
    }};
}

module.exports={registerKmpWorkbench,COMMANDS};
