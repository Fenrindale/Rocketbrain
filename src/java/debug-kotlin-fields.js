'use strict';

const { KOTLIN_FIELD_BUILD, KOTLIN_LINE_BUILD } = require('./debug-runtime');
const { createKotlinFrameGuard } = require('./debug-kotlin-local');

const request = 'rocketbrain/kotlinObjectFields';
const names = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const tokens = /^[a-f0-9-]{36}$/u;
const primitiveTypes = new Set(['Int','Long','Boolean']);
const isName = value => typeof value === 'string' && names.test(value);
const same = (actual, expected, keys) => keys.every(key=>actual?.[key]===expected[key]);

function isScalar(type, boxed, value) {
  if (typeof value!=='string') return false;
  if (boxed && value === 'null') return true;
  return type.startsWith('Boolean') ? /^(?:false|true)$/u.test(value) : /^-?\d{1,20}$/u.test(value);
}

function createKotlinFieldInspector(vscode, options) {
  const {inspect,validate} = createKotlinFrameGuard(vscode,{...options,builds:[KOTLIN_FIELD_BUILD,KOTLIN_LINE_BUILD]});
  const receivers = new WeakMap(), fields = new WeakMap(), reviews = new WeakMap();

  function need(records, report) {
    const context = records.get(report);
    if (!context) throw Error('Inspect this paused Kotlin object before requesting its fields.');
    validate(context);
    return context;
  }

  async function send(context, action, args = {}) {
    validate(context);
    const result = await context.session.customRequest(request,{action,frameId:context.frameId,...args});
    validate(context);
    return result;
  }

  async function list(session = vscode.debug.activeDebugSession) {
    const context = await inspect(session);
    const items = (await send(context,'receivers'))?.receivers;
    if (!Array.isArray(items)||items.length>128||items.some(row=>!isName(row?.name)||
        typeof row.owner!=='string'||row.owner.length>512||/[\r\n\x00]/u.test(row.owner))) {
      throw Error('The Java adapter returned an invalid Kotlin object list.');
    }
    const report = Object.freeze({frame:context.frame,receivers:Object.freeze(items.map(({name,owner})=>Object.freeze({name,owner})))});
    receivers.set(report,context);
    return report;
  }

  async function inspectFields(report, name) {
    const context = need(receivers,report);
    const receiver = report.receivers.find(row=>row.name===name);
    if (!receiver) throw Error('Choose a visible Kotlin object from this paused frame.');
    const items = (await send(context,'fields',{receiver:name}))?.fields;
    if (!Array.isArray(items)||items.length>256||items.some(row=>!isName(row?.name)||
        typeof row.boxed!=='boolean'||typeof row.writable!=='boolean'||typeof row.type!=='string'||
        !primitiveTypes.has(row.boxed?row.type.replace(/ \(boxed\)$/u,''):row.type)||
        row.boxed!==row.type.endsWith(' (boxed)')||!isScalar(row.type,row.boxed,row.value)||
        !Array.isArray(row.boxSources)||row.boxSources.length>128||row.boxSources.some(source=>!isName(source))||
        ((!row.writable||!row.boxed)&&row.boxSources.length>0))) throw Error('The Java adapter returned an invalid field list.');
    const reportFields = Object.freeze({receiver, fields:Object.freeze(items.map(({name,type,value,boxed,writable,boxSources})=>
      Object.freeze({name,type,value,boxed,writable,boxSources:Object.freeze([...boxSources])})))});
    fields.set(reportFields,context);
    return reportFields;
  }

  async function prepare(report, name, input) {
    const context = need(fields,report);
    const slot = report.fields.find(row=>row.name===name);
    if (!slot?.writable||typeof input!=='string'||(slot.boxed?!slot.boxSources.includes(input):input.length>24)) {
      throw Error('Choose a writable Kotlin field and its matching primitive literal or boxed local.');
    }
    const {name:receiver,owner} = report.receiver;
    const result = await send(context,'prepare',{receiver,name,input});
    if (!same(result,{receiver,owner,name,type:slot.type},['receiver','owner','name','type'])||
        typeof result.reviewId!=='string'||!tokens.test(result.reviewId)||
        !isScalar(slot.type,slot.boxed,result.before)||!isScalar(slot.type,slot.boxed,result.after)||result.after==='null') {
      throw Error('The Java adapter returned an invalid Kotlin field review.');
    }
    const review = Object.freeze({receiver,owner,name,type:result.type,before:result.before,after:result.after,
      ...(slot.boxed?{boxedLocal:input}:{})});
    reviews.set(review,{...context,reviewId:result.reviewId});
    return review;
  }

  async function apply(review) {
    const context = need(reviews,review);
    reviews.delete(review);
    const result = await send(context,'apply',{reviewId:context.reviewId});
    if (!same(result,{state:'applied',receiver:review.receiver,name:review.name,value:review.after},['state','receiver','name','value'])) {
      throw Error('The Java adapter did not confirm the reviewed Kotlin field value.');
    }
    return {state:'applied',receiver:result.receiver,name:result.name,value:result.value};
  }

  async function cancel(review) {
    const context = reviews.get(review);
    if (!context) return;
    reviews.delete(review);
    await context.session.customRequest(request,{action:'cancel',reviewId:context.reviewId}).catch(()=>{});
  }

  async function choose() {
    const report = await list();
    if (!report.receivers.length) throw Error('There are no inspectable Kotlin object locals in this frame.');
    const title = 'Inspect Kotlin Object Fields';
    const selected = await vscode.window.showQuickPick(report.receivers.map(receiver=>({label:receiver.name,
      description:receiver.owner})),{title,placeHolder:report.frame});
    if (!selected) return;
    const observed = await inspectFields(report,selected.label);
    const selection = await vscode.window.showQuickPick(observed.fields.map(slot=>({label:slot.name,slot,
      description:slot.type+' · '+slot.value,detail:slot.writable?undefined:'Read-only JVM field'})),
      {title,placeHolder:observed.receiver.name+' · '+observed.receiver.owner});
    if (!selection) return;
    const {slot} = selection;
    if (!slot.writable || (slot.boxed && !slot.boxSources.length)) {
      const reason = slot.writable?'A matching non-null boxed local is required for replacement.':'This JVM field is read-only.';
      void vscode.window.showInformationMessage(observed.receiver.name+'.'+slot.name+' = '+slot.value+' · '+slot.type+'\n'+reason);
      return;
    }
    const input = slot.boxed
      ? await vscode.window.showQuickPick([...slot.boxSources],{title,placeHolder:'Copy an existing non-null boxed '+slot.type.split(' ')[0]+' local'})
      : await vscode.window.showInputBox({title,prompt:'Enter a '+slot.type+' literal for '+observed.receiver.name+'.'+slot.name,ignoreFocusOut:true});
    if (input === undefined) return;
    const review = await prepare(observed,slot.name,input.trim());
    try {
      const source = review.boxedLocal ? '\nCopy reference from '+review.boxedLocal : '';
      const answer = await vscode.window.showWarningMessage('Set this JVM field in the paused Kotlin object?',{modal:true,
        detail:review.receiver+'.'+review.name+' · '+review.owner+'\n'+review.before+' → '+review.after+source},'Set Field Value');
      if (answer!=='Set Field Value') return;
      const result = await apply(review);
      void vscode.window.showInformationMessage(result.receiver+'.'+result.name+' = '+result.value);
      return result;
    } finally { await cancel(review); }
  }

  return {list,inspectFields,prepare,apply,cancel,choose};
}

module.exports = {createKotlinFieldInspector};
