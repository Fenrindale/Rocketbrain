'use strict';

const {isDeepStrictEqual:equal} = require('node:util');
const {lexJava,rangeAt} = require('../spring/java');

const KIND = 'refactor.move.innerClass';
const guardPrefix = 'java.util.Objects.requireNonNull(';
const comparableTokens = text => {
  const {tokens,issues} = lexJava(text);
  if (issues.length) throw Error('The Java move requires ordinary source tokens.');
  return tokens.map(token => token.text);
};

function checkedMove(report,member) {
  if (!report?.supported || report.member !== member) {
    throw Error(member ?
      'Choose a regular non-static inner class with one explicit constructor and a supported enclosing-instance contract.' :
      'The proposed top-level class could not be attributed with the same enclosing-instance contract.');
  }
  if (report.destinationOccupied) throw Error('A Java type with the destination name already exists.');
  return report;
}

function methodContracts(methods) {
  return methods.map(method => ({...method,body:comparableTokens(method.body)}))
    .sort((left,right) => left.name.localeCompare(right.name) ||
      JSON.stringify(left.parameters).localeCompare(JSON.stringify(right.parameters)));
}

function unchangedOutsideMove(text,{spans}) {
  let end = 0;
  const parts = [];
  for (const span of [...spans].sort((a,b) => a.start-b.start || b.end-a.end)) {
    if (span.end <= end) continue;
    if (span.start < end || span.end > text.length) throw Error('Attributed Java caller spans overlap unexpectedly.');
    parts.push(text.slice(end,span.start),' ',span.symbol,' ');
    end = span.end;
  }
  return comparableTokens(parts.join('') + text.slice(end));
}

function compareMove({before,after,original,updated,nullChecks}) {
  if (before.owner !== after.owner || before.name !== after.name ||
      !equal(before.modifiers,after.modifiers) || !equal(before.fields,after.fields) ||
      !equal(methodContracts(before.methods),methodContracts(after.methods)) || !equal(before.uses,after.uses)) {
    throw Error('The proposed move changes an attributed member, type use or enclosing-instance binding.');
  }
  const fixes = new Map();
  let qualified = 0;
  for (const source of updated) {
    const prior = before.callers[source.uri], current = after.callers[source.uri];
    if (!prior || !current || !equal(prior.bindings,current.bindings) ||
        !equal(unchangedOutsideMove(original.get(source.uri).text,prior),unchangedOutsideMove(source.text,current))) {
      throw Error('The proposed move changes unrelated Java source or a caller binding.');
    }
    const positionOrder = (a,b) => a.start-b.start;
    const oldCalls = before.calls.filter(call => call.uri === source.uri).sort(positionOrder);
    const newCalls = after.calls.filter(call => call.uri === source.uri).sort(positionOrder);
    if (oldCalls.length !== newCalls.length) throw Error('The proposed move changes Java constructor caller membership.');
    let previous = 0;
    for (const [index,old] of oldCalls.entries()) {
      const next = newCalls[index], [owner,...argumentsInOrder] = next.arguments;
      // A nested construction would require overlapping caller substitutions.
      if (old.start < previous || !owner || next.qualifier) {
        throw Error('Nested Java constructor calls are outside this inner-class move.');
      }
      previous = old.end;
      const explicit = Boolean(old.qualifier);
      const qualifier = old.qualifier?.text ?? 'this';
      const wantedOwner = nullChecks && explicit ? guardPrefix + qualifier + ')' : qualifier;
      const observedOwner = next.guardedOwner ?? owner;
      const argumentTypes = args => args.map(arg => arg.type);
      if (explicit && old.qualifier.type !== observedOwner.type ||
          !equal(argumentTypes(old.arguments),argumentTypes(argumentsInOrder)) ||
          !equal(comparableTokens(wantedOwner),comparableTokens(owner.text)) ||
          !equal(old.arguments.map(arg => comparableTokens(arg.text)),argumentsInOrder.map(arg => comparableTokens(arg.text))) ||
          next.ownerNullChecked !== Boolean(nullChecks && explicit)) {
        throw Error('The proposed move changes constructor ownership, argument order or its null-check contract.');
      }
      if (explicit) {
        qualified++;
        if (!nullChecks) {
          if (!fixes.has(source.uri)) fixes.set(source.uri,[]);
          fixes.get(source.uri).push(owner);
        }
      }
    }
  }
  return {fixes,qualified};
}

function oneReplacement(before,after) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd-1] === after[newEnd-1]) {
    oldEnd--;
    newEnd--;
  }
  if (before[start-1] === '\r' && before[start] === '\n') start--;
  if (before[oldEnd-1] === '\r' && before[oldEnd] === '\n') {
    oldEnd++;
    newEnd++;
  }
  return {range:rangeAt(before,start,oldEnd),newText:after.slice(start,newEnd)};
}

function preserveQualifiedNullCheck(plan,original,fixes) {
  const updated = plan.updated.map(source => {
    let text = source.text;
    for (const span of [...fixes.get(source.uri) || []].reverse()) {
      if (text.slice(span.start,span.end) !== span.text || span.end <= span.start) {
        throw Error('The attributed enclosing expression no longer matches the proposed caller.');
      }
      text = text.slice(0,span.start) + guardPrefix + span.text + ')' + text.slice(span.end);
    }
    return {...source,text};
  });
  return {...plan,updated,edit:{documentChanges:plan.edit.documentChanges.map(change => {
    const uri = change.textDocument.uri;
    return fixes.has(uri) ? {...change,edits:[oneReplacement(original.get(uri).text,updated.find(source => source.uri === uri).text)]} : change;
  })}};
}

module.exports = {KIND,checkedMove,compareMove,preserveQualifiedNullCheck};
