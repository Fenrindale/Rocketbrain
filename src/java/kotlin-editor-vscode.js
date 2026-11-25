'use strict';

const path = require('node:path');
const { kotlinEditorLaunch,hasGradleFiles,kotlinProtocolUri } = require('./kotlin-editor-runtime');
const { inside,workspacePath,workspaceRoots,fail } = require('./workbench-model');

const COMMANDS={start:'rocketbrain.kotlinEditor.start',stop:'rocketbrain.kotlinEditor.stop',output:'rocketbrain.kotlinEditor.output'};

function registerKotlinEditor(context,vscode,java) {
  const output=vscode.window.createOutputChannel('Rocketbrain Kotlin Editor',{log:true});
  const subscriptions=[output];
  let state={state:'stopped'}, active, closing, disposed=false, suspended=false, pending=Promise.resolve();

  function serial(action) {
    const task=pending.then(action,action);
    pending=task.catch(()=>{});
    return task;
  }

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before starting Kotlin editing.');
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders||[]);}

  function projectOf(document) {
    if (!document || document.languageId!=='kotlin' || document.uri.scheme!=='file' || document.uri.authority) return undefined;
    const boundary=roots();
    const source=workspacePath(document.uri.fsPath,boundary,{directory:false});
    const outer=boundary.filter(root => inside(root,source)).sort((a,b)=>b.length-a.length)[0];
    if (!outer) return undefined;
    let directory=path.dirname(source);
    for (let depth=0; depth<24 && inside(outer,directory); depth++) {
      if (hasGradleFiles(directory)) return directory;
      const parent=path.dirname(directory);
      if (!path.relative(directory,parent)) break;
      directory=parent;
    }
  }

  function report(next,details={}) {
    state={state:next,...details};
    if (details.message) output.appendLine(details.message);
    return {...state};
  }

  async function release(record) {
    if (record.released) return record.released;
    record.stopping=true;
    record.released=(async () => {
      try {if (record.client) await record.client.stop(5000);}
      catch (error) {output.appendLine('Kotlin language-server shutdown: '+error.message);}
      finally {
        record.watcher?.dispose();
        await record.launch.dispose();
      }
    })();
    return record.released;
  }

  async function stopNow() {
    const record=active;
    active=undefined;
    try {if (record) await release(record);}
    catch (error) {report('error',{message:error.message});throw error;}
    return report('stopped');
  }

  async function startNow(root) {
    trusted();
    const settings=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor');
    const serverHome=settings.get('serverHome');
    if (!serverHome) throw fail('Configure the extracted open ktlsp server in rocketbrain.kotlinEditor.serverHome.');
    if (!root) throw fail('Open a Kotlin source file in a local Gradle project first.');
    if (active && !path.relative(active.launch.root,root) && state.state==='running') return {...state};
    if (active) await stopNow();
    const javaSettings=vscode.workspace.getConfiguration('rocketbrain.java');
    report('starting',{message:'Starting Rocketbrain Kotlin editing for '+path.basename(root)+'.'});
    let record, timeout;
    try {
      const launch=await kotlinEditorLaunch({serverHome,root,
        javaHome:javaSettings.get('javaHome')||java.getState().javaHome,gradleHome:javaSettings.get('gradleHome'),
        gradleUserHome:settings.get('gradleUserHome'),storageRoot:(context.storageUri||context.globalStorageUri).fsPath});
      record={launch};
      active=record;
      trusted();
      if (suspended) throw fail('Kotlin editing was stopped while its server was preparing.');
      const uri=vscode.Uri.file(launch.root), folder=vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) throw fail('Keep the Kotlin Gradle project inside an open workspace.');
      const scope={uri,name:path.basename(launch.root),index:folder.index};
      const { LanguageClient,ErrorAction,CloseAction }=require('vscode-languageclient/node');
      record.watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scope,
        '**/{*.kt,*.kts,build.gradle,settings.gradle,gradle.properties}'));
      record.client=new LanguageClient('rocketbrain-kotlin-editor','Rocketbrain Kotlin Editor',
        {command:launch.command,args:launch.args,options:launch.options},{
          workspaceFolder:scope,outputChannel:output,
          documentSelector:[{scheme:'file',language:'kotlin',pattern:new vscode.RelativePattern(scope,'**/*.kt')}],
          uriConverters:{code2Protocol:uri=>uri.scheme==='file' && !uri.authority ? kotlinProtocolUri(uri.fsPath) : uri.toString(),
            protocol2Code:value=>vscode.Uri.parse(value)},
          synchronize:{fileEvents:record.watcher},markdown:{isTrusted:false},
          middleware:{workspace:{handleApplyEdit:() => ({applied:false,failureReason:'Apply Kotlin editor changes through the VS Code action that initiated them.'})}},
          errorHandler:{error:()=>({action:ErrorAction.Shutdown}),closed:()=>{
            if (active===record && !record.stopping) {
              active=undefined;
              report('error',{message:'The Kotlin language server exited. Check the Rocketbrain Kotlin Editor output.'});
              void release(record).catch(error=>output.appendLine(error.message));
            }
            return {action:CloseAction.DoNotRestart};
          }}
        });
      await Promise.race([record.client.start(),new Promise((_,reject)=>{
        timeout=setTimeout(()=>reject(fail('Kotlin editor startup timed out. Check its Output channel.')),90000);
      })]);
      trusted();
      if (suspended || active!==record) throw fail('Kotlin editing stopped during startup.');
      return report('running',{projectUri:uri.toString(),serverVersion:launch.serverVersion,
        compilerVersion:launch.compilerVersion,windowsPathAdapter:launch.windowsPathAdapter,message:'Kotlin language features are connected.'});
    } catch (error) {
      if (active===record) active=undefined;
      if (record) await release(record);
      report('error',{message:error.message});
      throw error;
    } finally {clearTimeout(timeout);}
  }

  function start({projectUri}={}) {
    suspended=false;
    return serial(() => {
      trusted();
      const root=projectUri ? workspacePath(projectUri,roots()) : projectOf(vscode.window.activeTextEditor?.document);
      return startNow(root);
    });
  }

  function stop() {suspended=true;return serial(stopNow);}

  function automatic(document) {
    if (disposed || suspended || !vscode.workspace.isTrusted || !vscode.workspace.getConfiguration('rocketbrain.kotlinEditor').get('serverHome')) return;
    if (document?.languageId!=='kotlin') return;
    void serial(async () => {
      if (disposed || suspended || !vscode.workspace.isTrusted) return;
      const root=projectOf(document);
      if (root) await startNow(root);
    }).catch(error=>output.appendLine(error.message));
  }

  subscriptions.push(vscode.commands.registerCommand(COMMANDS.start,async () => {
    try {return await start();}
    catch (error) {void vscode.window.showErrorMessage('Rocketbrain Kotlin: '+error.message);}
  }),vscode.commands.registerCommand(COMMANDS.stop,stop),
  vscode.commands.registerCommand(COMMANDS.output,()=>output.show()),
  vscode.window.onDidChangeActiveTextEditor(editor=>automatic(editor?.document)),
  vscode.workspace.onDidChangeConfiguration(event=>{
    if (!['rocketbrain.kotlinEditor','rocketbrain.java.javaHome','rocketbrain.java.gradleHome'].some(name=>event.affectsConfiguration(name))) return;
    void serial(stopNow).then(()=>automatic(vscode.window.activeTextEditor?.document)).catch(error=>output.appendLine(error.message));
  }),vscode.workspace.onDidChangeWorkspaceFolders(()=>{
    void serial(stopNow).then(()=>automatic(vscode.window.activeTextEditor?.document)).catch(error=>output.appendLine(error.message));
  }));
  automatic(vscode.window.activeTextEditor?.document);

  return {start,stop,getState:()=>({...state}),dispose() {
    if (closing) return closing;
    disposed=true;
    suspended=true;
    closing=serial(stopNow).finally(()=>{for (const item of subscriptions) item.dispose();});
    return closing;
  }};
}

module.exports={registerKotlinEditor,COMMANDS};
