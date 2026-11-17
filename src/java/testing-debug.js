'use strict';

const net=require('node:net'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');

const DEBUG_TYPE='rocketbrain-java';
const MARKER='__rocketbrainTestDebugId';
class TestDebugError extends Error {constructor(code,message){super(message);this.name='JavaTestDebugError';this.code=code;}}
const cancelled=value=>Boolean(value?.isCancellationRequested||value?.aborted);
function linkCancellation(value,abort){
  if(!value)return {dispose(){}};
  const stop=()=>abort.abort();
  if(cancelled(value))stop();
  if(value.onCancellationRequested)return value.onCancellationRequested(stop);
  value.addEventListener?.('abort',stop,{once:true});return {dispose(){value.removeEventListener?.('abort',stop);}};
}
async function allocatePort(){
  return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
}

/** Read-only OS ownership check; never opens a JDWP connection or trusts application output. */
function waitForOwnedListener({pid,port,cancellation,timeoutMs=15000}={}){
  if(!Number.isInteger(pid)||pid<1||!Number.isInteger(port)||port<1||port>65535)throw new TestDebugError('INVALID_TARGET','A managed JVM PID and loopback port are required.');
  if(process.platform!=='win32')throw new TestDebugError('OWNERSHIP_UNSUPPORTED','Managed test debugging currently verifies listener ownership on Windows. This platform is not yet verified.');
  if(!Number.isInteger(timeoutMs)||timeoutMs<250||timeoutMs>30000)throw new TestDebugError('INVALID_TIMEOUT','Invalid debug ownership timeout.');
  if(cancelled(cancellation))return Promise.reject(new TestDebugError('CANCELLED','Test debugging was cancelled.'));
  // Every substituted value is a validated integer. No project text, paths or credentials enter this command.
  const script="$ErrorActionPreference='Stop';$targetDeadline=[DateTime]::UtcNow.AddMilliseconds("+timeoutMs+");while([DateTime]::UtcNow -lt $targetDeadline){$targetRows=@(Get-NetTCPConnection -LocalPort "+port+" -State Listen -ErrorAction SilentlyContinue);if($targetRows.Count -gt 0){$ownedRows=@($targetRows|Where-Object {$_.OwningProcess -eq "+pid+" -and $_.LocalAddress -eq '127.0.0.1'});if($ownedRows.Count -eq 1 -and $targetRows.Count -eq 1){[Console]::Out.Write('OWNED');exit 0};[Console]::Out.Write('FOREIGN');exit 3};if(-not(Get-Process -Id "+pid+" -ErrorAction SilentlyContinue)){[Console]::Out.Write('EXITED');exit 4};Start-Sleep -Milliseconds 100};[Console]::Out.Write('TIMEOUT');exit 5";
  return new Promise((resolve,reject)=>{
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    let done=false,subscription;
    const child=execFile(executable,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:timeoutMs+5000,maxBuffer:4096},(error,stdout)=>{
      if(done)return;done=true;subscription?.dispose();
      if(cancelled(cancellation)){reject(new TestDebugError('CANCELLED','Test debugging was cancelled.'));return;}
      if(!error&&stdout.trim()==='OWNED'){resolve({pid,port,address:'127.0.0.1',verified:true,method:'Windows Get-NetTCPConnection OwningProcess'});return;}
      reject(new TestDebugError(stdout.trim()==='FOREIGN'?'FOREIGN_LISTENER':'TARGET_NOT_READY',stdout.trim()==='FOREIGN'?'The debug port does not belong exclusively to the managed test JVM.':'The managed JVM did not expose a verifiable loopback debug listener.'));
    });
    const stop=()=>{child.kill();};
    if(cancellation?.addEventListener){cancellation.addEventListener('abort',stop,{once:true});subscription={dispose:()=>cancellation.removeEventListener('abort',stop)};}
    else if(cancellation?.onCancellationRequested)subscription=cancellation.onCancellationRequested(stop);
    if(cancelled(cancellation))stop();
  });
}

