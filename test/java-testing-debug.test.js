'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{spawn}=require('node:child_process');
const {createTestDebugger,waitForOwnedListener,allocatePort,MARKER}=require('../src/java/testing-debug');

function fixture({trusted=true,start=false,probe}={}){
  const roots=path.resolve('test/fixtures/spring-boot-app'),starts=[],stops=[],trackers=[],sessions=[],handlers={start:new Set(),end:new Set()};
  const event=(set,fn)=>{set.add(fn);return {dispose:()=>set.delete(fn)};};
  const fire=(set,value)=>{for(const fn of set)fn(value);};
  const vscode={Uri:{file:fsPath=>({fsPath})},workspace:{isTrusted:trusted,getWorkspaceFolder:()=>({uri:{fsPath:roots}})},debug:{
    onDidStartDebugSession:fn=>event(handlers.start,fn),onDidTerminateDebugSession:fn=>event(handlers.end,fn),
    registerDebugAdapterTrackerFactory:(type,value)=>{trackers.push(value);return {dispose(){const index=trackers.indexOf(value);if(index>=0)trackers.splice(index,1);}};},
    async startDebugging(folder,config){starts.push(config);if(start===false)return false;const session={id:'session-'+sessions.length,type:'rocketbrain-java',configuration:config};sessions.push(session);session.trackers=trackers.map(value=>value.createDebugAdapterTracker(session)).filter(Boolean);fire(handlers.start,session);return true;},
    async stopDebugging(session){stops.push(session.id);for(const tracker of session.trackers||[])tracker.onWillReceiveMessage?.({type:'request',command:'disconnect'});for(const tracker of session.trackers||[])tracker.onDidSendMessage?.({type:'event',event:'terminated'});fire(handlers.end,session);}
  }};
  const engine={start:async()=>{},getState:()=>({debugBundlePath:'independent-debug.jar'})};
  const helper=createTestDebugger(vscode,{java:engine,portAllocator:async()=>32145,ownershipProbe:probe|| (async value=>({...value,verified:true})),attachTimeoutMs:1000,cleanupTimeoutMs:50});
  const project={workspace:roots,label:'fixture',sourceRoots:[path.join(roots,'src/test/java')]};
  const naturalExit=()=>{const session=sessions.at(-1);for(const tracker of session.trackers)tracker.onDidSendMessage?.({type:'event',event:'exited',body:{exitCode:0}});for(const tracker of session.trackers)tracker.onDidSendMessage?.({type:'event',event:'terminated'});fire(handlers.end,session);};
  return {helper,vscode,project,starts,stops,sessions,trackers,handlers,naturalExit};
}

