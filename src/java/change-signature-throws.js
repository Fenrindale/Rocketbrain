'use strict';

const { fileURLToPath } = require('node:url');
const path = require('node:path');

const maximumTypes = 8;
const typeName = '[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*';
const qualified = new RegExp('^' + typeName + '$', 'u');
const clausePattern = new RegExp('^\\s*(?:throws\\s+(' + typeName + '(?:\\s*,\\s*' + typeName + ')*))?\\s*$', 'u');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function checkedThrowsOption(semantic, target, signature) {
  const method = semantic?.family[0], span = target.throwsSpan;
  if (!method || semantic.family.length !== 1 || method.constructor || method.ownerKind !== 'CLASS' ||
      !method.modifiers.includes('private') || method.annotations.length || method.generic || method.varargs ||
      semantic.methodReferences.length || !span || !Array.isArray(method.checkedThrows) ||
      method.checkedThrows.length > maximumTypes || !equal(method.throwsTypes, method.checkedThrows) ||
      !Array.isArray(signature.exceptions) ||
      !equal(signature.exceptions.map(item => item?.type), method.checkedThrows)) return undefined;
  const before = method.checkedThrows;
  const match = clausePattern.exec(target.text.slice(span.start, span.end));
  if (!match || (match[1]?.split(',').length || 0) !== before.length || before.some(value => !value.includes('.'))) return undefined;
  return { before: [...before] };
}

function checkedThrowsChange(record, input) {
  const option = checkedThrowsOption(record.semantic, record.target, record.signature);
  if (!option) {
    throw Error('Checked exceptions require one concrete private non-generic method with an editable throws clause and direct callers.');
  }
  if (!Array.isArray(input) || input.length > maximumTypes || new Set(input).size !== input.length ||
      input.some(type => typeof type !== 'string' || type.length > 240 || !type.includes('.') || !qualified.test(type))) {
    throw Error('Use up to eight distinct fully qualified checked exception class names.');
  }
  if (equal(input, option.before)) throw Error('The signature has no checked exception changes.');
  const exceptions = input.map(type => record.signature.exceptions.find(item => item.type === type) || { type });
  return { ...option, after: [...input], exceptions };
}

function verifyCheckedThrowsEdits(record, targets, sources, change, offset) {
  const file = fileURLToPath(record.anchor.uri), span = record.target.throwsSpan;
  for (const [value, edits] of targets) {
    if (!edits.length) continue;
    if (path.relative(file, fileURLToPath(value)) || edits.some(({ range }) =>
      offset(record.anchor.text, range?.start) < span.start || offset(record.anchor.text, range?.end) > span.end)) {
      throw Error('The Java engine changed more than the reviewed checked exceptions. Import the type explicitly if needed.');
    }
  }
  const projected = sources.find(source => !path.relative(file, fileURLToPath(source.uri)));
  const suffixLength = record.anchor.text.length - span.end;
  const tail = projected?.text.slice(span.start, projected.text.length - suffixLength);
  const clause = tail === undefined ? null : clausePattern.exec(tail);
  if (!clause || (clause[1]?.split(',').length || 0) !== change.after.length) {
    throw Error('The Java engine did not produce a plain checked exception clause.');
  }
}

module.exports = { checkedThrowsOption, checkedThrowsChange, verifyCheckedThrowsEdits };
