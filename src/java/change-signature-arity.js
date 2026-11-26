'use strict';

const { fileURLToPath } = require('node:url');
const { fileKey } = require('./dependency-builds');

const uriKey=value=>fileKey(fileURLToPath(value));

function inspectArityConversion(family, calls, references) {
  const method=family[0], declaration=method?.varargDeclaration;
  if (family.length!==1 || !declaration || references.length>40 || calls.length>200) return undefined;
  const fixedCount=method.parameters.length-1;
  if (calls.some(call=>{
    const arity=call.arityConversion;
    return !arity || arity.component!==declaration.component || arity.fixedCount!==fixedCount ||
      !['fixed-array','spread'].includes(arity.mode);
  })) return undefined;
  if (references.some(reference=>{
    const arity=reference.arityConversion;
    return !arity || arity.component!==declaration.component || arity.fixedCount!==fixedCount ||
      !['fixed-array','spread'].includes(arity.mode);
  })) return undefined;
  const lastBySource=new Map();
  for (const invocation of [...calls].sort((a,b)=>a.start-b.start)) {
    const key=uriKey(invocation.uri);
    if (invocation.start<(lastBySource.get(key) || 0)) return undefined;
    lastBySource.set(key,invocation.end);
  }
  const spreadCalls=calls.filter(call=>call.arityConversion.mode==='spread').length;
  const spreadReferences=references.filter(reference=>reference.arityConversion.mode==='spread');
  return {key:method.key,uri:method.uri,declaration,fixedCount,componentType:declaration.component,
    spreadCalls,fixedArrayCalls:calls.length-spreadCalls,spreadReferences,
    fixedReferences:references.filter(reference=>reference.arityConversion.mode==='fixed-array')};
}

function arityChange(semantic,value) {
  const option=semantic?.convertArity;
  if (value!=='array' || !option) throw Error('Choose the reviewed private varargs declaration with supported direct array conversion evidence.');
  return option;
}

function prepareArityEdits(record,change,positionAt) {
  const snapshots=new Map(record.documents.map(item=>[uriKey(item.uri),item]));
  const changes={};
  function add(uri,start,end,newText) {
    const saved=snapshots.get(uriKey(uri));
    if (!saved || !Number.isInteger(start) || !Number.isInteger(end) || start<0 || end<start || end>saved.text.length) {
      throw Error('The compiler did not report an exact source range for the array conversion.');
    }
    (changes[saved.uri]??=[]).push({range:{start:positionAt(saved.text,start),end:positionAt(saved.text,end)},newText});
  }
  const {uri,declaration,componentType}=change, document=snapshots.get(uriKey(uri));
  if (document?.text.slice(declaration.start,declaration.end)!=='...') throw Error('The final varargs declaration changed.');
  add(uri,declaration.start,declaration.end,'[]');
  const array='new '+componentType+'[] {';
  for (const call of record.semantic.calls) {
    const evidence=call.arityConversion;
    if (evidence.mode!=='spread') continue;
    const saved=snapshots.get(uriKey(call.uri));
    const values=evidence.arguments.slice(change.fixedCount);
    if (!saved || saved.text[call.end-1]!==')' || values.some(value=>
      value.start<call.start || value.end>=call.end || saved.text.slice(value.start,value.end)!==value.source)) {
      throw Error('A reviewed varargs caller changed or has an unsupported source range.');
    }
    if (values.length) {
      add(call.uri,values[0].start,values[0].start,array);
      add(call.uri,values.at(-1).end,values.at(-1).end,'}');
    } else {
      add(call.uri,call.end-1,call.end-1,(change.fixedCount?', ':'')+array+'}');
    }
  }
  return {changes};
}

function sameArguments(first,second) {
  if (!Array.isArray(second) || first.length!==second.length) return false;
  return first.every((argument,index)=>argument.source===second[index].source && argument.type===second[index].type);
}

function verifyArityCalls(semantic,after,change) {
  const identity=call=>JSON.stringify([uriKey(call.uri),call.enclosingKey,call.ordinal,call.methodKey]);
  const prospective=new Map(after.filter(call=>call.methodKey===change.key).map(call=>[identity(call),call]));
  for (const call of semantic.calls) {
    const prior=call.arityConversion, current=prospective.get(identity(call))?.arityConversion;
    if (!current || current.mode!=='fixed-array' || current.component!==prior.component ||
        current.fixedCount!==prior.fixedCount || current.selector!==prior.selector) {
      throw Error('The array conversion changes the reviewed method, receiver or argument mode.');
    }
    const {fixedCount}=prior;
    if (prior.mode==='fixed-array') {
      if (!sameArguments(prior.arguments,current.arguments)) throw Error('Preserve the original explicit array argument.');
    } else if (!sameArguments(prior.arguments.slice(0,fixedCount),current.arguments.slice(0,fixedCount)) ||
      !sameArguments(prior.arguments.slice(fixedCount),current.initializer)) {
      throw Error('The array conversion changes a reviewed argument expression, type or evaluation order.');
    }
  }
}

function verifyArityReferences(after,change) {
  const evidence=reference=>{
    const arity=reference.arityConversion;
    return [uriKey(reference.uri),reference.enclosingKey,reference.targetType,arity?.mode,arity?.kind,
      arity?.source,arity?.component,arity?.fixedCount,arity?.parameterTypes,arity?.returnType];
  };
  const actual=after.methodReferences.filter(reference=>reference.methodKey===change.key);
  if (JSON.stringify(change.fixedReferences.map(evidence))!==JSON.stringify(actual.map(evidence))) {
    throw Error('The array conversion changes the binding or fixed-array mode of a retained method reference.');
  }
}

module.exports={inspectArityConversion,arityChange,prepareArityEdits,verifyArityCalls,verifyArityReferences};
