'use strict';

const { KOTLIN_FIELD_BUILD, KOTLIN_LINE_BUILDS, KOTLIN_BOX_BUILD } = require('./debug-runtime');
const { createKotlinFrameGuard } = require('./debug-kotlin-local');

const request = 'rocketbrain/kotlinObjectFields';
const names = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const tokens = /^[a-f0-9-]{36}$/u;
const primitiveTypes = new Set(['Int','Long','Boolean']);
const maxText = 2048, pageSize = 32, unavailableText = '<String preview unavailable>';
const isName = value => typeof value === 'string' && names.test(value);
const same = (actual, expected, keys) => keys.every(key=>actual?.[key]===expected[key]);
const index = value => Number.isSafeInteger(value) && value>=0 && value<=2147483647;

function isScalar(type, boxed, value) {
  if (typeof value!=='string') return false;
  if (boxed && value === 'null') return true;
  return type.startsWith('Boolean') ? /^(?:false|true)$/u.test(value) : /^-?\d{1,20}$/u.test(value);
}

function isText(value) {
  if (typeof value!=='string' || value.length>maxText*6+2 || !value.startsWith('"')) return false;
  try { const parsed=JSON.parse(value); return typeof parsed==='string' && parsed.length<=maxText; }
  catch { return false; }
}

function isField(row) {
  if (!isName(row?.name) || typeof row.boxed!=='boolean' || typeof row.writable!=='boolean' || typeof row.type!=='string' ||
      !Array.isArray(row.boxSources) || row.boxSources.length>128 || row.boxSources.some(source=>!isName(source)) ||
      ((!row.writable || !row.boxed) && row.boxSources.length) ||
      (row.boxLiteral!==undefined && (row.boxLiteral!==true || !row.writable || !row.boxed || row.kind!==undefined))) return false;
  if (row.kind==='text') return row.type==='String' && !row.boxed &&
    (isText(row.value) || row.value==='null' || row.value===unavailableText && !row.writable);
  if (row.kind==='array') return !row.boxed && primitiveTypes.has(row.elementType) && row.type===row.elementType+'Array' &&
    index(row.length) && (row.value==='length '+row.length || row.value==='null' && row.length===0 && !row.writable);
  return row.kind===undefined && primitiveTypes.has(row.boxed?row.type.replace(/ \(boxed\)$/u,''):row.type) &&
    row.boxed===row.type.endsWith(' (boxed)') && isScalar(row.type,row.boxed,row.value);
}

function boxedLiteralValue(type, input) {
  const scalar=type.split(' ')[0];
  if (typeof input==='string' && input.length<=24) {
    if (scalar==='Boolean' && /^(?:true|false)$/u.test(input)) return input;
    const match=/^(-?(?:0|[1-9]\d*))(L)?$/u.exec(input);
    if (scalar!=='Boolean' && match && Boolean(match[2])===(scalar==='Long')) {
      const number=BigInt(match[1]), limit=1n << (scalar==='Long'?63n:31n);
      if (number>=-limit && number<limit) return String(number);
    }
  }
  throw Error('Enter an in-range Kotlin '+scalar+' literal. Use an L suffix for Long.');
}

