'use strict';

const {spawn} = require('node:child_process');
const {fileURLToPath,pathToFileURL} = require('node:url');
const {setTimeout:pause} = require('node:timers/promises');
const path = require('node:path');
const fs = require('node:fs/promises');
const {boundedMessages} = require('../devcontainer/java-lsp');
const {angularSource,angularEnvironment} = require('./angular-project');

const maximum = 512*1024;
const text = value=>String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu,'');
const connectionInfo=project=>({uri:pathToFileURL(project.root).href,name:path.basename(project.root)});

function validRange(range, source) {
  if (typeof source!=='string'||source.length>maximum) return false;
  const lines=source.split(/\r\n|\r|\n/u);
  const legal=point=>Number.isInteger(point?.line)&&point.line>=0&&point.line<lines.length&&
    Number.isInteger(point.character)&&point.character>=0&&point.character<=lines[point.line].length;
  return legal(range?.start)&&legal(range?.end)&&(range.start.line<range.end.line||
    range.start.line===range.end.line&&range.start.character<=range.end.character);
}

async function definitionsOf(values,project,open) {
  const candidates=Array.isArray(values)?values.slice(0,32):[values];
  const targets=[];
  for (const item of candidates) {
    if (!item) continue;
    const candidate=item.targetUri||item.uri, range=item.targetSelectionRange||item.range;
    try {
      const file=await angularSource(project.root,fileURLToPath(candidate));
      if (!file) continue;
      const content=open.get(pathToFileURL(file).href)?.text ??
        ((await fs.stat(file)).size<=maximum?await fs.readFile(file,'utf8'):undefined);
      if (!validRange(range,content)) continue;
      targets.push({file,range});
    } catch { /* Angular can return a package, virtual file, or discarded location. */ }
  }
  return targets;
}

function hoverText(reply) {
  const content=Array.isArray(reply?.contents)?reply.contents.slice(0,8):[reply?.contents];
  return text(content.map(item=>typeof item==='string'?item:typeof item?.value==='string'?item.value:'')
    .filter(Boolean).join('\n\n')).slice(0,12000);
}

