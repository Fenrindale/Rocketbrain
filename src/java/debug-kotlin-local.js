'use strict';

const { KOTLIN_LOCAL_WRITE_BUILD } = require('./debug-runtime');

const command = 'rocketbrain/setKotlinLocal';
const types = new Set(['Int','Long','Boolean']);
const id = value => Number.isSafeInteger(value) && value > 0;

function createKotlinLocalEditor(vscode, { getState, ensureTrusted }) {
  const frames = new WeakMap(), pending = new WeakMap();

  function current(session) {
    ensureTrusted();
    const state = session && getState(session.id);
    if (session?.type !== 'rocketbrain-java' || vscode.debug.activeDebugSession?.id !== session.id ||
        state?.state !== 'stopped' || state.resuming !== undefined || !id(state.threadId)) {
      throw Error('Focus a paused Kotlin frame in the active Rocketbrain Java session.');
    }
    if (state.debugBuild !== KOTLIN_LOCAL_WRITE_BUILD) throw Error('Update the Rocketbrain Java debugger to edit Kotlin locals.');
    const selection = vscode.debug.activeStackItem;
    const focused = selection?.session?.id === session.id ? selection : undefined;
    if (focused && focused.threadId !== state.threadId) throw Error('Choose a frame on the paused debug thread.');
    return { generation:state.stopVersion,threadId:state.threadId,focus:id(focused?.frameId)?focused.frameId:undefined,
      appliedBuild:state.appliedVersion };
  }

  function validate(review) {
    if (!review) throw Error('Review the current Kotlin frame before editing a local value.');
    const next = current(review.session);
    if (next.generation !== review.stop.generation || next.threadId !== review.stop.threadId ||
        next.focus !== review.stop.focus || next.appliedBuild !== review.stop.appliedBuild) {
      throw Error('The paused Kotlin frame changed. Review the local value again.');
    }
  }

  async function list(session = vscode.debug.activeDebugSession) {
    const stop = current(session);
    const context = {session,stop};
    const result = await session.customRequest('stackTrace',{threadId:stop.threadId,startFrame:0,levels:stop.focus?32:1});
    validate(context);
    const stack = result?.stackFrames;
    if (!Array.isArray(stack) || stack.length>32) throw Error('The Java adapter returned an invalid call stack.');
    const frame = stop.focus ? stack.find(item=>item.id===stop.focus) : stack[0];
    if (!id(frame?.id)) throw Error('Choose a Kotlin frame within the top 32 calls.');
    const response = await session.customRequest(command,{action:'list',frameId:frame.id});
    validate(context);
    const locals = response?.locals;
    if (!Array.isArray(locals) || locals.length>128 || locals.some(local=>!types.has(local?.type)||
        typeof local.name!=='string'||!(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u).test(local.name))) {
      throw Error('The Kotlin debug adapter returned an invalid local list.');
    }
    const report = Object.freeze({frame:String(frame.name||'').slice(0,512),locals:Object.freeze(locals.map(value=>Object.freeze({...value})))});
    frames.set(report,{...context,frameId:frame.id});
    return report;
  }

  async function prepare(report,name,literal) {
    const context = frames.get(report);
    validate(context);
    const slot = report.locals.find(value=>value.name===name);
    if (!slot || typeof literal!=='string' || literal.length>24) throw Error('Choose a reviewed Kotlin local and a matching primitive literal.');
    const result = await context.session.customRequest(command,{action:'prepare',frameId:context.frameId,name,literal});
    validate(context);
    if (result?.name!==slot.name || result.type!==slot.type || !/^[a-f0-9-]{36}$/u.test(result.reviewId) ||
        !/^(?:-?\d{1,20}|true|false)$/u.test(result.before) || !/^(?:-?\d{1,20}|true|false)$/u.test(result.after)) {
      throw Error('The Kotlin debug adapter returned an invalid local review.');
    }
    const review = Object.freeze({name, type:result.type, before:result.before, after:result.after});
    pending.set(review,{...context,reviewId:result.reviewId});
    return review;
  }

  async function apply(review) {
    const context = pending.get(review);
    validate(context);
    pending.delete(review);
    const result = await context.session.customRequest(command,{action:'apply',frameId:context.frameId,reviewId:context.reviewId});
    if (result?.state!=='applied' || result.name!==review.name || result.value!==review.after) {
      throw Error('The Kotlin debug adapter did not confirm the requested local value.');
    }
    return {state:'applied',name:result.name,value:result.value};
  }

  async function cancel(review) {
    const context = pending.get(review);
    if (!context) return;
    pending.delete(review);
    await context.session.customRequest(command,{action:'cancel',reviewId:context.reviewId}).catch(()=>{});
  }

  async function choose() {
    const report = await list();
    if (!report.locals.length) throw Error('This paused Kotlin frame has no supported primitive local slots.');
    const selection = await vscode.window.showQuickPick(report.locals.map(local=>({label:local.name,description:local.type,local})),
      {title:'Set Kotlin Local Value',placeHolder:report.frame});
    if (!selection) return;
    const literal = await vscode.window.showInputBox({title:'Set Kotlin Local Value',
      prompt:'Enter a literal for JVM ' + selection.local.type + ' slot ' + selection.local.name,ignoreFocusOut:true});
    if (literal === undefined) return;
    const review = await prepare(report,selection.local.name,literal.trim());
    try {
      const choice = await vscode.window.showWarningMessage('Change the local value in this paused Kotlin frame?',{modal:true,
        detail:review.name+' · '+review.type+'\n'+review.before+' → '+review.after},'Set Local Value');
      if (choice!=='Set Local Value') return;
      const result = await apply(review);
      void vscode.window.showInformationMessage('Updated '+review.name+' in the paused frame.');
      return result;
    } finally { await cancel(review); }
  }

  return {list,prepare,apply,cancel,choose};
}

module.exports = {createKotlinLocalEditor};
