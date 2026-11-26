'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { setTimeout:delay } = require('node:timers/promises');
const { nativeTaskRunner } = require('./workbench-tasks');
const { projectForRoot,loadKmpModel } = require('./kmp-gradle');
const { runKmpTasks } = require('./kmp-workbench');
const { startKmpJvmDebug } = require('./kmp-jvm-debug');
const { DEBUG_TYPE,processAttachTarget } = require('./debug');
const { definitionForKmp } = require('./kmp-sources');
const {previewCandidates,renderComposePreview}=require('./kmp-compose-preview');
const { fileKey } = require('./dependency-builds');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');

const COMMANDS={inspect:'rocketbrain.kotlin.multiplatform.inspect',compile:'rocketbrain.kotlin.multiplatform.compile',
  test:'rocketbrain.kotlin.multiplatform.test',run:'rocketbrain.kotlin.multiplatform.run',
  debug:'rocketbrain.kotlin.multiplatform.debugJvm',
  definition:'rocketbrain.kotlin.multiplatform.definition',stop:'rocketbrain.kotlin.multiplatform.stop',
  preview:'rocketbrain.kotlin.multiplatform.previewCompose',refreshPreview:'rocketbrain.kotlin.multiplatform.refreshComposePreview'};
const debugMarker='__rocketbrainKmpDebugSession';

async function withDeadline(work,timeout,message,cancellation) {
  const timer=new AbortController();
  const aborted=()=>timer.abort();
  cancellation?.addEventListener('abort',aborted,{once:true});
  if (cancellation?.aborted) aborted();
  const expired=delay(timeout,undefined,{signal:timer.signal}).then(()=>{throw fail(message);},()=>{
    throw fail('Kotlin JVM debugging was cancelled.');
  });
  try {return await Promise.race([work,expired]);}
  finally {timer.abort();cancellation?.removeEventListener('abort',aborted);}
}

