'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { workspacePath, workspaceRoots, fail } = require('./workbench-model');
const { projectSbt } = require('./scala-sbt');
const { scalaEditorLaunch } = require('./scala-editor-runtime');

const ids = {start:'rocketbrain.scala.startLanguage',import:'rocketbrain.scala.importLanguageBuild',stop:'rocketbrain.scala.stopLanguage'};

function validateRename(edit, root, newName) {
  if (!edit) return undefined;
  if (edit.changes && edit.documentChanges) throw fail('Scala returned conflicting rename edits.');
  const documents = edit.documentChanges ?? Object.entries(edit.changes ?? {}).map(([uri,edits])=>({textDocument:{uri},edits}));
  if (!Array.isArray(documents) || documents.length<1 || documents.length>100) throw fail('Scala rename exceeds the supported source scope.');
  let count=0;
  for (const item of documents) {
    const uri=item?.textDocument?.uri;
    if (typeof uri!=='string' || !uri.startsWith('file:') || !Array.isArray(item.edits) || item.edits.length<1) {
      throw fail('Scala rename can only change source text within the selected build.');
    }
    const file=workspacePath(fileURLToPath(uri),[root],{directory:false});
    if (!file.endsWith('.scala') || item.edits.some(change=>change.newText!==newName || !change.range)) {
      throw fail('Scala proposed unsupported rename changes.');
    }
    count+=item.edits.length;
    if (count>5000) throw fail('Scala rename exceeds the supported edit count.');
  }
  return edit;
}

