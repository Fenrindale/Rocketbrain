'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { digest } = require('./kmp-js-build');
const { fileKey } = require('./dependency-builds');
const { fail } = require('./workbench-model');

const nodeLocation = info => ({lineNumber:info.lineNumber,columnNumber:info.columnNumber});
const simpleName = /^[\w$]{1,120}$/u;
const sourceInfo = file => ({name:path.basename(file),path:file});
const sameSource = (origin,file,line) => origin && origin.line===line && fileKey(origin.file)===fileKey(file);

function probeScript(url, expected) {
  try {return fileKey(fileURLToPath(url))===fileKey(expected);}
  catch {return false;}
}

function insideFrame(frame, script) {
  return frame?.location?.scriptId===script?.scriptId;
}

function readableValue(value) {
  if (!value || typeof value.type!=='string') return undefined;
  const primitive = value.value;
  if (['object','function','symbol'].includes(value.type)) {
    return {value:value.subtype==='null'?'null':'['+(value.subtype||value.type)+']',type:value.subtype||value.type};
  }
  const text = typeof primitive==='string' ? JSON.stringify(primitive.slice(0,500)) :
    value.unserializableValue ?? String(primitive);
  return {value:text.slice(0,600),type:value.type};
}

function createKotlinJsDebugAdapter({run,stage,validate,send}) {
  const client=run.connection;
  const boundBreakpoints=new Map(), frames=new Map(), frameIds=new Map(), scopes=new Map();
  let sequence=0, handle=0, launched=false, ended=false, cleaned, script, startup, pause, step, queue=Promise.resolve();

  function event(name,body) {send({seq:++sequence,type:'event',event:name,body});}
  function reply(request,body,error) {
    send({seq:++sequence,type:'response',request_seq:request.seq,command:request.command,
      success:!error,body,message:error?.message});
  }
  function resetHandles() {frames.clear();frameIds.clear();scopes.clear();}
  function finish() {
    if (!ended) {
      ended=true;
      pause=undefined;
      resetHandles();
      if (launched) event('terminated');
    }
    cleaned ||= run.stop();
    return cleaned;
  }
  function valid() {
    if (ended) throw fail('The owned Kotlin/JS debug session ended.');
    try {validate();}
    catch(error) {
      void finish().catch(()=>{});
      throw error;
    }
  }

  client.on('Debugger.scriptParsed', details=>{
    if (probeScript(details.url,stage.entry)) {
      script=script ? {...details,duplicate:true} : details;
    }
  });
  client.on('Debugger.paused', details=>{
    if (ended) return;
    if (startup) {startup.resolve(details);return;}
    try {valid();} catch {return;}
    const top=details.callFrames?.[0];
    const stoppedAt=insideFrame(top,script) && stage.mapping.original(top.location.lineNumber,top.location.columnNumber);
    const known=[...boundBreakpoints.values()].flat().some(site=>details.hitBreakpoints?.includes(site.id) &&
      sameSource(stoppedAt,site.file,site.line));
    const nextLine=step && stoppedAt && !sameSource(stoppedAt,step.file,step.line);
    if (!known && !nextLine) {
      const advance=step && --step.remaining>0;
      if (!advance) step=undefined;
      void client.request(advance?'Debugger.stepOver':'Debugger.resume').catch(()=>finish()).catch(()=>{});
      return;
    }
    step=undefined;
    pause=details;
    resetHandles();
    event('stopped',{reason:known?'breakpoint':'step',threadId:1,allThreadsStopped:true});
  });
  client.once('ended',()=>{
    if (startup) startup.reject(fail('The Kotlin/JS inspector ended before the application could pause.'));
    // Stock Node waits for detach after the app completes. Give its pipes a chance to close.
    const timer=setTimeout(()=>{void finish().catch(()=>{});},1800);
    timer.unref?.();
    void run.done.then(()=>clearTimeout(timer));
  });
  void run.done.then(()=>finish()).catch(()=>{});

  async function launch() {
    valid();
    if (launched) throw fail('The Kotlin/JS session was already launched.');
    launched=true;
    let timer;
    const first=new Promise((resolve,reject)=>{
      startup={resolve,reject};
      timer=setTimeout(()=>reject(fail('Node.js did not pause before running the Kotlin application.')),10000);
    });
    // A CDP request can fail before the initial pause promise is awaited.
    void first.catch(()=>{});
    try {
      await client.request('Runtime.enable');
      await client.request('Debugger.enable');
      await client.request('Runtime.runIfWaitingForDebugger');
      const stopped=await first;
      if (!script || script.duplicate || script.sourceMapURL!==stage.mapName || !insideFrame(stopped.callFrames?.[0],script)) {
        throw fail('Node.js did not load the exact reviewed Kotlin/JS executable and source map.');
      }
      const loaded=await client.request('Debugger.getScriptSource',{scriptId:script.scriptId});
      if (typeof loaded.scriptSource!=='string' || digest(Buffer.from(loaded.scriptSource))!==stage.artifactSha256) {
        throw fail('The Kotlin/JS script loaded by Node.js differs from the reviewed build.');
      }
      valid();
      pause=stopped;
    } catch(error) {
      void finish().catch(()=>{});
      throw error;
    } finally {
      clearTimeout(timer);
      startup=undefined;
    }
  }

  async function setBreakpoints(args) {
    valid();
    const file=args.source?.path, requested=args.breakpoints ?? [];
    if (!Array.isArray(requested) || requested.length>40) throw fail('Set at most 40 Kotlin breakpoints per saved source file.');
    const unknown = item => ({verified:false,line:item.line,message:'No reviewed executable Kotlin position at this line.'});
    if (typeof file!=='string'||!path.isAbsolute(file)||!file.endsWith('.kt')) return {breakpoints:requested.map(unknown)};
    const key=fileKey(file), replacing=boundBreakpoints.get(key) ?? [];
    for (const site of replacing) await client.request('Debugger.removeBreakpoint',{breakpointId:site.id});
    boundBreakpoints.delete(key);
    const newSites=[];
    const results=[];
    try {
      for (const item of requested) {
        const line=item.line-1;
        if (!script || !Number.isInteger(item.line) || line<0 || args.sourceModified || item.condition ||
            item.hitCondition || item.logMessage) {
          results.push(unknown(item));
          continue;
        }
        const repeated=newSites.find(site=>site.line===line);
        if (repeated) {results.push({verified:true,line:item.line,source:sourceInfo(repeated.file)});continue;}
        const candidates=stage.mapping.generatedLines(file,line);
        let resolved;
        if (candidates.length<=30) for (const lineNumber of candidates) {
          const range={start:{scriptId:script.scriptId,lineNumber,columnNumber:0},
            end:{scriptId:script.scriptId,lineNumber:lineNumber+1,columnNumber:0}};
          const {locations}=await client.request('Debugger.getPossibleBreakpoints',range);
          const location=locations?.find(site=>site.scriptId===script.scriptId && site.lineNumber===lineNumber &&
            sameSource(stage.mapping.original(site.lineNumber,site.columnNumber),file,line));
          if (!location) continue;
          const installed=await client.request('Debugger.setBreakpoint',{location:{scriptId:script.scriptId,...nodeLocation(location)}});
          const actual=installed.actualLocation;
          resolved=insideFrame({location:actual},script)?stage.mapping.original(actual.lineNumber,actual.columnNumber):undefined;
          if (sameSource(resolved,file,line)) {
            newSites.push({id:installed.breakpointId,file:resolved.file,line});
            break;
          }
          await client.request('Debugger.removeBreakpoint',{breakpointId:installed.breakpointId});
          resolved=undefined;
        }
        results.push(resolved ? {verified:true,line:item.line,source:sourceInfo(resolved.file)} : unknown(item));
      }
      if (newSites.length) boundBreakpoints.set(key,newSites);
      return {breakpoints:results};
    } catch(error) {
      for (const site of newSites) {
        await client.request('Debugger.removeBreakpoint',{breakpointId:site.id}).catch(()=>{});
      }
      throw error;
    }
  }

  function stackTrace(args) {
    valid();
    const current=[];
    for(const frame of pause?.callFrames?.slice(0,40) ?? []) {
      if (!insideFrame(frame,script)) continue;
      const origin=stage.mapping.original(frame.location.lineNumber,frame.location.columnNumber);
      if (!origin) continue;
      const id=frameIds.get(frame.callFrameId) ?? ++handle;
      frameIds.set(frame.callFrameId,id);
      frames.set(id,frame);
      current.push({id,name:frame.functionName || 'Kotlin',line:origin.line+1,column:origin.column+1,
        source:sourceInfo(origin.file)});
    }
    const start=Math.max(Number.isInteger(args.startFrame)?args.startFrame:0,0);
    const count=Number.isInteger(args.levels)&&args.levels>0?args.levels:current.length;
    return {stackFrames:current.slice(start,start+count),totalFrames:current.length};
  }

  function listScopes(args) {
    valid();
    const current=[];
    const frame=frames.get(args.frameId);
    for (const scope of frame?.scopeChain?.slice(0,20) ?? []) {
      if (!['local','block'].includes(scope.type) || typeof scope.object?.objectId!=='string') continue;
      const existing=[...scopes].find(([,objectId])=>objectId===scope.object.objectId);
      if (scopes.size>=80) break;
      const id=existing?.[0] ?? ++handle;
      scopes.set(id,scope.object.objectId);
      current.push({name:scope.type==='local'?'Locals':'Block',variablesReference:id,expensive:false,
        presentationHint:'locals'});
    }
    return {scopes:current};
  }

  async function variables(args) {
    valid();
    const objectId=scopes.get(args.variablesReference);
    if (!objectId || !pause) return {variables:[]};
    const inspected=await client.request('Runtime.getProperties',{objectId,ownProperties:true,generatePreview:false});
    const values=[];
    for (const item of inspected.result?.slice(0,300) ?? []) {
      if (item.get || item.set || !simpleName.test(item.name)) continue;
      const value=readableValue(item.value);
      if (value) values.push({name:item.name,...value,variablesReference:0});
    }
    return {variables:values};
  }

  async function resume(method='Debugger.resume') {
    valid();
    if (!pause) return;
    step=undefined;
    if (method==='Debugger.stepOver') {
      const top=pause.callFrames?.[0];
      const source=insideFrame(top,script) && stage.mapping.original(top.location.lineNumber,top.location.columnNumber);
      if (!source) throw fail('Step from a reviewed Kotlin source line.');
      step={...source,remaining:40};
    }
    pause=undefined;
    resetHandles();
    event('continued',{threadId:1,allThreadsContinued:true});
    try {await client.request(method);}
    catch(error) {void finish().catch(()=>{});throw error;}
  }

  async function dispatch(request) {
    const args=request.arguments ?? {};
    switch(request.command) {
      case 'initialize': return {supportsConfigurationDoneRequest:true,supportsTerminateRequest:true};
      case 'launch': return launch();
      case 'configurationDone':
      case 'continue': await resume(); return {allThreadsContinued:true};
      case 'next': return resume('Debugger.stepOver');
      case 'threads': return {threads:ended?[]:[{id:1,name:'Kotlin/JS Node'}]};
      case 'setBreakpoints': return setBreakpoints(args);
      case 'setExceptionBreakpoints': return {breakpoints:[]};
      case 'stackTrace': return stackTrace(args);
      case 'scopes': return listScopes(args);
      case 'variables': return variables(args);
      case 'terminate':
      case 'disconnect': return finish();
      default: throw fail('This operation is unavailable for the reviewed Kotlin/JS debug session.');
    }
  }

  return {
    handleMessage(request) {
      if (request?.type!=='request') return;
      queue=queue.then(async()=>{
        try {
          const body=await dispatch(request);
          reply(request,body);
          if(request.command==='launch') event('initialized');
        } catch(error) {reply(request,undefined,error);}
      });
    },
    output(category,output) {if(!ended) event('output',{category,output});},
    dispose() {void finish().catch(()=>{});}
  };
}

module.exports = { createKotlinJsDebugAdapter };