function registerKmpWorkbench(vscode,java) {
  const runner=nativeTaskRunner(vscode), models=new Map(), indexes=new Map(), subscriptions=[];
  const previewImages=new WeakMap();
  const pendingDebug=new Map(), output=vscode.window.createOutputChannel('Rocketbrain Kotlin JVM Debug');
  subscriptions.push(output);
  let disposed=false, closing, active, previewPanel, visiblePreview, ownedDebug;

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
      if (active || ownedDebug) throw fail('Finish or stop the current owned Kotlin Gradle task.');
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

  function finishDebug(record) {
    if (!record) return Promise.resolve();
    if (!record.closing) record.closing=(async()=>{
      try {
        const termination=record.run.stop();
        void termination.catch(()=>{});
        if (record.session && !record.sessionEnded) await withDeadline(
          Promise.resolve(vscode.debug.stopDebugging(record.session)),5000,'The Kotlin debugger session did not stop.').catch(()=>{});
        await termination;
      } finally {
        if (ownedDebug===record) ownedDebug=undefined;
      }
    })();
    return record.closing;
  }

  function debugJvm(options={}) {
    return runOwned(options,async details=>{
      const model=models.get(details.root);
      if (!model) throw fail('Inspect the Kotlin Multiplatform Gradle model before selecting a JVM application.');
      await withDeadline(Promise.resolve(java.start()),45000,'The independent Java debugger did not start.',details.cancellation);
      trusted(details.cancellation);
      if (!java.getState().debugBundlePath) throw fail('Configure the independent Java debug bundle before debugging Kotlin.');
      output.show(true);
      const run=await startKmpJvmDebug({...details,model,resolveDescendant:java.debug.processes.resolveDescendant,
        onOutput:chunk=>output.append(chunk)});
      const token=randomUUID(), record={run,token,session:undefined,sessionEnded:false,closing:undefined,attached:false};
      ownedDebug=record;
      pendingDebug.set(token,record);
      try {
        trusted(details.cancellation);
        saved(details.root);
        const folder=vscode.workspace.getWorkspaceFolder(vscode.Uri.file(details.root));
        const launched=Promise.resolve().then(()=>vscode.debug.startDebugging(folder,{
          type:DEBUG_TYPE,request:'attach',name:'Kotlin JVM: '+run.task,...processAttachTarget(run.target),
          sourcePaths:run.sourcePaths,[debugMarker]:token
        },{suppressSaveBeforeStart:true}));
        void launched.finally(()=>pendingDebug.delete(token)).catch(()=>{});
        if (!await withDeadline(launched,35000,'The Kotlin JVM debugger did not start.',details.cancellation)) {
          throw fail('VS Code did not start the owned Kotlin JVM debugger.');
        }
        const deadline=Date.now()+10000;
        while (!record.attached && java.debug.verifiedLocalPid(record.session)!==run.target.pid) {
          trusted(details.cancellation);
          if (Date.now()>=deadline || record.sessionEnded || ownedDebug!==record) {
            throw fail('The Java debugger did not acknowledge the owned Kotlin JVM listener.');
          }
          await delay(100);
        }
        void run.done.finally(()=>finishDebug(record)).catch(error=>output.appendLine(error.message));
        return {state:'attached',task:run.task,sessionId:record.session.id,pid:run.target.pid,verifiedLoopback:true};
      } catch (error) {
        await finishDebug(record);
        throw error;
      }
    });
  }

  subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE,{createDebugAdapterTracker(session) {
    const token=session.configuration[debugMarker];
    const record=pendingDebug.get(token) || (ownedDebug?.token===token ? ownedDebug : undefined);
    if (!record) return undefined;
    record.session ||= session;
    return {onDidSendMessage(message) {
      if (message.type==='response' && message.command==='attach' && message.success &&
          java.debug.verifiedLocalPid(session)===record.run.target.pid) record.attached=true;
    }};
  }}),vscode.debug.onDidStartDebugSession(session=>{
    const token=session.configuration[debugMarker];
    const record=pendingDebug.get(token) || (ownedDebug?.token===token ? ownedDebug : undefined);
    if (!record || session.type!==DEBUG_TYPE) return;
    record.session=session;
    if (record.closing) void vscode.debug.stopDebugging(session).then(undefined,()=>{});
  }),vscode.debug.onDidTerminateDebugSession(session=>{
    const record=ownedDebug;
    if (record?.session?.id!==session.id) return;
    record.sessionEnded=true;
    // Give a naturally completed app a moment to publish its Gradle result.
    void Promise.race([record.run.done,delay(1700)]).finally(()=>finishDebug(record)).catch(error=>output.appendLine(error.message));
  }));

  function composeModel(projectUri) {
    const root=rootFor(projectUri),model=models.get(root);
    if (!model) throw fail('Inspect the Kotlin Multiplatform targets before choosing a Compose preview.');
    return {root,model};
  }

  function composeSource(document,root) {
    if (!document || document.isClosed || document.uri.scheme!=='file'||document.uri.authority||
        document.languageId!=='kotlin'||!document.uri.fsPath.endsWith('.kt')) {
      throw fail('Open a saved commonMain Kotlin source file with a Compose preview.');
    }
    const file=workspacePath(document.uri.fsPath,[root],{directory:false});
    if (document.isDirty) throw fail('Save the Compose source before rendering.');
    return file;
  }

  function composeCandidates({projectUri,document}) {
    trusted();
    const {root,model}=composeModel(projectUri);
    return previewCandidates(model,composeSource(document,root));
  }

  function preview(options) {
    return runOwned(options,async details=>{
      const {model}=composeModel(details.projectUri);
      const file=composeSource(details.document,details.root);
      const {png,report}=await renderComposePreview({...details,model,file});
      trusted(details.cancellation);
      saved(details.root);
      const receipt=Object.freeze(report);
      previewImages.set(receipt,{png,options:{
        projectUri:details.projectUri,sourceUri:details.document.uri,modulePath:details.modulePath,
        targetName:details.targetName,qualified:details.qualified,width:report.width,height:report.height
      }});
      return receipt;
    });
  }

  function showComposePreview(receipt) {
    trusted();
    const subject=previewImages.get(receipt);
    if (!subject) throw fail('Render the current Compose preview before opening it.');
    if (!previewPanel) {
      const panel=vscode.window.createWebviewPanel('rocketbrainComposePreview','Kotlin Compose Preview',
        {viewColumn:vscode.ViewColumn.Beside,preserveFocus:true},
        {enableScripts:false,localResourceRoots:[],enableCommandUris:[COMMANDS.refreshPreview]});
      previewPanel=panel;
      panel.onDidDispose(()=>{
        if (previewPanel===panel) {previewPanel=undefined;visiblePreview=undefined;}
      });
    }
    visiblePreview=subject.options;
    const image=subject.png.toString('base64');
    // Qualified name and target are bounded compiler/model identifiers; all other content is fixed.
    previewPanel.webview.html='<!doctype html><html lang="en"><head><meta charset="utf-8">'+
      '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;">'+
      '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kotlin Compose Preview</title>'+
      '<style>body{padding:18px}header{margin-bottom:18px}img{max-width:100%;height:auto;background:var(--vscode-editor-background)}'+
      'h1{font-size:1.2rem}a{color:var(--vscode-textLink-foreground)}</style></head><body>'+
      '<header><h1>'+receipt.qualified+'</h1><p>'+receipt.targetName+' · '+receipt.width+' × '+receipt.height+
      '</p><a href="command:'+COMMANDS.refreshPreview+'">Refresh Preview</a></header>'+
      '<img alt="Rendered Compose preview" width="'+receipt.width+'" height="'+receipt.height+
      '" src="data:image/png;base64,'+image+'"></body></html>';
    return previewPanel;
  }

  async function refreshCompose() {
    const selection=visiblePreview;
    if (!selection) throw fail('Open a Kotlin Compose preview first.');
    const document=await vscode.workspace.openTextDocument(selection.sourceUri);
    const receipt=await progress('Refresh Kotlin Compose Preview',cancellation=>preview({...selection,document,
      allowProjectExecution:true,cancellation}));
    if (selection===visiblePreview) showComposePreview(receipt);
    return receipt;
  }

  function definition({document,position}={},cancellation) {
    trusted(cancellation);
    if (!document || document.uri.scheme!=='file' || document.uri.authority || !document.uri.fsPath.endsWith('.kt')) return [];
    const file=workspacePath(document.uri.fsPath,roots(),{directory:false});
    const key=fileKey(file);
    const matches=[...indexes.values()].filter(index => index.files.has(key));
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
    await finishDebug(ownedDebug);
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
    previewPanel?.dispose();
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
    const targetTask=target=>action==='debug' ? target.platform==='jvm' && target.runTask : target[action+'Task'];
    const single=['run','debug'].includes(action);
    const modules=model.modules.filter(module => module.targets.some(targetTask));
    if (!modules.length) throw fail('Gradle reported no runnable '+action+' tasks for the supported Kotlin targets.');
    const module=modules.length===1 ? modules[0] : (await vscode.window.showQuickPick(modules.map(item => ({label:item.path,module:item})),
      {title:'Select Kotlin Multiplatform Module'}))?.module;
    if (!module) return;
    const targets=module.targets.filter(targetTask).map(target => ({label:target.name,description:target.platform,
      detail:targetTask(target),target,picked:!single}));
    const items=single ? [await vscode.window.showQuickPick(targets,{title:action==='debug'?'Select Kotlin JVM Debug Target':'Select Kotlin Run Target'})].filter(Boolean)
      : await vscode.window.showQuickPick(targets,{title:'Select Kotlin '+action+' Targets',canPickMany:true});
    if (!items?.length) return;
    if (action==='debug') return progress('Debug Kotlin JVM Target',cancellation=>debugJvm({...options,modulePath:module.path,
      targetName:items[0].target.name,cancellation}));
    const result=await progress('Kotlin Multiplatform '+action,cancellation => execute({...options,modulePath:module.path,
      targetNames:items.map(item => item.target.name),cancellation},action));
    if (result.linkedDeclarations!==undefined) void vscode.window.showInformationMessage(`Indexed ${result.linkedDeclarations} Kotlin expect/actual declarations.`);
    return result;
  }

  for (const action of ['compile','test','run','debug']) register(COMMANDS[action],() => chooseTask(action));
  register(COMMANDS.definition,async () => {
    const editor=vscode.window.activeTextEditor;
    const targets=editor ? definition({document:editor.document,position:editor.selection.active}) : [];
    if (!targets.length) throw fail('Compile the Kotlin targets and select an indexed expect or actual declaration.');
    const found=targets.length===1 ? targets[0] : (await vscode.window.showQuickPick(targets.map(item => ({
      label:item.name,description:item.sourceSet+' · '+item.targets.join(', '),item})),{title:'Select Kotlin Counterpart'}))?.item;
    if (found) return vscode.window.showTextDocument(found.uri,{preview:true,selection:found.range});
  });
  register(COMMANDS.preview,async()=>{
    const document=vscode.window.activeTextEditor?.document;
    if (!document||document.languageId!=='kotlin'||document.isDirty) throw fail('Open a saved commonMain Kotlin file with a Compose preview.');
    const configuration=await chooseModel();
    if (!configuration) return;
    const {options}=configuration;
    const candidates=composeCandidates({...options,document});
    if (!candidates.length) throw fail('No supported @Preview and @Composable function was found in this commonMain file.');
    const selected=await vscode.window.showQuickPick(candidates.map(item=>({label:item.name,
      description:item.targetName+' · '+item.modulePath,item})),{title:'Choose Kotlin Compose Preview and JVM Target'});
    if (!selected) return;
    const {qualified,modulePath,targetName}=selected.item;
    const receipt=await progress('Render Kotlin Compose Preview',cancellation=>preview({...options,document,qualified,modulePath,targetName,cancellation}));
    showComposePreview(receipt);
    return receipt;
  });
  register(COMMANDS.refreshPreview,refreshCompose);
  register(COMMANDS.stop,stop);

  return {inspect,compile:options=>execute(options,'compile'),test:options=>execute(options,'test'),run:options=>execute(options,'run'),
    debugJvm,definition,composeCandidates,preview,showComposePreview,refreshCompose,stop,dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try {await stop();await runner.dispose();}
        finally {previewPanel?.dispose();for (const item of subscriptions) item.dispose();}
      })();
      return closing;
    }};
}

module.exports={registerKmpWorkbench,COMMANDS};
