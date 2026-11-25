'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { requestAt,resolveRequest,sendRequest } = require('./client');
const { readWorkspaceBodyFile } = require('./body-file');
const { HttpCookieJars } = require('./cookie-jar');
const { websocketWorkbench } = require('./websocket');

async function readProto(folder,value) {
  const parts=value.split('/');
  if (!/\.proto$/i.test(value) || value.length>512 || parts.some(part=>!part || ['.','..'].includes(part) || /[\\:\x00-\x1f\x7f]/.test(part))) {
    throw Error('Use a workspace-relative Proto path, such as api/example.proto.');
  }
  try {
    const root=await fs.realpath(folder.uri.fsPath), source=await fs.realpath(path.join(root,...parts));
    const relative=path.relative(root,source);
    if (!relative || path.isAbsolute(relative) || relative==='..' || relative.startsWith('..'+path.sep)) throw Error();
    const handle=await fs.open(source,'r');
    try {
      if (!(await handle.stat()).isFile()) throw Error();
      const body=Buffer.alloc(128*1024+1);
      const {bytesRead}=await handle.read(body,0,body.length,0);
      if (bytesRead===body.length) throw Error();
      return new TextDecoder('utf-8',{fatal:true}).decode(body.subarray(0,bytesRead));
    } finally { await handle.close(); }
  } catch { throw Error('Open a readable UTF-8 .proto file inside this workspace, up to 128 KiB.'); }
}

const language = 'rocketbrain-http';
const validName = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const ids = {
  run:'rocketbrain.http.run',environment:'rocketbrain.http.environment',secret:'rocketbrain.http.saveSecret',
  schema:'rocketbrain.http.graphqlSchema',websocketSessions:'rocketbrain.http.websocketSessions',
  websocketSend:'rocketbrain.http.websocketSend',websocketClose:'rocketbrain.http.websocketClose'
};

