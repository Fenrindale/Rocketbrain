'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const { waitForOwnedListener } = require('./testing-debug');
const { fail, cancelled } = require('./workbench-model');

const privateAddress = /^Debugger listening on (ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const inspectorArgs = ['--inspect-brk=127.0.0.1:0','--inspect-publish-uid=stderr','--no-global-search-paths'];

function nodeExecutable(home) {
  if (typeof home!=='string' || !path.isAbsolute(home)) throw fail('Set an absolute standalone Node.js home for Kotlin/JS debugging.');
  const root=fs.realpathSync(home);
  const program=process.platform==='win32'?'node.exe':'node';
  const found=[path.join(root,program),path.join(root,'bin',program)].filter(file=>fs.existsSync(file));
  if (found.length!==1 || path.relative(found[0],fs.realpathSync(found[0])) ||
      !fs.lstatSync(found[0]).isFile()) throw fail('Choose a physical standalone Node.js executable.');
  return found[0];
}

async function checkInspectorOwner(pid,port,cancellation,probe=waitForOwnedListener) {
  if (!Number.isInteger(pid) || pid<1 || !Number.isInteger(port) || port<1 || port>65535 || cancelled(cancellation)) {
    throw fail('The Kotlin/JS inspector target is unavailable or cancelled.');
  }
  const proved=await probe({pid,port,cancellation,timeoutMs:6000});
  if (cancelled(cancellation) || proved?.pid!==pid || proved.port!==port ||
      proved.address!=='127.0.0.1' || proved.verified!==true) {
    throw fail('The Kotlin/JS inspector did not belong to the owned local Node.js process.');
  }
}

class InspectorConnection extends EventEmitter {
  constructor(address) {
    super();
    this.socket=new WebSocket(address,{handshakeTimeout:5000,maxPayload:18*1024*1024,perMessageDeflate:false});
    this.pending=new Map();
    this.sequence=0;
    this.socket.once('error',()=>this.closed());
    this.socket.once('close',()=>this.closed());
    this.socket.on('message',bytes=>this.receive(bytes));
  }

  async opened() {
    if (this.socket.readyState===WebSocket.OPEN) return;
    await new Promise((resolve,reject)=>{
      const connected=()=>{this.off('ended',failed);resolve();};
      const failed=()=>{
        this.socket.off('open',connected);
        reject(fail('Could not connect to the owned Kotlin/JS inspector.'));
      };
      this.socket.once('open',connected);
      this.once('ended',failed);
      if(this.socket.readyState>WebSocket.OPEN) failed();
    });
  }

  receive(bytes) {
    let message;
    try { message=JSON.parse(bytes.toString('utf8')); }
    catch { this.close(); return; }
    const call=this.pending.get(message.id);
    if (call) {
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(fail('The Node.js inspector refused '+call.method+'.'));
      else call.resolve(message.result ?? {});
    } else if (typeof message.method==='string') this.emit(message.method,message.params ?? {});
  }

  request(method,params={}) {
    if (this.pending.size>=32 || this.socket.readyState!==WebSocket.OPEN) {
      return Promise.reject(fail('The owned Kotlin/JS inspector is unavailable.'));
    }
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{
        this.pending.delete(id);
        reject(fail('Node.js did not respond to '+method+'.'));
      },8000);
      this.pending.set(id,{resolve,reject,method,timer});
      this.socket.send(JSON.stringify({id,method,params}),error=>{if(error)this.closed();});
    });
  }

  closed() {
    if(this.ended)return;
    this.ended=true;
    for(const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(fail('The owned Kotlin/JS inspector closed.'));
    }
    this.pending.clear();
    this.emit('ended');
  }

  close() { this.socket.terminate(); this.closed(); }
}

async function runKotlinJsInspector({node,stage,cancellation,onOutput=()=>{},probe}) {
  if (cancelled(cancellation)) throw fail('Kotlin/JS debugging was cancelled.');
  const env={...process.env};
  for(const key of Object.keys(env)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|NODE_V8_COVERAGE|NODE_COMPILE_CACHE|NODE_DEBUG|NODE_DEBUG_NATIVE)$/iu.test(key)) delete env[key];
  }
  const child=spawn(node,[...inspectorArgs,stage.entry],{cwd:stage.directory,env,windowsHide:true,
    stdio:['ignore','pipe','pipe']});
  let endpoint,error,closed,connection,stopping,finished=false;
  const done=new Promise(resolve=>child.once('close',(code,signal)=>{
    finished=true;
    connection?.close();
    resolve({code,signal});
  }));
  child.once('error',cause=>{error=cause;});
  child.stdout.setEncoding('utf8').on('data',text=>onOutput('stdout',text));
  let tail='';
  const decoder=new StringDecoder('utf8');
  child.stderr.on('data',bytes=>{
    tail+=decoder.write(bytes);
    const lines=tail.split('\n');
    tail=lines.pop();
    if(tail.length>16384)tail=tail.slice(-16384);
    for(let line of lines) {
      line=line.trimEnd();
      const found=privateAddress.exec(line);
      if (found) {
        if (endpoint && endpoint.address!==found[1]) error=fail('The Node.js process reported another inspector endpoint.');
        else endpoint={address:found[1],port:Number(found[2])};
      } else if (/^Waiting for the debugger to disconnect\.\.\.$/u.test(line)) connection?.close();
      else if (!/^(?:Debugger attached\.|For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector)$/u.test(line)) {
        onOutput('stderr',line+'\n');
      }
    }
  });
  async function waitForClose(milliseconds) {
    const timer=new AbortController();
    try { return await Promise.race([done.then(()=>true),delay(milliseconds,false,{signal:timer.signal})]); }
    finally { timer.abort(); }
  }
  function stop() {
    stopping ||= (async()=>{
      if (!finished) {
        // Detaching a live inspector can let suspended application code run again.
        child.kill('SIGKILL');
        if (!await waitForClose(5000)) throw fail('The owned Kotlin/JS Node.js process did not stop.');
      }
      connection?.close();
      await stage.remove();
    })().catch(cause=>{stopping=undefined;throw cause;});
    return stopping;
  }
  try {
    const deadline=Date.now()+10000;
    while(!endpoint && !finished && !error && !cancelled(cancellation) && Date.now()<deadline) await delay(70);
    if (cancelled(cancellation)) throw fail('Kotlin/JS debugging was cancelled.');
    if (!endpoint || error || finished) throw fail('Node.js did not expose the owned Kotlin/JS inspector. Use a supported standalone Node.js runtime.');
    await checkInspectorOwner(child.pid,endpoint.port,cancellation,probe);
    if (finished || error) throw fail('The owned Kotlin/JS Node.js process changed before connecting.');
    connection=new InspectorConnection(endpoint.address);
    await connection.opened();
    await checkInspectorOwner(child.pid,endpoint.port,cancellation,probe);
    if (finished || error) throw fail('The owned Kotlin/JS Node.js process stopped during connection.');
    return { connection,pid:child.pid,port:endpoint.port,done,stop };
  } catch(cause) {
    await stop();
    throw cause;
  }
}

module.exports = { nodeExecutable, runKotlinJsInspector, checkInspectorOwner };
