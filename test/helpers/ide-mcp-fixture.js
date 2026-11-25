'use strict';

const { spawn }=require('node:child_process');
const { createInterface }=require('node:readline');
const { once }=require('node:events');
const { setTimeout:delay }=require('node:timers/promises');

const legacy='2025-11-25',modern='2026-07-28';
const clientInfo={name:'rocketbrain-stdio-fixture',version:'1.0.0'};
const meta={'io.modelcontextprotocol/protocolVersion':modern,'io.modelcontextprotocol/clientInfo':clientInfo,
  'io.modelcontextprotocol/clientCapabilities':{}};

function openMcp(node,cli,workspace,tools,{dbScope,password}={}) {
  const env={...process.env};
  delete env.ROCKETBRAIN_MCP_DB_PASSWORD;
  if(password!==undefined) env.ROCKETBRAIN_MCP_DB_PASSWORD=password;
  const child=spawn(node,[cli,'--workspace',workspace,...tools.flatMap(name=>['--allow-tool',name]),...(dbScope?['--db-scope',dbScope]:[])],
    {windowsHide:true,stdio:['pipe','pipe','pipe'],env});
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  const received=[],waiters=new Map();
  let next=1,stderr='',malformed=null;
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8192);});
  child.stdin.on('error',error=>{malformed??=error;});
  lines.on('line',line=>{
    let frame;
    try { frame=JSON.parse(line); }
    catch (error) { malformed=error;return; }
    received.push(frame);
    const receive=waiters.get(frame.id);
    if (receive) { waiters.delete(frame.id);receive(frame); }
  });
  const exited=once(child,'close').then(([code])=>code);
  exited.catch(()=>{});
  const frame=(id,method,params)=>JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n';
  function write(text) { child.stdin.write(text,'utf8'); }
  function request(method,params={}) {
    const id=next++;
    const timeout=AbortSignal.timeout(20000);
    return new Promise((resolve,reject)=>{
      timeout.addEventListener('abort',()=>{waiters.delete(id);reject(Error('MCP fixture timed out: '+method));},{once:true});
      waiters.set(id,resolve);
      write(frame(id,method,params));
    });
  }
  async function initialize() {
    const reply=await request('initialize',{clientInfo,capabilities:{},protocolVersion:legacy});
    write(frame(undefined,'notifications/initialized',{}));
    return reply;
  }
  async function close() {
    child.stdin.end();
    const abort=new AbortController();
    try {
      const code=await Promise.race([exited,delay(4000,null,{signal:abort.signal})]);
      if (code===null && child.exitCode===null) { child.kill(); await exited; }
      return {code,stderr,malformed};
    } finally { abort.abort();lines.close(); }
  }
  return {request,initialize,write,frame,received,close,
    modern:(method,params={})=>request(method,{...params,_meta:meta})};
}

module.exports={openMcp,legacy,modern,meta};
