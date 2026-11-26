'use strict';

const name=/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,11}$/u;
const member=/^[A-Za-z_$][A-Za-z0-9_$]{0,95}$/u;
const eventId=/^arc-interception-[1-9][0-9]{0,15}$/u;
const type='\\[{0,8}(?:[ZBSCIJFD]|L[A-Za-z_$][A-Za-z0-9_$/]*;)';
const method=new RegExp('^\\((?:'+type+'){0,24}\\)(?:'+type+'|V)$','u');
const states=new Set(['disabled','waiting','ready','partial']);
const callbackDescriptors=new Set(['(Ljakarta/interceptor/InvocationContext;)Ljava/lang/Object;',
  '(Lio/quarkus/arc/ArcInvocationContext;)Ljava/lang/Object;']);
const list=(value,limit)=>Array.isArray(value)&&value.length<=limit;
const qualified=value=>typeof value==='string'&&value.length<=160&&name.test(value);
const distinct=items=>new Set(items).size===items.length;

function normalizeArcInterceptors(raw) {
  function invalid(){throw Error('Invalid Quarkus interceptor observation.');}
  if (!raw||!states.has(raw.state)||!Number.isSafeInteger(raw.processId)||raw.processId<1||
      !list(raw.packages,4)||!raw.packages.every(qualified)||!distinct(raw.packages)||
      !list(raw.invocations,32)||raw.bindingValuesRetained!==false||raw.argumentsRetained!==false||
      raw.inspectionInvokedApplication!==false||(raw.state==='disabled'?raw.packages.length!==0:!raw.packages.length)||
      (['disabled','waiting'].includes(raw.state)&&raw.invocations.length)) invalid();
  const within=value=>qualified(value)&&raw.packages.some(scope=>value.startsWith(scope+'.'));
  function target(value,callback=false) {
    if (!value||!within(value.owner)||typeof value.member!=='string'||!member.test(value.member)||
        typeof value.descriptor!=='string'||value.descriptor.length>240||
        !(callback?callbackDescriptors.has(value.descriptor):method.test(value.descriptor))) invalid();
    return {owner:value.owner,member:value.member,descriptor:value.descriptor};
  }
  const ids=new Set();
  const invocations=raw.invocations.map(event=>{
    if (!event||typeof event.id!=='string'||!eventId.test(event.id)||ids.has(event.id)||
        !list(event.bindingTypes,16)||!event.bindingTypes.every(within)||!distinct(event.bindingTypes)||
        !list(event.configured,16)||!event.configured.length||!list(event.entered,32)||
        !event.entered.every(index=>Number.isInteger(index)&&index>=0&&index<event.configured.length)||
        !['returned','threw'].includes(event.outcome)) invalid();
    ids.add(event.id);
    const configured=event.configured.map(entry=>{
      if(entry?.kind==='unresolved'&&raw.state==='partial')return {kind:'unresolved'};
      if(entry?.kind!=='source'||!Number.isInteger(entry.priority)||entry.priority<-2147483648||entry.priority>2147483647) invalid();
      return {kind:'source',target:target(entry.target,true),priority:entry.priority};
    });
    return {id:event.id,target:target(event.target),bindingTypes:[...event.bindingTypes],
      configured,entered:[...event.entered],outcome:event.outcome};
  });
  return {state:raw.state,processId:raw.processId,packages:[...raw.packages],invocations,bindingValuesRetained:false,
    argumentsRetained:false,inspectionInvokedApplication:false};
}

module.exports={normalizeArcInterceptors};