function registerHttpTools(context, vscode) {
  const output = vscode.window.createOutputChannel('Rocketbrain HTTP');
  const transcript = vscode.window.createOutputChannel('Rocketbrain WebSocket');
  const running = new Set();
  const cookies = new HttpCookieJars();
  let disposed=false, selectedSession, pendingRender, renderTimer;
  const connections=websocketWorkbench(session=>{
    if (disposed || selectedSession!==session.id) return;
    pendingRender=session;
    if (!renderTimer) renderTimer=setTimeout(()=>{
      renderTimer=undefined;
      if (pendingRender?.id===selectedSession) renderTranscript(pendingRender);
      pendingRender=undefined;
    },80);
  });
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
    return storeSecret(document,{name:secret,value,approved:true});
  }
  async function storeSecret(document,{name,value,approved}={}) {
    const {key}=workspace(document),environment=currentEnvironment(document,key).name;
    if (approved!==true||typeof name!=='string'||!validName.test(name)||
        typeof value!=='string'||Buffer.byteLength(value)>8192||value.includes('\0')) {
      throw Error('Explicitly select an HTTP secret name and a value up to 8 KiB.');
    }
    if (value) await context.secrets.store(secretKey(key,environment,name),value);
    else await context.secrets.delete(secretKey(key,environment,name));
  }
  async function run(document,offset,{signal,schema=false}={}) {
    const { key,folder }=workspace(document), savedVersion=document.version, chosen=currentEnvironment(document,key);
    const request=requestAt(document.getText(),offset);
    const controller=new AbortController();
    running.add(controller);
    try {
      const ready=await resolveRequest(request,chosen.values,name=>context.secrets.get(secretKey(key,chosen.name,name)),{schema,
        readBodyFile:(file,limit)=>readWorkspaceBodyFile(folder.uri.fsPath,file,limit)});
      const proto=ready.method==='GRPC' ? await readProto(folder,ready.proto) : undefined;
      const assertFresh=()=>{
        const now=currentEnvironment(document,key);
        if (workspace(document).key!==key || document.version!==savedVersion || now.name!==chosen.name ||
            JSON.stringify(now.values)!==JSON.stringify(chosen.values)) {
          throw Error('The request document or environment changed. Review it again.');
        }
      };
      assertFresh();
      const bounded=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      if (ready.method==='WEBSOCKET') {
        const webSocket=await connections.connect(ready,{signal:bounded,owner:key,environment:chosen.name});
        return { environment:chosen.name,webSocket };
      }
      if (ready.method==='GRPC') return { environment:chosen.name,...await require('./grpc').sendGrpc(ready,proto,{signal:bounded}) };
      const cookieSession=ready.cookieJar&&cookies.session(key,chosen.name,ready.cookieJar,ready.url);
      const response=await sendRequest(ready,{signal:bounded,cookieSession,beforeAuthenticatedRequest:assertFresh});
      return { environment:chosen.name,...response };
    } finally {
      running.delete(controller);
    }
  }
  function renderTranscript(session) {
    transcript.clear();
    transcript.appendLine('WebSocket '+session.state+' · '+session.endpoint+' · '+session.environment);
    if (session.protocol) transcript.appendLine('Subprotocol '+session.protocol);
    if (session.closeCode!==undefined) transcript.appendLine('Close '+session.closeCode+(session.closeReason?' · '+session.closeReason:''));
    if (session.error) transcript.appendLine(session.error);
    if (session.dropped) transcript.appendLine(session.dropped+' earlier messages omitted.');
    for (const message of session.messages) {
      transcript.appendLine((message.direction==='in'?'Received ':'Sent ')+message.kind+' · '+message.size+' bytes');
      if (message.text!==null) transcript.appendLine(message.text+(message.truncated?'…':''));
    }
  }
  function showTranscript(session) {
    selectedSession=session.id;
    renderTranscript(session);
    transcript.show(true);
  }
  const webSocket = {
    list(document) { return connections.list(workspace(document).key); },
    get(document,id) { return connections.get(id,workspace(document).key); },
    send(document,id,text) { return connections.send(id,workspace(document).key,text); },
    close(document,id) { return connections.close(id,workspace(document).key); }
  };
  async function chooseConnection(document, title, openOnly) {
    const sessions=webSocket.list(document).filter(item=>!openOnly || item.state==='open');
    if (!sessions.length) throw Error(openOnly?'Open a WEBSOCKET request first.':'No WebSocket connections in this workspace.');
    const choices=sessions.map(session=>({label:session.endpoint,description:session.state+' · '+session.environment,
      detail:session.protocol || undefined,id:session.id}));
    return (await vscode.window.showQuickPick(choices,{title}))?.id;
  }
  async function showSessions() {
    const document=activeDocument();
    const id=await chooseConnection(document,'View WebSocket Transcript',false);
    if (id) showTranscript(webSocket.get(document,id));
  }
  async function sendMessage() {
    const document=activeDocument();
    const id=await chooseConnection(document,'Send WebSocket Message',true);
    if (!id) return;
    const text=await vscode.window.showInputBox({title:'Send WebSocket Text Message'});
    if (text!==undefined) showTranscript(await webSocket.send(document,id,text));
  }
  async function closeSocket() {
    const document=activeDocument();
    const id=await chooseConnection(document,'Close WebSocket Connection',true);
    if (id) showTranscript(webSocket.close(document,id));
  }
  async function runEditor(schema=false) {
    const editor=vscode.window.activeTextEditor;
    workspace(editor?.document);
    const response=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
      title:schema?'Inspecting GraphQL Schema':'Running API Request',cancellable:true},async(_,token)=>{
      const controller=new AbortController();
      const subscription=token.onCancellationRequested(()=>controller.abort());
      try {
        if (token.isCancellationRequested) controller.abort();
        return await run(editor.document,editor.document.offsetAt(editor.selection.active),{signal:controller.signal,schema});
      } finally {
        subscription.dispose();
      }
    });
    trust();
    if (response.webSocket) {
      showTranscript(response.webSocket);
      return response;
    }
    if (response.grpc) {
      output.clear();
      output.appendLine('gRPC '+response.grpc.method+' · '+response.grpc.mode+' · '+response.durationMs+' ms');
      output.appendLine(response.grpc.sent+' sent · '+response.grpc.received+' received');
      output.appendLine(response.body);
      output.show(true);
      return response;
    }
    const passed=response.assertions.filter(item=>item.passed).length;
    output.clear();
    if (response.graphql) {
      const kind=response.graphql.kind==='schema'?'GraphQL Schema':'GraphQL Operation';
      const state=response.graphql.graphqlResponse ? response.graphql.errors+' GraphQL errors'
        : response.truncated?'Response truncated':'No GraphQL response envelope';
      output.appendLine(kind+' · '+state);
    }
    output.appendLine('HTTP '+response.status+' · '+response.durationMs+' ms · '+response.environment);
    if (response.authenticated==='oauth-client-credentials') output.appendLine('OAuth client credentials');
    if (response.cookies) output.appendLine('Cookie jar '+response.cookies.name+' · sent '+response.cookies.sent+' · held '+response.cookies.retained);
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
  const subscriptions=[register(ids.run,runEditor),register(ids.environment,selectEnvironment),register(ids.secret,saveSecret),
    register(ids.schema,()=>runEditor(true)),register(ids.websocketSessions,showSessions),
    register(ids.websocketSend,sendMessage),register(ids.websocketClose,closeSocket)];
  return {run,storeSecret,webSocket,dispose(){
    if(disposed)return;
    disposed=true;
    for (const controller of running) controller.abort();
    connections.dispose();
    cookies.dispose();
    clearTimeout(renderTimer);
    for (const subscription of subscriptions) subscription.dispose();
    output.dispose();
    transcript.dispose();
  }};
}

module.exports = { registerHttpTools };