function startAngularSession(project,protocol,{onExit=()=>{}}={}) {
  const root=connectionInfo(project);
  const args=['--max-old-space-size=768',project.server,'--stdio','--clientProcessId='+process.pid,
    '--ngProbeLocations',project.root,'--tsProbeLocations',project.root,'--angularCoreVersion',project.version,
    '--includeCompletionsForModuleExports','false'];
  const child=spawn(project.node,args,{cwd:project.root,env:angularEnvironment(),shell:false,
    stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stderr.resume();
  const input=boundedMessages('Angular');
  const connection=protocol.createProtocolConnection(new protocol.StreamMessageReader(input),new protocol.StreamMessageWriter(child.stdin));
  const open=new Map(), pending=new Set();
  let closed=false, stopping, failure, exited=false;
  const exit=new Promise(resolve=>child.once('close',(code,signal)=>{exited=true;resolve({code,signal});}));

  function fail(message,kill=true) {
    if (closed) return;
    closed=true;
    failure=Error(message);
    for (const controller of pending)controller.cancel();
    pending.clear();
    open.clear();
    connection.dispose();
    child.stdout.unpipe(input);
    input.destroy();
    child.stdin.destroy();
    if (kill&&!exited) child.kill();
    onExit(failure);
  }

  child.once('close',()=>fail('The Angular language server stopped.',false));
  child.on('error',()=>fail('Could not start the reviewed Angular language server.'));
  for (const stream of [input,child.stdin,child.stdout]) stream.on('error',()=>fail('The Angular language server transport failed.'));
  connection.onClose(()=>fail('The Angular language server connection closed.'));
  connection.onError(()=>fail('The Angular language server protocol failed.'));
  child.stdout.pipe(input);
  connection.onRequest('workspace/applyEdit',()=>({applied:false,failureReason:'Angular template analysis is read-only.'}));
  connection.onRequest('workspace/configuration',params=>(Array.isArray(params?.items)?params.items.slice(0,32):[]).map(()=>null));
  connection.onRequest('workspace/workspaceFolders',()=>[root]);
  connection.onRequest('client/registerCapability',()=>null);
  connection.onRequest('client/unregisterCapability',()=>null);
  connection.onRequest('window/workDoneProgress/create',()=>null);
  connection.onRequest('window/showMessageRequest',()=>null);
  connection.listen();

  async function request(method,params,timeout=12000,cancellation) {
    if (closed) throw failure;
    if (pending.size>=20) throw Error('Finish current Angular analysis requests first.');
    if (cancellation?.isCancellationRequested||cancellation?.aborted) throw Error('Angular analysis cancelled.');
    const controller=new protocol.CancellationTokenSource();
    pending.add(controller);
    let timer, interrupt;
    const interrupted=new Promise((_,reject)=>{interrupt=reject;});
    const cancel=()=>{controller.cancel();interrupt(Error('Angular analysis cancelled.'));};
    const subscription=cancellation?.onCancellationRequested?.(cancel);
    cancellation?.addEventListener?.('abort',cancel,{once:true});
    try {
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
        controller.cancel();reject(Error('The Angular language server did not answer in time.'));
      },timeout);});
      return await Promise.race([connection.sendRequest(method,params,controller.token),deadline,interrupted]);
    } finally {
      clearTimeout(timer);
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort',cancel);
      pending.delete(controller);
      controller.dispose();
    }
  }
  const ready=(async()=>{
    const result=await request('initialize',{processId:process.pid,rootUri:root.uri,workspaceFolders:[root],
      clientInfo:{name:'Rocketbrain Angular'},capabilities:{workspace:{workspaceFolders:true,configuration:true},
        textDocument:{definition:{linkSupport:true},hover:{contentFormat:['plaintext','markdown']}},
        general:{positionEncodings:['utf-16']}}},15000);
    if (result.capabilities?.positionEncoding&&!['utf-16','utf16'].includes(result.capabilities.positionEncoding)||
        !result.capabilities?.definitionProvider||!result.capabilities?.hoverProvider) {
      throw Error('The Angular server did not negotiate the supported template capabilities.');
    }
    await connection.sendNotification('initialized',{});
    return result.capabilities;
  })();
  ready.catch(()=>fail('The reviewed Angular language server did not initialize.'));

  async function synchronize(snapshot) {
    await ready;
    if (closed) throw failure;
    const file=await angularSource(project.root,snapshot.file);
    if (!file||!Number.isSafeInteger(snapshot.version)||snapshot.version<0||typeof snapshot.text!=='string'||
        snapshot.text.includes('\0')||Buffer.byteLength(snapshot.text)>maximum) {
      throw Error('Choose a bounded Angular source editor in the reviewed project.');
    }
    const uri=pathToFileURL(file).href;
    const previous=open.get(uri);
    if (previous&&snapshot.version<previous.version) throw Error('The Angular editor revision changed.');
    if (!previous&&open.size>=48) throw Error('Close unused Angular editors before analyzing more files.');
    if (!previous) {
      open.set(uri,snapshot);
      await connection.sendNotification('textDocument/didOpen',{
        textDocument:{uri,languageId:file.toLowerCase().endsWith('.html')?'html':'typescript',version:snapshot.version,text:snapshot.text}
      });
    } else if (snapshot.version!==previous.version||snapshot.text!==previous.text) {
      open.set(uri,snapshot);
      await connection.sendNotification('textDocument/didChange',{textDocument:{uri,version:snapshot.version},
        contentChanges:[{text:snapshot.text}]});
    }
    return uri;
  }

  async function lookup(method,snapshot,position,cancellation) {
    if (!validRange({start:position,end:position},snapshot.text)) return;
    const uri=await synchronize(snapshot);
    const response=await request('textDocument/'+method,{textDocument:{uri},position},12000,cancellation);
    const latest=open.get(uri);
    if (latest?.version!==snapshot.version||latest.text!==snapshot.text) return;
    return method==='definition'?definitionsOf(response,project,open):hoverText(response);
  }

  return {
    ready,pid:child.pid,synchronize,
    definition:(snapshot,position,cancellation)=>lookup('definition',snapshot,position,cancellation),
    hover:(snapshot,position,cancellation)=>lookup('hover',snapshot,position,cancellation),
    async close(file) {
      if (closed) return;
      const uri=pathToFileURL(file).href;
      if (open.delete(uri)) await connection.sendNotification('textDocument/didClose',{textDocument:{uri}});
    },
    stop() {
      if (!stopping) stopping=(async()=>{
        if (!closed) {
          try {await request('shutdown',null,1700);await connection.sendNotification('exit');}
          catch { /* Ending the owned process below also releases the transport. */ }
          finally {fail('The Angular analysis session ended.');}
        }
        return Promise.race([exit.then(()=>true),pause(3500,false,{ref:false})]);
      })();
      return stopping;
    }
  };
}

module.exports = {startAngularSession, validRange, definitionsOf};