function createTestDebugger(vscode,{java,ownershipProbe=waitForOwnedListener,portAllocator=allocatePort,attachTimeoutMs=30000,cleanupTimeoutMs=3000}={}){
  const active=new Set(),controllers=new Set();let disposed=false;
  const trusted=()=>{if(disposed)throw new TestDebugError('DISPOSED','Java test debugging is closed.');if(!vscode.workspace.isTrusted)throw new TestDebugError('UNTRUSTED_WORKSPACE','Trust the workspace before debugging Java tests.');};
  function runTests(project,options={},backend){
    const work=perform(project,options,backend);active.add(work);void work.finally(()=>active.delete(work)).catch(()=>{});return work;
  }
  async function perform(project,options,backend){
    trusted();
    if(options.coverage||options.perTestCoverage)throw new TestDebugError('SEPARATE_PROFILE','Test debugging and coverage use separate profiles; debugger evaluations are not attributed to tests.');
    if(!backend||typeof backend.runTests!=='function')throw new TestDebugError('INVALID_BACKEND','A managed Java test runner is required.');
    if(!java||typeof java.start!=='function')throw new TestDebugError('ENGINE_REQUIRED','Configure the independent Rocketbrain Java debug engine first.');
    if(!path.isAbsolute(project?.workspace||''))throw new TestDebugError('INVALID_PROJECT','Open a local test project before debugging.');
    const folder=vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.workspace));if(!folder)throw new TestDebugError('INVALID_PROJECT','The test project must be inside an open local workspace.');
    const abort=new AbortController(),external=linkCancellation(options.cancellation,abort);controllers.add(abort);
    let session,finishing=false,targetEnded=false,manualDisconnect=false,attachFailure,startTask,cleanupDeferred=false,result,sessionEnded=false,resolveSessionEnded;
    const sessionEndedPromise=new Promise(resolve=>{resolveSessionEnded=resolve;});
    const runId=crypto.randomUUID(),subscriptions=[],stopTasks=new Set();
    const detail={runId,address:'127.0.0.1',port:null,pid:null,sessionId:null,attached:false,listenerOwnershipVerified:false,userStopped:false};
    const own=value=>value?.type===DEBUG_TYPE&&value.configuration?.[MARKER]===runId;
    const stopOwn=value=>{if(!value||!own(value))return Promise.resolve();const work=(async()=>{let timer;try{await Promise.race([Promise.resolve().then(()=>vscode.debug.stopDebugging(value)).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,cleanupTimeoutMs);})]);}finally{clearTimeout(timer);}})();stopTasks.add(work);void work.finally(()=>stopTasks.delete(work));return work;};
    const capture=value=>{if(!own(value))return;session=value;detail.sessionId=value.id;if(finishing||abort.signal.aborted)void stopOwn(value);};
    const cleanup=()=>{for(const value of subscriptions)value.dispose();};
    const wait=async(promise,label)=>{
      let timer,stop;
      try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new TestDebugError('DEBUG_TIMEOUT',label+' timed out.'));},attachTimeoutMs);stop=()=>reject(new TestDebugError('CANCELLED','Test debugging was cancelled.'));abort.signal.addEventListener('abort',stop,{once:true});if(abort.signal.aborted)stop();})]);}
      finally{clearTimeout(timer);abort.signal.removeEventListener('abort',stop);}
    };
    subscriptions.push(vscode.debug.onDidStartDebugSession(capture));
    subscriptions.push(vscode.debug.onDidTerminateDebugSession(value=>{if(own(value)){sessionEnded=true;resolveSessionEnded();if(!finishing&&manualDisconnect){detail.userStopped=true;abort.abort();}}}));
    subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE,{createDebugAdapterTracker(value){
      if(!own(value))return;capture(value);
      return {
        onWillReceiveMessage(message){if(message?.type==='request'&&['disconnect','terminate'].includes(message.command)&&!finishing&&!targetEnded){manualDisconnect=true;detail.userStopped=true;abort.abort();}},
        onDidSendMessage(message){if(message?.type==='event'&&['exited','terminated'].includes(message.event))targetEnded=true;},
        onError(){if(!finishing){attachFailure=new TestDebugError('DEBUG_ADAPTER_ERROR','The managed Java test debug adapter failed.');abort.abort();}}
      };
    }}));
    try{
      if(cancelled(options.cancellation))throw new TestDebugError('CANCELLED','Test debugging was cancelled.');
      await wait(Promise.resolve(java.start()),'Java debug engine startup');trusted();
      if(!java.getState?.().debugBundlePath)throw new TestDebugError('ENGINE_REQUIRED','Install or configure the independent Java debug bundle before debugging tests.');
      detail.port=await portAllocator();trusted();
      if(!Number.isInteger(detail.port)||detail.port<1||detail.port>65535)throw new TestDebugError('INVALID_TARGET','A valid managed debug port could not be allocated.');
      const {debug:ignored,...runOptions}=options;
      result=await backend.runTests(project,{...runOptions,coverage:false,perTestCoverage:false,cancellation:abort.signal,debug:{port:detail.port,onStarted:async target=>{
        if(!Number.isInteger(target?.pid)||target.pid<1||target.port!==detail.port)throw new TestDebugError('INVALID_TARGET','The test runner did not identify its managed JVM.');
        detail.pid=target.pid;const startupCancellation=linkCancellation(target.cancellation,abort);
        try{
          trusted();if(abort.signal.aborted)throw new TestDebugError('CANCELLED','Test debugging was cancelled.');
          const proof=await ownershipProbe({pid:detail.pid,port:detail.port,cancellation:abort.signal});
          if(proof?.verified!==true||proof.pid!==detail.pid||proof.port!==detail.port)throw new TestDebugError('FOREIGN_LISTENER','Managed JVM listener ownership could not be verified.');
          trusted();if(abort.signal.aborted)throw new TestDebugError('CANCELLED','Test debugging was cancelled.');detail.listenerOwnershipVerified=true;
          const config={type:DEBUG_TYPE,request:'attach',name:'Rocketbrain tests · '+(project.label||path.basename(project.workspace)),hostName:'127.0.0.1',port:detail.port,sourcePaths:project.sourceRoots||[],[MARKER]:runId,...(project.projectName?{projectName:project.projectName}:{}),stepFilters:{skipClasses:['java.*','jdk.*','sun.*','org.junit.*','org.testng.*','rocketbrain.testing.*']}};
          startTask=Promise.resolve(vscode.debug.startDebugging(folder,config,{suppressDebugToolbar:false}));
          const started=await wait(startTask,'Managed test debug attach');
          if(!started)throw new TestDebugError('ATTACH_FAILED','The independent Java debugger did not attach to the managed test JVM.');
          trusted();if(abort.signal.aborted)throw new TestDebugError('CANCELLED','Test debugging was cancelled.');
          if(!session)throw new TestDebugError('SESSION_MISSING','The managed test debugger did not publish its matching session.');
          detail.attached=true;
        }finally{startupCancellation.dispose();}
      }}});
      trusted();if(attachFailure)throw attachFailure;
      if(manualDisconnect||cancelled(options.cancellation))result={...result,state:'cancelled',cancelled:true};
    }catch(error){
      if(manualDisconnect||cancelled(options.cancellation)||disposed)result={...(result||{}),state:'cancelled',cancelled:true,summary:result?.summary||{},events:result?.events||[],tests:result?.tests||[]};
      else throw error;
    }finally{
      finishing=true;external.dispose();controllers.delete(abort);
      // Cancellation of the managed JVM does not settle VS Code's attach promise.
      // Keep the exact-session listener alive and await a late attach before
      // acknowledging cleanup, then stop and observe termination of that session.
      let startupSettled=true;
      if(startTask){let timer;try{startupSettled=await Promise.race([startTask.then(()=>true,()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),attachTimeoutMs);})]);}finally{clearTimeout(timer);}}
      if(!startupSettled){cleanupDeferred=true;void startTask.finally(async()=>{await stopOwn(session);await Promise.allSettled([...stopTasks]);cleanup();}).catch(()=>{});}
      await stopOwn(session);await Promise.allSettled([...stopTasks]);
      if(session&&!sessionEnded){let timer;try{await Promise.race([sessionEndedPromise,new Promise(resolve=>{timer=setTimeout(resolve,cleanupTimeoutMs);})]);}finally{clearTimeout(timer);}}
      if(!cleanupDeferred)cleanup();
      if(!startupSettled)throw new TestDebugError('DEBUG_CLEANUP_TIMEOUT','VS Code did not settle the managed test debug startup after the test JVM was stopped. Exact-session cleanup remains registered.');
      if(session&&!sessionEnded)throw new TestDebugError('DEBUG_CLEANUP_TIMEOUT','The managed test debug session did not confirm termination.');
    }
    return {...result,debug:{...detail,sessionStopped:!session||sessionEnded,source:'owned-suspended-test-jvm',applicationOutputUsedForControl:false}};
  }
  return {runTests,async dispose(){if(disposed)return;disposed=true;for(const abort of controllers)abort.abort();await Promise.allSettled([...active]);}};
}

module.exports={createTestDebugger,waitForOwnedListener,allocatePort,TestDebugError,DEBUG_TYPE,MARKER};