test('test debugger refuses untrusted workspaces and combined debug/coverage before starting a child',async()=>{
  let called=0;const f=fixture({trusted:false,start:true}),backend={runTests:async()=>{called++;}};
  try{await assert.rejects(()=>f.helper.runTests(f.project,{},backend),error=>error.code==='UNTRUSTED_WORKSPACE');f.vscode.workspace.isTrusted=true;await assert.rejects(()=>f.helper.runTests(f.project,{coverage:true},backend),error=>error.code==='SEPARATE_PROFILE');assert.equal(called,0);assert.equal(f.starts.length,0);}finally{await f.helper.dispose();}
});
test('test debug attach requires the managed listener PID and never trusts application output',async()=>{
  const f=fixture({start:true,probe:async value=>({...value,pid:value.pid+1,verified:true})});
  const backend={runTests:async(project,options)=>{await options.debug.onStarted({pid:42,port:options.debug.port});return {state:'completed'};}};
  try{await assert.rejects(()=>f.helper.runTests(f.project,{},backend),error=>error.code==='FOREIGN_LISTENER');assert.equal(f.starts.length,0);assert.equal(f.stops.length,0);}finally{await f.helper.dispose();}
});
test('natural test JVM completion stays completed and closes only the exactly marked session',async()=>{
  const f=fixture({start:true});let cancelled=false;
  const unrelated={id:'unrelated',type:'rocketbrain-java',configuration:{[MARKER]:'another-run'}};
  const backend={runTests:async(project,options)=>{options.cancellation.addEventListener('abort',()=>{cancelled=true;});await options.debug.onStarted({pid:42,port:options.debug.port});assert.equal(options.debug.port,32145);assert.equal(f.starts[0].request,'attach');assert.equal(f.starts[0].hostName,'127.0.0.1');f.naturalExit();return {state:'completed',summary:{testsSucceeded:1}};}};
  try{for(const value of f.handlers.start)value(unrelated);const result=await f.helper.runTests(f.project,{onOutput:()=>{throw new Error('Application stdout must not control attachment');}},backend);assert.equal(result.state,'completed');assert.equal(result.debug.attached,true);assert.equal(result.debug.listenerOwnershipVerified,true);assert.equal(result.debug.sessionStopped,true);assert.equal(result.debug.applicationOutputUsedForControl,false);assert.equal(cancelled,false);assert.ok(f.stops.every(id=>id==='session-0'));assert.equal(f.trackers.length,0);}finally{await f.helper.dispose();}
});
test('stopping a test debug session cancels the owned test run without reporting a passing test',async()=>{
  const f=fixture({start:true});
  const backend={runTests:async(project,options)=>{await options.debug.onStarted({pid:42,port:options.debug.port});await f.vscode.debug.stopDebugging(f.sessions[0]);assert.equal(options.cancellation.aborted,true);return {state:'cancelled',summary:{testsAborted:1,testsSucceeded:0}};}};
  try{const result=await f.helper.runTests(f.project,{},backend);assert.equal(result.state,'cancelled');assert.equal(result.debug.userStopped,true);assert.equal(result.debug.sessionStopped,true);assert.equal(result.summary.testsSucceeded,0);}finally{await f.helper.dispose();}
});
test('disposing an attached active operation waits for managed runner cleanup',async()=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=fixture({start:true});
  const backend={runTests:async(project,options)=>{await options.debug.onStarted({pid:42,port:options.debug.port});entered();return new Promise(resolve=>{release=()=>resolve({state:'cancelled',summary:{}});});}};
  const work=f.helper.runTests(f.project,{},backend);await ready;let done=false;const closing=f.helper.dispose().then(()=>{done=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);release();await closing;assert.equal((await work).state,'cancelled');assert.ok(f.stops.every(id=>id==='session-0'));
});
for(const mode of ['cancellation','disposal'])test(mode+' during a delayed attach awaits the owned late session termination',async()=>{
  const f=fixture({start:true}),abort=new AbortController();let release,entered,childCleaned=false;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),start=f.vscode.debug.startDebugging;
  f.vscode.debug.startDebugging=async(...args)=>{entered();await gate;return start(...args);};
  const backend={runTests:async(project,options)=>{try{await options.debug.onStarted({pid:42,port:options.debug.port});throw Error('Cancelled startup must not continue the test runner.');}catch(error){childCleaned=true;throw error;}}};
  let returned=false;const work=f.helper.runTests(f.project,{cancellation:abort.signal},backend);void work.finally(()=>{returned=true;}).catch(()=>{});await ready;
  let closing;if(mode==='disposal')closing=f.helper.dispose();else abort.abort();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(childCleaned,true,'Backend has awaited its managed child cleanup');assert.equal(returned,false,'Do not return while VS Code can still publish an owned late session');
  for(const listener of f.handlers.start)listener({id:'unrelated',type:'rocketbrain-java',configuration:{[MARKER]:'another-run'}});
  release();const result=await work;if(closing)await closing;assert.equal(result.state,'cancelled');assert.equal(result.debug.sessionStopped,true);assert.equal(f.sessions.length,1);assert.ok(f.stops.length>0);assert.ok(f.stops.every(id=>id==='session-0'));assert.equal(f.trackers.length,0);await f.helper.dispose();
});
test('an attach failure remains a failure rather than a cancelled or passing test',async()=>{
  const f=fixture({start:false});let childCleaned=false;
  const backend={runTests:async(project,options)=>{try{await options.debug.onStarted({pid:42,port:options.debug.port});return {state:'completed'};}catch(error){childCleaned=true;throw error;}}};
  try{await assert.rejects(()=>f.helper.runTests(f.project,{},backend),error=>error.code==='ATTACH_FAILED');assert.equal(childCleaned,true);assert.equal(f.trackers.length,0);}finally{await f.helper.dispose();}
});
test('a stuck own-session stop request fails bounded cleanup instead of claiming successful teardown',async()=>{
  const f=fixture({start:true});f.vscode.debug.stopDebugging=session=>{f.stops.push(session.id);return new Promise(()=>{});};
  const backend={runTests:async(project,options)=>{await options.debug.onStarted({pid:42,port:options.debug.port});return {state:'completed',summary:{testsSucceeded:1}};}};
  try{await assert.rejects(()=>f.helper.runTests(f.project,{},backend),error=>error.code==='DEBUG_CLEANUP_TIMEOUT');assert.deepEqual(f.stops,['session-0']);}finally{await f.helper.dispose();}
});
test('managed listener ownership uses the real suspended JDK JVM and rejects another PID',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const config=path.resolve('test-output/v0.4-java-host-runtime.json');if(!fs.existsSync(config))return;
  const java=path.join(JSON.parse(fs.readFileSync(config,'utf8')).javaHome,'bin/java.exe'),port=await allocatePort();
  const child=spawn(java,['-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:'+port,'-version'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',resolve));let output='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
  try{const proof=await waitForOwnedListener({pid:child.pid,port});assert.equal(proof.verified,true);assert.equal(proof.pid,child.pid);assert.equal(proof.address,'127.0.0.1');await assert.rejects(()=>waitForOwnedListener({pid:child.pid+99999,port}),error=>error.code==='FOREIGN_LISTENER');}finally{if(child.exitCode===null)child.kill();await exit;}
});
