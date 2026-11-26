'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout:delay } = require('node:timers/promises');
const { createKotlinJsDebugAdapter } = require('./kmp-js-debug-adapter');
const { buildKotlinJsDebug } = require('./kmp-js-build');
const { nodeExecutable, runKotlinJsInspector } = require('./kmp-js-inspector');
const { cancelled, fail } = require('./workbench-model');

const DEBUG_TYPE = 'rocketbrain-kotlin-js';
const MARKER = '__rocketbrainKotlinJsDebugSession';

async function wait(work,timeout,signal) {
  const timer=new AbortController();
  const abort=()=>timer.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted) abort();
  try {
    const deadline=delay(timeout,undefined,{signal:timer.signal}).then(()=>{
      throw fail('VS Code did not start the reviewed Kotlin/JS debugger.');
    },()=>{
      throw fail('Kotlin/JS debugging was cancelled.');
    });
    return await Promise.race([work,deadline]);
  } finally {
    timer.abort();
    signal?.removeEventListener('abort',abort);
  }
}

function registerKotlinJsDebug(vscode) {
  let active;
  async function release(record) {
    if (!record) return;
    record.closing ||= (async()=>{
      try {
        await record.run.stop();
        if (record.session && !record.didTerminate) {
          await wait(vscode.debug.stopDebugging(record.session),5000).catch(()=>{});
        }
      } finally {
        record.emitter?.dispose();
        if(active===record) active=undefined;
      }
    })();
    return record.closing;
  }
  const factory=vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE,{
    createDebugAdapterDescriptor(session) {
      const record=active;
      if (!record || record.session || record.closing || session.type!==DEBUG_TYPE ||
          session.configuration[MARKER]!==record.token || session.configuration.request!=='launch') {
        throw fail('Start a reviewed Kotlin/JS Node target using the Rocketbrain command.');
      }
      record.validate();
      const emitter=record.emitter=new vscode.EventEmitter();
      record.session=session;
      record.adapter=createKotlinJsDebugAdapter({run:record.run,stage:record.stage,validate:record.validate,send:message=>{
        emitter.fire(message);
        if (message.event==='initialized') record.ready.resolve();
        if (message.command==='launch' && message.type==='response' && !message.success) {
          record.ready.reject(fail(message.message));
        }
      }});
      return new vscode.DebugAdapterInlineImplementation({onDidSendMessage:emitter.event,
        handleMessage:message=>record.adapter.handleMessage(message),
        dispose:()=>record.adapter.dispose()});
    }
  });
  const completion=vscode.debug.onDidTerminateDebugSession(session=>{
    if(active?.session?.id!==session.id) return;
    active.didTerminate=true;
    void release(active).catch(()=>{});
  });

  async function start({model,selection,tools,runner,cancellation,validate,node}) {
    if (active) throw fail('Finish the previous owned Kotlin/JS debug session first.');
    const stage=await buildKotlinJsDebug({model,selection,tools,runner,cancellation,validate});
    let run,record;
    try {
      validate();
      if (nodeExecutable(tools.nodeHome)!==node || cancelled(cancellation)) throw fail('The reviewed Node.js target changed.');
      run=await runKotlinJsInspector({node,stage,cancellation,onOutput:(category,text)=>record?.adapter?.output(category,text)});
      record={token:randomUUID(),run,stage,validate};
      const initialized = new Promise((resolve,reject)=>{record.ready={resolve,reject};});
      void initialized.catch(()=>{});
      active=record;
      void run.done.then(()=>release(record)).catch(()=>{});
      const folder=vscode.workspace.getWorkspaceFolder(vscode.Uri.file(model.root));
      const config={type:DEBUG_TYPE,request:'launch',name:'Kotlin/JS Node: '+selection.target.name,[MARKER]:record.token};
      const started=vscode.debug.startDebugging(folder,config,{suppressSaveBeforeStart:true});
      if (!await wait(started,25000,cancellation)) throw fail('VS Code refused the reviewed Kotlin/JS debugger.');
      await wait(initialized,18000,cancellation);
      return {state:'launched',modulePath:selection.module.path,target:selection.target.name,
        buildTask:selection.syncTask,artifact:path.basename(stage.entry),artifactSha256:stage.artifactSha256,
        mapSha256:stage.mapSha256,sourceCount:stage.mapping.sourceCount,ownedLoopback:true,sessionId:record.session.id};
    } catch(error) {
      if(record) await release(record);
      else if(run) await run.stop();
      else await stage.remove();
      throw error;
    }
  }
  return {start,get active(){return Boolean(active);},stop:()=>release(active),dispose(){
    factory.dispose();
    completion.dispose();
    return release(active);
  }};
}

module.exports = { registerKotlinJsDebug, DEBUG_TYPE };
