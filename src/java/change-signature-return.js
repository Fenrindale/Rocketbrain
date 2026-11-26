'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const referenceName = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function eligibleNarrowing(semantic, target, signature) {
  const method = semantic?.family[0], contract = method?.returnContract;
  if (!method || semantic.family.length !== 1 || method.constructor || method.ownerKind !== 'CLASS' ||
      !method.modifiers.includes('private') || method.annotations.length || method.generic || method.varargs ||
      semantic.methodReferences.length || !contract || !method.returnType.includes('.') ||
      !referenceName.test(method.returnType)) return undefined;
  if (semantic.calls.some(call => call.resultType !== method.returnType ||
      !call.returnConsumer || call.returnConsumer.kind !== 'discarded' && call.returnConsumer.type !== method.returnType)) {
    return undefined;
  }
  const spelled = target.text.slice(contract.start, contract.end);
  if (!referenceName.test(spelled) || signature.returnType !== spelled && signature.returnType !== method.returnType) return undefined;
  return { before: method.returnType, key: method.key, span: { start: contract.start, end: contract.end } };
}

function narrowedReturnChange(record, input) {
  const option = eligibleNarrowing(record.semantic, record.target, record.signature);
  if (!option) {
    throw Error('Return narrowing requires a concrete private reference-returning method with stable explicitly typed callers.');
  }
  if (typeof input !== 'string' || input.length > 240 || !input.includes('.') || !referenceName.test(input)) {
    throw Error('Use the fully qualified name of a reference return type.');
  }
  if (option.before === input) throw Error('The return type has not changed.');
  return { ...option, after: input };
}

function verifyNarrowedReturnEdits(record, targets, sources, change, offset) {
  const file = fileURLToPath(record.anchor.uri), span = change.span;
  for (const [value, edits] of targets) {
    if (!edits.length) continue;
    if (path.relative(file, fileURLToPath(value)) || edits.some(({ range }) =>
      offset(record.anchor.text, range?.start) < span.start || offset(record.anchor.text, range?.end) > span.end)) {
      throw Error('The Java engine changed more than the reviewed return type.');
    }
  }
  const projected = sources.find(source => !path.relative(file, fileURLToPath(source.uri)));
  const suffixLength = record.anchor.text.length - span.end;
  const type = projected?.text.slice(span.start, projected.text.length - suffixLength);
  if (!type || !referenceName.test(type)) throw Error('The Java engine did not produce a plain reference return type.');
}

function verifyNarrowedDeclaration(before, after, change) {
  const contract = after.returnContract;
  if (!contract?.supertypes.includes(change.before)) {
    throw Error('The new return type must be a strict Java reference subtype of the original.');
  }
  if (!equal(before.returnContract.expressions, contract.expressions)) {
    throw Error('The new return type changes attribution inside the method body.');
  }
}

function verifyNarrowedCallers(before, after, change) {
  const contexts = calls => calls.filter(call => call.methodKey === change.key).map(call =>
    JSON.stringify([call.uri, call.enclosingKey, call.ordinal, call.returnConsumer])).sort();
  if (!equal(contexts(before), contexts(after))) {
    throw Error('The new return type changes a caller result context.');
  }
}

module.exports = { eligibleNarrowing, narrowedReturnChange, verifyNarrowedReturnEdits,
  verifyNarrowedDeclaration, verifyNarrowedCallers };
