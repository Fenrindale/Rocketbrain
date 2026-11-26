'use strict';

const { lexJava } = require('../spring/java');

function referenceOperators(tokens) {
  const operators = [];
  for (let index = 0; index + 1 < tokens.length; index++) {
    const left = tokens[index], right = tokens[index + 1];
    if (left.text === ':' && right.text === ':' && left.end === right.start) operators.push(left.start);
  }
  return operators;
}

function adaptSource(original, staged, references, parameters, arrayConversion) {
  const initial = lexJava(original), proposed = lexJava(staged);
  const initialOperators = referenceOperators(initial.tokens), proposedOperators = referenceOperators(proposed.tokens);
  if (initial.issues.length || proposed.issues.length || initialOperators.length !== proposedOperators.length) {
    throw Error('The Java engine modified the reviewed method references. Inspect this change separately.');
  }
  const identifiers = new Set(proposed.tokens.filter(token => token.kind === 'id').map(token => token.text));
  let counter = 0;
  function freshParameter() {
    let name;
    do { name = 'signatureArgument' + ++counter; } while (identifiers.has(name));
    return name;
  }

  const edits = [];
  for (const reference of references) {
    const adapter = arrayConversion ? reference.arityConversion : reference.adapter;
    const index = initialOperators.findIndex(at => at >= adapter.qualifierEnd && at + 2 <= reference.end);
    if (index < 0) throw Error('The compiler method reference has no exact source operator.');
    const operator = initialOperators[index];
    const text = original.slice(reference.start,reference.end);
    if (original.slice(adapter.qualifierEnd,operator).trim() ||
        original.slice(operator + 2,reference.end).trim() !== adapter.name) {
      throw Error('A method reference contains explicit type syntax or comments requiring separate review.');
    }
    const start = proposedOperators[index] - (operator - reference.start), end = start + text.length;
    if (start < 0 || staged.slice(start,end) !== text || edits.some(edit => edit.end > start && edit.start < end)) {
      throw Error('The selected method reference moved or changed in the Java engine edit.');
    }
    const names = Array.from({length:adapter.arity},freshParameter);
    const receiver = adapter.kind === 'unbound' ? names[0] : adapter.qualifier;
    const selector = adapter.kind === 'constructor' ? 'new ' + receiver : receiver + '.' + adapter.name;
    let args, arrayProof;
    if (arrayConversion) {
      const {fixedCount,component,parameterTypes,returnType}=adapter;
      const reviewed=names.map((source,index)=>({source,type:parameterTypes[index]}));
      const fixed=reviewed.slice(0,fixedCount), initializer=reviewed.slice(fixedCount);
      const arraySource='new '+component+'[] {'+initializer.map(value=>value.source).join(', ')+'}';
      args=[...names.slice(0,fixedCount),arraySource];
      arrayProof={fixedCount,component,selector,returnType,initializer,
        arguments:[...fixed,{source:arraySource,type:component+'[]'}]};
    } else {
      args=parameters.map(parameter=>parameter.originalIndex<0?parameter.defaultValue:names[adapter.receiver+parameter.originalIndex]);
    }
    const header = '(' + names.join(', ') + ') -> ';
    const call = selector + '(' + args.join(', ') + ')';
    edits.push({start,end,header,call,reference,arrayProof});
  }

  let text = '', cursor = 0;
  const adapters = [];
  for (const edit of edits.sort((left,right) => left.start-right.start)) {
    text += staged.slice(cursor,edit.start);
    const lambdaStart = text.length, callStart = lambdaStart + edit.header.length;
    text += edit.header + edit.call;
    adapters.push({...edit.reference,lambdaStart,callStart,callEnd:text.length,arrayProof:edit.arrayProof});
    cursor = edit.end;
  }
  return {text:text+staged.slice(cursor),adapters};
}

function adaptSignatureReferences(original, staged, references, parameters, {arrayConversion=false}={}) {
  const adapters = [], changed = new Map(), grouped = new Map();
  for (const site of references) {
    const list = grouped.get(site.uri) || [];
    list.push(site);
    grouped.set(site.uri,list);
  }
  const originals = new Map(original.map(source => [source.uri,source.text]));
  for (const source of staged) {
    const sites = grouped.get(source.uri);
    if (!sites?.length) continue;
    const updated = adaptSource(originals.get(source.uri),source.text,sites,parameters,arrayConversion);
    changed.set(source.uri,updated.text);
    adapters.push(...updated.adapters);
  }
  if (adapters.length !== references.length) throw Error('Some compiler method references are outside the reviewed sources.');
  return {changed,adapters};
}

function verifyReferenceAdapters(before, after, adapters, mapping) {
  const replacementCalls = new Set(), replacementLambdas = new Set();
  const binding = key => mapping.get(key) || key;
  for (const entry of adapters) {
    const sameOwner = item => item.uri === entry.uri && item.enclosingKey === binding(entry.enclosingKey);
    const calls = after.calls.filter(item => sameOwner(item) && item.start === entry.callStart && item.end === entry.callEnd);
    const lambdas = (after.lambdas || []).filter(item => sameOwner(item) && item.start === entry.lambdaStart && item.end === entry.callEnd);
    if (calls.length !== 1 || calls[0].methodKey !== binding(entry.methodKey) ||
        lambdas.length !== 1 || lambdas[0].targetType !== entry.targetType) {
      throw Error('The method reference adapter changed its overload or functional interface binding.');
    }
    if (entry.arrayProof) {
      const proof=entry.arrayProof, actual=calls[0].arityConversion;
      const matches=(expected,values)=>Array.isArray(values) && expected.length===values.length &&
        expected.every((value,index)=>value.source===values[index].source && value.type===values[index].type);
      if (!actual || actual.mode!=='fixed-array' || actual.selector!==proof.selector || actual.component!==proof.component ||
          actual.fixedCount!==proof.fixedCount || calls[0].resultType!==proof.returnType ||
          !matches(proof.arguments,actual.arguments) || !matches(proof.initializer,actual.initializer)) {
        throw Error('The method reference adapter changed the attributed array arguments or their order.');
      }
    }
    replacementCalls.add(calls[0]);
    replacementLambdas.add(lambdas[0]);
  }

  const ownerKey = item => item.uri+'|'+item.enclosingKey;
  const removedBefore = new Set(adapters.map(site => site.uri+'|'+site.start));
  const comparable = (items,map,method=false) => items.map(item => [item.uri,map(item.enclosingKey),
    method ? map(item.methodKey) : '',item.targetType]);
  const expected = (before.methodReferences || []).filter(site => !removedBefore.has(site.uri+'|'+site.start));
  if (JSON.stringify(comparable(expected,binding,true)) !== JSON.stringify(comparable(after.methodReferences,key=>key,true)) ||
      JSON.stringify(comparable(before.lambdas || [],binding)) !==
      JSON.stringify(comparable((after.lambdas || []).filter(item=>!replacementLambdas.has(item)),key=>key))) {
    throw Error('An unrelated lambda or method reference binding changed.');
  }

  const counts = new Map();
  return after.calls.flatMap(call => {
    const key = ownerKey(call), count = counts.get(key) || 0;
    if (!replacementCalls.has(call)) return [{...call,ordinal:call.ordinal-count}];
    counts.set(key,count+1);
    return [];
  });
}

module.exports = {adaptSignatureReferences,verifyReferenceAdapters};