function registerScalaEditor(vscode,java) {
  const output=vscode.window.createOutputChannel('Rocketbrain Scala Language');
  const subscriptions=[output];
  let active, disposed=false, serial=Promise.resolve();

  function enqueue(operation) {
    const outcome=serial.then(operation,operation);
    serial=outcome.catch(()=>{});
    return outcome;
  }

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before starting Scala language support.');
  }

  function eligible(document,record) {
    if (!record || active!==record || disposed || !vscode.workspace.isTrusted ||
        document?.uri.scheme!=='file' || document.languageId!=='scala') return false;
    try { return Boolean(workspacePath(document.uri.fsPath,[record.launch.root],{directory:false})); }
    catch { return false; }
  }

  function execute(record,name,token) {
    return record.client.sendRequest('workspace/executeCommand',{command:name,arguments:[]},token);
  }

  async function release() {
    const record=active;
    active=undefined;
    if (!record) return;
    const cancel=new vscode.CancellationTokenSource();
    const deadline=setTimeout(()=>cancel.cancel(),2500);
    try {
      if (record.ready) {
        const action=record.usesOwnedBuildServer ? 'build-disconnect-and-shutdown' : 'build-disconnect';
        await execute(record,action,cancel.token).catch(()=>{});
      }
    } finally {
      clearTimeout(deadline);
      cancel.dispose();
      try { await record.client.stop(6500); }
      finally { record.watcher.dispose(); }
    }
  }

  function start({folder, allowProjectExecution}={}) {
    return enqueue(async()=>{
      trusted();
      if (allowProjectExecution!==true || folder?.uri.scheme!=='file' || folder.uri.authority) {
        throw fail('Choose a local sbt workspace folder and explicitly start its build server.');
      }
      const root=workspacePath(folder.uri.fsPath,workspaceRoots(vscode.workspace.workspaceFolders || []));
      await projectSbt(root);
      let bsp;
      try { bsp=await fs.readdir(path.join(root,'.bsp')); }
      catch (error) { if(error.code!=='ENOENT') throw error; }
      if (active?.ready && !path.relative(root,active.launch.root)) return state();
      await release();
      const settings=vscode.workspace.getConfiguration('rocketbrain.scala',folder.uri);
      const javaHome=vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome') || java.getState().javaHome;
      const launch=await scalaEditorLaunch({root,javaHome,classpathFile:settings.get('languageClasspath'),
        sbtCacheDirectory:settings.get('cacheDirectory')});
      trusted();
      const scope={uri:vscode.Uri.file(root),name:folder.name,index:folder.index};
      const {LanguageClient,ErrorAction,CloseAction}=require('vscode-languageclient/node');
      const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scope,
        '**/{*.scala,*.sbt,build.properties}'));
      const record={launch,watcher,ready:false,usesOwnedBuildServer:!bsp?.some(file=>file.endsWith('.json'))};
      const forwarded=new Set();
      const bounded=(event,next)=>{
        const document=event.document??event;
        if (forwarded.has(document.uri.toString()) && eligible(document,record)) return next(event);
      };
      const configuration={metals:{autoImportBuilds:'off',targetBuildTool:'sbt',defaultBspToBuildTool:false,startMcpServer:false}};
      record.client=new LanguageClient('rocketbrain-scala-language','Rocketbrain Scala Language',
        {command:launch.command,args:launch.args,options:launch.options},{
          workspaceFolder:scope,outputChannel:output,markdown:{isTrusted:false},
          initializationOptions:{isHttpEnabled:false,statusBarProvider:'off'},
          documentSelector:[{scheme:'file',language:'scala',pattern:new vscode.RelativePattern(scope,'**/*.scala')}],
          synchronize:{fileEvents:watcher},
          errorHandler:{error:()=>({action:ErrorAction.Shutdown}),closed:()=>({action:CloseAction.DoNotRestart})},
          middleware:{
            didOpen(document,next) {
              if (!eligible(document,record)) return;
              forwarded.add(document.uri.toString());
              return next(document);
            },
            didChange:bounded,didSave:bounded,
            didClose(document,next) {
              if (forwarded.delete(document.uri.toString())) return next(document);
            },
            workspace:{
              configuration:params=>params.items.map(item=>item.section?.split('.')
                .reduce((section,key)=>section?.[key],configuration) ?? configuration),
              handleApplyEdit:()=>({applied:false,failureReason:'Use the editor action that requested the Scala source change.'})
            },
            async provideRenameEdits(document,position,newName,token) {
              if (!record.ready || !eligible(document,record) || token.isCancellationRequested ||
                  !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(newName)) return undefined;
              const client=record.client;
              const edit=java.scala.planRename({document,position,newName,root},token);
              const reviewed=validateRename(edit,root,newName);
              return reviewed && client.protocol2CodeConverter.asWorkspaceEdit(reviewed,token);
            }
          }
        });
      active=record;
      try {
        await record.client.start();
        trusted();
        record.ready=true;
        return state();
      } catch (error) {
        await release();
        throw error;
      }
    });
  }

  async function importBuild({allowProjectExecution,token}={}) {
    trusted();
    const record=active;
    if (!record?.ready || allowProjectExecution!==true) throw fail('Start Scala language support and explicitly import the selected sbt build.');
    if (record.importing) throw fail('The Scala build is already being imported.');
    record.importing=true;
    try { return await execute(record,'build-import',token); }
    finally { record.importing=false; }
  }

  function state() {
    return active ? {state:active.ready?'ready':'starting',version:active.launch.version,root:active.launch.root} : {state:'stopped'};
  }

  function stop() { return enqueue(release); }

  function command(id,callback) {
    subscriptions.push(vscode.commands.registerCommand(id,async()=>{
      try { return await callback(); }
      catch(error) { void vscode.window.showErrorMessage('Rocketbrain Scala: '+error.message); }
    }));
  }
  command(ids.start,async()=>{
    const folders=(vscode.workspace.workspaceFolders || []).filter(folder=>folder.uri.scheme==='file'&&!folder.uri.authority);
    const current=vscode.window.activeTextEditor?.document.uri;
    const folder=(current&&vscode.workspace.getWorkspaceFolder(current)) ||
      (folders.length===1 ? folders[0] : (await vscode.window.showQuickPick(
        folders.map(item=>({label:item.name,folder:item})),{title:'Choose Scala sbt Workspace'}))?.folder);
    if (folder) return start({folder,allowProjectExecution:true});
  });
  command(ids.import,()=>vscode.window.withProgress({title:'Import Scala sbt Build',location:vscode.ProgressLocation.Notification,cancellable:true},
    (_,token)=>importBuild({allowProjectExecution:true,token})));
  command(ids.stop,stop);
  subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{void stop().catch(error=>output.appendLine(error.message));}));
  return {start,stop,importBuild,getState:state,async dispose(){
    if (disposed) return;
    disposed=true;
    try { await stop(); }
    finally { for (const subscription of subscriptions) subscription.dispose(); }
  }};
}

module.exports={registerScalaEditor,validateRename};
