'use strict';

const { createHash } = require('node:crypto');
const { requestAt,resolveRequest,sendRequest } = require('./client');

const language = 'rocketbrain-http';
const validName = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const ids = { run:'rocketbrain.http.run', environment:'rocketbrain.http.environment', secret:'rocketbrain.http.saveSecret' };

function registerHttpTools(context, vscode) {
  const output = vscode.window.createOutputChannel('Rocketbrain HTTP');
  const running = new Set();
  let disposed = false;
  function trust() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace before sending HTTP requests.');
  }
  function workspace(document) {
    trust();
    if (!document || document.languageId!==language || document.uri.scheme!=='file' || document.isClosed) {
      throw Error('Open an HTTP request file in a local workspace.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || folder.uri.scheme!=='file') throw Error('Store the HTTP request file in an open local workspace.');
    const key = createHash('sha256').update(folder.uri.toString()).digest('hex');
    return { folder,key };
  }
  const activeDocument = () => vscode.window.activeTextEditor?.document;
  function environments(document) {
    const configured = vscode.workspace.getConfiguration('rocketbrain.http',document.uri).get('environments',{});
    if (!configured || typeof configured!=='object' || Array.isArray(configured) || Object.keys(configured).length>24) {
      throw Error('Define at most 24 HTTP environments in Rocketbrain settings.');
    }
    for (const [name,values] of Object.entries(configured)) {
      if (!validName.test(name) || name==='default' || !values || typeof values!=='object' || Array.isArray(values)) {
        throw Error('Choose distinct named HTTP environments with string variables.');
      }
    }
    return configured;
  }
  const environmentKey = key => 'rocketbrain.http.active.'+key;
  const secretKey = (key,name,secret) => 'rocketbrain.http.secret.'+key+'.'+name+'.'+secret;
  function currentEnvironment(document,key) {
    const settings = environments(document);
    const name = context.workspaceState.get(environmentKey(key),'default');
    if (name==='default') return { name,values:{} };
    if (!Object.hasOwn(settings,name)) throw Error('The selected HTTP environment no longer exists. Choose another one.');
    return { name,values:structuredClone(settings[name]) };
  }
  async function selectEnvironment(document=activeDocument()) {
    const { key }=workspace(document);
    const names = ['default',...Object.keys(environments(document)).sort()];
    const selected = await vscode.window.showQuickPick(names,{title:'Rocketbrain HTTP Environment'});
    if (!selected) return;
    if (workspace(document).key!==key || selected!=='default' && !Object.hasOwn(environments(document),selected)) {
      throw Error('The workspace or HTTP environment changed.');
    }
    await context.workspaceState.update(environmentKey(key),selected);
  }
  async function saveSecret(document=activeDocument()) {
    const { key }=workspace(document), { name }=currentEnvironment(document,key);
    const secret=await vscode.window.showInputBox({title:'HTTP Secret Name',
      prompt:'Enter the identifier after secret. in the variable reference',
      validateInput:value=>validName.test(value)?undefined:'Enter a valid secret identifier.'});
    if (!secret) return;
    const value=await vscode.window.showInputBox({title:'HTTP Secret Value',password:true,
      prompt:'Leave empty to clear this secret from the selected environment'});
    if (value===undefined) return;
    if (workspace(document).key!==key || currentEnvironment(document,key).name!==name) throw Error('The HTTP environment changed.');
    if (Buffer.byteLength(value)>8192) throw Error('HTTP secrets are limited to 8 KiB.');
    if (value) await context.secrets.store(secretKey(key,name,secret),value);
    else await context.secrets.delete(secretKey(key,name,secret));
  }
  async function run(document,offset,{signal}={}) {
    const { key }=workspace(document), savedVersion=document.version, chosen=currentEnvironment(document,key);
    const request=requestAt(document.getText(),offset);
    const controller=new AbortController();
    running.add(controller);
    try {
      const ready=await resolveRequest(request,chosen.values,name=>context.secrets.get(secretKey(key,chosen.name,name)));
      const now=currentEnvironment(document,key);
      if (workspace(document).key!==key || document.version!==savedVersion || now.name!==chosen.name ||
          JSON.stringify(now.values)!==JSON.stringify(chosen.values)) {
        throw Error('The request document or environment changed. Review it again.');
      }
      const response=await sendRequest(ready,{signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
      return { environment:chosen.name,...response };
    } finally {
      running.delete(controller);
    }
  }
  async function runEditor() {
    const editor=vscode.window.activeTextEditor;
    workspace(editor?.document);
    const response=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
      title:'Sending HTTP Request',cancellable:true},async(_,token)=>{
      const controller=new AbortController();
      const subscription=token.onCancellationRequested(()=>controller.abort());
      try {
        if (token.isCancellationRequested) controller.abort();
        return await run(editor.document,editor.document.offsetAt(editor.selection.active),{signal:controller.signal});
      } finally {
        subscription.dispose();
      }
    });
    trust();
    const passed=response.assertions.filter(item=>item.passed).length;
    output.clear();
    output.appendLine('HTTP '+response.status+' · '+response.durationMs+' ms · '+response.environment);
    if (response.assertions.length) {
      output.appendLine(passed+' / '+response.assertions.length+' assertions passed');
      for (const item of response.assertions) output.appendLine((item.passed?'PASS ':'FAIL ')+item.kind+(item.name?' '+item.name:''));
    }
    for (const [name,value] of response.headers) output.appendLine(name+': '+value);
    if (response.body) output.appendLine('\n'+response.body);
    if (response.truncated) output.appendLine('\nResponse omitted after 2 MiB.');
    output.show(true);
    return response;
  }
  const register=(id,action)=>vscode.commands.registerCommand(id,async()=>{
    try { return await action(); }
    catch (error) { if(!disposed) await vscode.window.showErrorMessage('Rocketbrain HTTP: '+error.message); }
  });
  const subscriptions=[register(ids.run,runEditor),register(ids.environment,selectEnvironment),register(ids.secret,saveSecret)];
  return {run,dispose(){
    if(disposed)return;
    disposed=true;
    for (const controller of running) controller.abort();
    for (const subscription of subscriptions) subscription.dispose();
    output.dispose();
  }};
}

module.exports = { registerHttpTools };
