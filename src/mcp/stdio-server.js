'use strict';

const { isObject }=require('./workspace-tools');

const modern='2026-07-28';
const legacy=['2025-11-25','2025-06-18'];
const supported=[modern,...legacy];
const versionKey='io.modelcontextprotocol/protocolVersion';
const clientInfoKey='io.modelcontextprotocol/clientInfo';
const capabilitiesKey='io.modelcontextprotocol/clientCapabilities';
const serverInfoKey='io.modelcontextprotocol/serverInfo';
const maxFrame=256*1024;
const maxResponse=512*1024;
const maxQueue=1024*1024;
const maxActive=4;
const toolDeadline=30000;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const validId=value=>Number.isSafeInteger(value) || typeof value==='string' && value.length<=128;
const hasOwn=(object,key)=>Object.hasOwn(object,key);
const instructions='Read-only Rocketbrain tools for one locally approved workspace. Tools are selected when the server starts.';
const capabilities={tools:{}};

function validImplementation(value) {
  return isObject(value) && typeof value.name==='string' && value.name.length>0 && value.name.length<=128 &&
    typeof value.version==='string' && value.version.length>0 && value.version.length<=128;
}

function stdioServer(input,output,registry,{version}) {
  const serverInfo={name:'rocketbrain',version};
  const active=new Map();
  let era,waitingForInitialized=false,closed=false;
  let parts=[],length=0,discarding=false;

  return new Promise((resolve,reject)=>{
    function close(error) {
      if (closed) return;
      closed=true;
      input.off('data',onData);
      input.off('end',close);
      input.off('error',close);
      output.off('drain',resume);
      input.pause();
      for (const request of active.values()) request.controller.abort();
      active.clear();
      parts=[];
      if (error && error.code!=='EPIPE') reject(error);
      else resolve();
    }

    function resume() { if (!closed) input.resume(); }

    function send(id,body) {
      if (closed) return;
      const json=JSON.stringify({jsonrpc:'2.0',id,...body})+'\n';
      const bytes=Buffer.byteLength(json);
      if (bytes>maxResponse) {
        failure(id,-32603,'The MCP response exceeded the output limit.');
        return;
      }
      if (output.writableLength+bytes>maxQueue) {
        close(Error('MCP client stopped draining stdout.'));
        return;
      }
      if (!output.write(json,'utf8')) input.pause();
    }

    function failure(id,code,message,data) {
      send(id,{error:{code,message,...(data?{data}:{})}});
    }

    function succeed(id,result,modernRequest) {
      send(id,{result:modernRequest?{...result,resultType:'complete',_meta:{[serverInfoKey]:serverInfo}}:result});
    }

    function toolFailure(id,message,modernRequest) {
      succeed(id,{content:[{type:'text',text:message}],isError:true},modernRequest);
    }

    function notify(method,params) {
      if (method==='notifications/initialized' && era==='legacy') waitingForInitialized=false;
      if (method==='notifications/cancelled' && validId(params.requestId)) active.get(params.requestId)?.controller.abort();
    }

    function beginTool(id,params,modernRequest) {
      if (typeof params.name!=='string' || !registry.authorized(params.name)) {
        failure(id,-32602,'The requested tool is unavailable or not authorized.');
        return;
      }
      if (Object.keys(params).some(key=>!['name','arguments','_meta'].includes(key))) {
        failure(id,-32602,'Unsupported tool request parameters.');
        return;
      }
      let args;
      try { args=registry.validate(params.name,params.arguments); }
      catch (error) { failure(id,-32602,error.message);return; }
      if (active.size>=maxActive) { toolFailure(id,'The workspace already has four running tool calls.',modernRequest);return; }
      const controller=new AbortController();
      const request={controller,timedOut:false};
      const timer=setTimeout(()=>{request.timedOut=true;controller.abort();},toolDeadline);
      active.set(id,request);
      void Promise.resolve().then(()=>registry.invoke(params.name,args,controller.signal)).then(data=>{
        if (request.timedOut) toolFailure(id,'The tool exceeded its execution time limit.',modernRequest);
        else if (!controller.signal.aborted) {
          const text=JSON.stringify(data);
          succeed(id,{content:[{type:'text',text}],structuredContent:data,isError:false},modernRequest);
        }
      },()=>{
        if (request.timedOut) toolFailure(id,'The tool exceeded its execution time limit.',modernRequest);
        else if (!controller.signal.aborted) toolFailure(id,'The tool could not read or analyze the approved workspace scope.',modernRequest);
      }).finally(()=>{clearTimeout(timer);active.delete(id);});
    }

    function handle(message) {
      if (!isObject(message) || message.jsonrpc!=='2.0' || typeof message.method!=='string' ||
          hasOwn(message,'id') && !validId(message.id)) {
        failure(null,-32600,'Invalid MCP JSON-RPC message.');
        return;
      }
      const {id,method,params={}}=message;
      if (!isObject(params) || hasOwn(params,'_meta') && !isObject(params._meta)) {
        if (id!==undefined) failure(id,-32602,'Invalid MCP parameters.');
        return;
      }
      if (id===undefined) { notify(method,params);return; }
      if (active.has(id)) { failure(id,-32600,'A request with this id is already running.');return; }
      if (method==='initialize') {
        if (era) { failure(id,-32600,'This MCP process has already selected its protocol era.');return; }
        if (!validImplementation(params.clientInfo) || !isObject(params.capabilities) ||
            typeof params.protocolVersion!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)) {
          failure(id,-32602,'Invalid MCP initialize parameters.');
          return;
        }
        era='legacy';
        waitingForInitialized=true;
        succeed(id,{protocolVersion:legacy.includes(params.protocolVersion)?params.protocolVersion:legacy[0],
          capabilities,serverInfo,instructions},false);
        return;
      }
      const metadata=params._meta ?? {}, requested=metadata[versionKey];
      const modernRequest=method==='server/discover' || requested!==undefined || era==='modern';
      if (modernRequest) {
        if (era==='legacy') { failure(id,-32600,'Use the initialized MCP protocol for this process.');return; }
        if (typeof requested!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(requested) ||
            hasOwn(metadata,clientInfoKey) && !validImplementation(metadata[clientInfoKey]) ||
            hasOwn(metadata,capabilitiesKey) && !isObject(metadata[capabilitiesKey])) {
          failure(id,-32602,'Invalid MCP protocol metadata.');
          return;
        }
        if (requested!==modern) {
          failure(id,-32022,'Unsupported protocol version',{supported,requested});
          return;
        }
        if (method==='server/discover') {
          succeed(id,{supportedVersions:supported,capabilities,instructions,ttlMs:0,cacheScope:'private'},true);
          return;
        }
        era='modern';
      } else if (method==='ping') { succeed(id,{},false);return; }
      else if (!era || waitingForInitialized) { failure(id,-32600,'Initialize MCP before using tools.');return; }
      if (method==='tools/list') {
        if (hasOwn(params,'cursor')) { failure(id,-32602,'This tool list has no additional page.');return; }
        succeed(id,{tools:registry.tools,...(modernRequest?{ttlMs:0,cacheScope:'private'}:{})},modernRequest);
      } else if (method==='tools/call') beginTool(id,params,modernRequest);
      else failure(id,-32601,'MCP method not found.');
    }

    function onData(chunk) {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      let start=0;
      while (start<bytes.length && !closed) {
        const next=bytes.indexOf(10,start), end=next===-1?bytes.length:next;
        const segment=bytes.subarray(start,end);
        if (!discarding && length+segment.length<=maxFrame) {
          if (segment.length) parts.push(segment);
          length+=segment.length;
        } else { discarding=true;parts=[];length=0; }
        if (next===-1) return;
        if (discarding) failure(null,-32700,'The MCP message exceeded the input limit.');
        else {
          let decoded;
          try { decoded=JSON.parse(decoder.decode(Buffer.concat(parts,length))); }
          catch { failure(null,-32700,'Invalid MCP JSON message.'); }
          if (decoded!==undefined) handle(decoded);
        }
        discarding=false;
        parts=[];
        length=0;
        start=next+1;
      }
    }

    input.on('data',onData);
    input.once('end',close);
    input.once('error',close);
    output.on('drain',resume);
    output.on('error',close);
  });
}

module.exports={stdioServer};