function createKotlinFieldInspector(vscode, options) {
  const {inspect,validate} = createKotlinFrameGuard(vscode,{...options,builds:[KOTLIN_FIELD_BUILD,...KOTLIN_LINE_BUILDS]});
  const receivers = new WeakMap(), fields = new WeakMap(), pages = new WeakMap(), reviews = new WeakMap();

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
    if (!Array.isArray(items)||items.length>256||items.some(row=>!isField(row))) {
      throw Error('The Java adapter returned an invalid field list.');
    }
    const access=options.getState(context.session.id)?.debugBuild===KOTLIN_BOX_BUILD;
    const reportFields = Object.freeze({receiver, fields:Object.freeze(items.map(({name,type,value,boxed,writable,boxSources,boxLiteral,kind,length,elementType})=>
      Object.freeze({name,type,value,boxed,writable,boxSources:Object.freeze([...boxSources]),...(kind&&{kind}),
        ...(kind==='array'&&{length,elementType}),...(access&&boxLiteral&&{boxLiteral:true})})))});
    fields.set(reportFields,context);
    return reportFields;
  }

  async function inspectArray(report, name, start=0) {
    const context=need(fields,report), slot=report.fields.find(row=>row.name===name && row.kind==='array');
    if (!slot || !index(start) || start>=slot.length) throw Error('Choose a current Kotlin array field and a valid element offset.');
    const result=await send(context,'page',{receiver:report.receiver.name,name,start,count:pageSize});
    const expected={receiver:report.receiver.name,name,start,length:slot.length,elementType:slot.elementType};
    if (!same(result,expected,['receiver','name','start','length','elementType']) || !tokens.test(result?.pageId || '') ||
        !Array.isArray(result.items) || result.items.length!==Math.min(pageSize,slot.length-start) ||
        result.items.some((item,offset)=>item?.index!==start+offset || !isScalar(slot.elementType,false,item.value))) {
      throw Error('The Java adapter returned an invalid Kotlin array page.');
    }
    const page=Object.freeze({...expected,writable:slot.writable,items:Object.freeze(result.items.map(({index,value})=>Object.freeze({index,value})))});
    pages.set(page,{...context,pageId:result.pageId,report});
    return page;
  }

  async function prepareElement(page, at, input) {
    const context=need(pages,page);
    const item=page.items.find(value=>value.index===at);
    if (!page.writable || !item || typeof input!=='string' || input.length>24) {
      throw Error('Choose an editable Kotlin array element from this page and its matching literal.');
    }
    const {name:receiver,owner}=context.report.receiver;
    const result=await send(context,'prepare',{receiver,name:page.name,index:at,input,pageId:context.pageId});
    const expected={receiver,owner,name:page.name,type:page.elementType,index:at,before:item.value};
    if (!same(result,expected,['receiver','owner','name','type','index','before']) || !tokens.test(result?.reviewId || '') ||
        !isScalar(page.elementType,false,result.after)) throw Error('The Java adapter returned an invalid Kotlin element review.');
    const review=Object.freeze({...expected,after:result.after});
    reviews.set(review,{...context,reviewId:result.reviewId});
    return review;
  }

  async function reviewField(report, name, input, createBox=false) {
    const context = need(fields,report);
    const slot = report.fields.find(row=>row.name===name);
    const text=slot?.kind==='text';
    if (createBox && !slot?.boxLiteral) throw Error('Choose a writable Kotlin boxed field on the top breakpoint frame of a verified local JVM.');
    const literal = createBox ? boxedLiteralValue(slot.type,input) : undefined;
    if (text && (typeof input!=='string' || input.length>maxText || /[\u0000\uD800-\uDFFF]/u.test(input))) {
      throw Error('Use valid Kotlin field text of at most 2048 UTF-16 units.');
    }
    if (!slot?.writable||slot.kind==='array'||typeof input!=='string'||
        (!createBox && !text && (slot.boxed?!slot.boxSources.includes(input):input.length>24))) {
      throw Error('Choose a writable Kotlin field and its matching primitive literal or boxed local.');
    }
    const {name:receiver,owner} = report.receiver;
    const result = await send(context,createBox?'prepareLiteral':'prepare',{receiver,name,input});
    if (!same(result,{receiver,owner,name,type:slot.type},['receiver','owner','name','type'])||
        typeof result.reviewId!=='string'||!tokens.test(result.reviewId)||
        (createBox ? result.boxLiteral!==true || result.after!==literal : result.boxLiteral!==undefined) ||
        (text ? !(result.before==='null' || isText(result.before)) || !isText(result.after) || JSON.parse(result.after)!==input :
          !isScalar(slot.type,slot.boxed,result.before)||!isScalar(slot.type,slot.boxed,result.after)||result.after==='null')) {
      throw Error('The Java adapter returned an invalid Kotlin field review.');
    }
    const review = Object.freeze({receiver,owner,name,type:result.type,before:result.before,after:result.after,
      ...(createBox?{boxLiteral:input}:slot.boxed?{boxedLocal:input}:{})});
    reviews.set(review,{...context,reviewId:result.reviewId});
    return review;
  }

  const prepare=(report,name,input)=>reviewField(report,name,input);
  const prepareLiteral=(report,name,input)=>reviewField(report,name,input,true);

  async function apply(review) {
    const context = need(reviews,review);
    reviews.delete(review);
    const result = await send(context,'apply',{reviewId:context.reviewId});
    const expected={state:'applied',receiver:review.receiver,name:review.name,value:review.after};
    if (review.index!==undefined) expected.index=review.index;
    if (!same(result,expected,['state','receiver','name','value','index']) ||
        result.boxLiteral!==(review.boxLiteral===undefined?undefined:true)) {
      throw Error('The Java adapter did not confirm the reviewed Kotlin field value.');
    }
    return expected;
  }

  async function cancel(review) {
    const context = reviews.get(review);
    if (!context) return;
    reviews.delete(review);
    await context.session.customRequest(request,{action:'cancel',reviewId:context.reviewId}).catch(()=>{});
  }

  async function confirm(review) {
    const slot=review.receiver+'.'+review.name+(review.index===undefined?'':'['+review.index+']');
    try {
      const source=review.boxedLocal?'\nCopy reference from '+review.boxedLocal:review.boxLiteral!==undefined?
        '\nCreate the reviewed JVM wrapper for '+review.boxLiteral:'';
      const prompt=review.index===undefined?'Set this JVM field in the paused Kotlin object?':'Set this element in the paused Kotlin array?';
      const button=review.index===undefined?'Set Field Value':'Set Element Value';
      const answer=await vscode.window.showWarningMessage(prompt,{modal:true,
        detail:slot+' · '+review.owner+'\n'+review.before+' → '+review.after+source},button);
      if (answer!==button) return;
      const result=await apply(review);
      void vscode.window.showInformationMessage(slot+' = '+result.value);
      return result;
    } finally { await cancel(review); }
  }

  async function chooseElement(report, slot, title) {
    if (!slot.length) {
      void vscode.window.showInformationMessage(report.receiver.name+'.'+slot.name+' = '+slot.value);
      return;
    }
    let start=0;
    for (;;) {
      const page=await inspectArray(report,slot.name,start);
      const choices=page.items.map(item=>({label:'['+item.index+']',description:item.value,at:item.index}));
      if (start>0) choices.push({label:'Previous elements',offset:Math.max(0,start-pageSize)});
      if (start+page.items.length<page.length) choices.push({label:'Next elements',offset:start+page.items.length});
      const selected=await vscode.window.showQuickPick(choices,{title,
        placeHolder:report.receiver.name+'.'+slot.name+' · '+slot.type+' · '+(start+1)+'–'+(start+page.items.length)+' of '+page.length});
      if (!selected) return;
      if (selected.offset!==undefined) { start=selected.offset; continue; }
      if (!page.writable) {
        void vscode.window.showInformationMessage(selected.label+' = '+selected.description+' · Read-only JVM storage');
        return;
      }
      const input=await vscode.window.showInputBox({title,prompt:'Enter a '+page.elementType+' literal for '+slot.name+selected.label,
        ignoreFocusOut:true});
      if (input===undefined) return;
      return confirm(await prepareElement(page,selected.at,input.trim()));
    }
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
    if (slot.kind==='array') return chooseElement(observed,slot,title);
    if (!slot.writable || (slot.boxed && !slot.boxSources.length && !slot.boxLiteral)) {
      const reason = slot.writable?'A matching boxed local or a supported local breakpoint is required.':'This JVM field is read-only.';
      void vscode.window.showInformationMessage(observed.receiver.name+'.'+slot.name+' = '+slot.value+' · '+slot.type+'\n'+reason);
      return;
    }
    if (slot.boxed) {
      const choices=slot.boxSources.map(name=>({label:name,local:name,description:'Copy this boxed local'}));
      if (slot.boxLiteral) choices.push({label:'Enter a Kotlin literal',literal:true});
      const source=choices.length===1 && slot.boxLiteral ? choices[0] : await vscode.window.showQuickPick(choices,{title});
      if (!source) return;
      if (source.local) return confirm(await prepare(observed,slot.name,source.local));
      const literal=await vscode.window.showInputBox({title,prompt:'Enter a '+slot.type.split(' ')[0]+' literal for '+slot.name,ignoreFocusOut:true});
      if (literal!==undefined) return confirm(await prepareLiteral(observed,slot.name,literal.trim()));
      return;
    }
    const input = await vscode.window.showInputBox({title,prompt:slot.kind==='text' ?
      'Enter the replacement text for '+observed.receiver.name+'.'+slot.name :
      'Enter a '+slot.type+' literal for '+observed.receiver.name+'.'+slot.name,ignoreFocusOut:true});
    if (input === undefined) return;
    return confirm(await prepare(observed,slot.name,slot.kind==='text'?input:input.trim()));
  }

  return {list,inspectFields,inspectArray,prepareElement,prepare,prepareLiteral,apply,cancel,choose};
}

module.exports = {createKotlinFieldInspector};
