'use strict';

const { fileURLToPath } = require('node:url');
const path = require('node:path');
const { lexJava } = require('../spring/java');

const descriptors = Object.freeze({
  void: 'V', boolean: 'Z', byte: 'B', short: 'S', char: 'C', int: 'I', long: 'J', float: 'F', double: 'D',
  String: 'Ljava/lang/String;', 'java.lang.String': 'Ljava/lang/String;',
  Object: 'Ljava/lang/Object;', 'java.lang.Object': 'Ljava/lang/Object;'
});
const canonical = type => ['String', 'Object'].includes(type) ? 'java.lang.' + type : type;
const knownType = type => Object.hasOwn(descriptors, type);
const uriKey = uri => {
  const file = path.resolve(fileURLToPath(uri));
  return process.platform === 'win32' ? file.replace(/^[a-z]:/u, drive => drive.toUpperCase()) : file;
};
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);

function completeReferences(method, calls, references, documents, offset) {
  if (calls.length !== references.length) return false;
  const known = new Map(documents.map(document => [uriKey(document.uri), document.text]));
  const used = new Set();
  for (const reference of references) {
    const file = uriKey(reference.uri), source = known.get(file);
    if (!source) return false;
    const start = offset(source, reference.range.start), end = offset(source, reference.range.end);
    const nameEnd = start + method.name.length;
    if (source.slice(start, nameEnd) !== method.name || !/^\s*\(/u.test(source.slice(nameEnd))) return false;
    const matched = calls.map((call, index) => ({ call, index })).filter(({ call }) =>
      uriKey(call.uri) === file && start >= call.start && nameEnd < call.end &&
      (end === nameEnd || end === call.end));
    if (matched.length !== 1 || used.has(matched[0].index)) return false;
    used.add(matched[0].index);
  }
  return true;
}

function compatibilityOption(record, offset) {
  const { semantic, target, signature, anchor, documents, observedReferences } = record;
  const method = semantic?.family[0];
  if (!method || !semantic.compatibilityProject || documents.some(item => item.document.isDirty) ||
      semantic.family.length !== 1 || method.constructor || method.ownerKind !== 'CLASS' ||
      method.generic || method.varargs || method.annotations.length || !same(method.ownerSupertypes,['java.lang.Object']) || method.parameters.some(parameter => parameter.annotated) ||
      !same(method.modifiers, ['public', 'static']) || method.throwsTypes.length ||
      semantic.methodReferences.length || target.owner.annotations.length || target.owner.superTypes.length ||
      !target.throwsSpan || !knownType(method.returnType) || method.parameters.length >= 30 ||
      method.parameters.some(parameter => !knownType(parameter.erasure) || parameter.erasure === 'void') ||
      semantic.before.methods.filter(item => item.owner === method.owner && item.name === method.name).length !== 1 ||
      !completeReferences(method, semantic.calls, observedReferences, documents, offset)) return;
  const tokens = lexJava(anchor.text).tokens;
  const at = tokens.findIndex(token => token.start === target.owner.start);
  if (at < 3 || tokens[at - 1].text !== 'class' ||
      !same(tokens.slice(at - 3, at - 1).map(token => token.text).sort(), ['final', 'public'])) return;
  const declaration = anchor.text.slice(method.start, target.throwsSpan.start);
  const close = target.throwsSpan.start - 1;
  const lineStart = anchor.text.lastIndexOf('\n', method.start - 1) + 1;
  const lineEnd = anchor.text.indexOf('\n', method.end);
  const indentation = anchor.text.slice(lineStart, method.start);
  if (!declaration.endsWith(')') || !/^[ \t]*$/u.test(indentation) ||
      !/^[ \t\r]*$/u.test(anchor.text.slice(method.end, lineEnd < 0 ? anchor.text.length : lineEnd)) ||
      anchor.text[method.end - 1] !== '}' || /\/[*/]/u.test(declaration) ||
      signature.parameters.some(parameter => !knownType(parameter.type) || parameter.type === 'void')) return;
  return {
    method, close, declaration, indentation,
    descriptor: '(' + method.parameters.map(parameter => descriptors[parameter.erasure]).join('') + ')' + descriptors[method.returnType]
  };
}

function compatibilityChange(record, input, { offset, identifier, scalar }) {
  const eligible = compatibilityOption(record, offset);
  if (!eligible) throw Error('Retaining the old signature requires one plain public static method with exact direct caller coverage.');
  if (!input || !same(Object.keys(input).sort(), ['defaultValue', 'name', 'type']) ||
      !identifier(input.name) || !knownType(input.type) || input.type === 'void' || !scalar(input.defaultValue, input.type)) {
    throw Error('Enter one new scalar parameter name, type and a compatible literal default.');
  }
  if (record.target.bodyTokens.some(token => token.kind === 'id' && token.text === input.name) ||
      eligible.method.parameters.some(parameter => parameter.name === input.name)) {
    throw Error('The new parameter name conflicts with an existing parameter or method-body identifier.');
  }
  const parameter = { originalIndex: -1, name: input.name, type: input.type, defaultValue: input.defaultValue };
  const literal = ['byte', 'short'].includes(input.type) ? '(' + input.type + ') ' + input.defaultValue : input.defaultValue;
  const old = eligible.descriptor, close = old.indexOf(')');
  return {
    ...eligible, parameter, literal,
    newDescriptor: old.slice(0, close) + descriptors[input.type] + old.slice(close),
    newKey: eligible.method.owner + '#' + eligible.method.name + '(' +
      [...eligible.method.parameters.map(value => value.type), canonical(input.type)].join(',') + ')'
  };
}

function compatibilityEdits(record, change, positionAt) {
  const documents = new Map(record.documents.map(doc => [uriKey(doc.uri), doc]));
  const changes = {};
  function insert(uri, at, newText, expected) {
    const doc = documents.get(uriKey(uri));
    if (!doc || !Number.isSafeInteger(at) || at < 0 || at > doc.text.length ||
        doc.text[expected === '}' ? at - 1 : at] !== expected) {
      throw Error('The reviewed signature or call has no exact insertion point.');
    }
    const position = positionAt(doc.text, at);
    (changes[doc.uri] ??= []).push({ range: { start: position, end: position }, newText });
  }
  const { method, parameter, literal, declaration, indentation } = change;
  const separator = method.parameters.length ? ', ' : '';
  insert(method.uri, change.close, separator + parameter.type + ' ' + parameter.name, ')');
  for (const call of record.semantic.calls) insert(call.uri, call.end - 1, separator + literal, ')');
  const argumentsList = [...method.parameters.map(value => value.name), literal];
  const call = method.owner + '.' + method.name + '(' + argumentsList.join(', ') + ')';
  const newline = record.anchor.text.includes('\r\n') ? '\r\n' : '\n';
  const body = (method.returnType === 'void' ? '' : 'return ') + call + ';';
  insert(method.uri, method.end, newline + newline + indentation + declaration +
    ' {' + newline + indentation + '    ' + body + newline + indentation + '}', '}');
  return { edit: { changes }, call };
}

function verifyCompatibility(after, sources, change, forwarder) {
  if (after.errors.length) throw Error('Compatibility overload conflict: ' + after.errors[0].message);
  const { method } = change;
  const wrappers = after.methods.filter(item => item.key === method.key);
  if (wrappers.length !== 1) throw Error('The old method descriptor must remain in the declaring class.');
  const wrapper = wrappers[0];
  const wrapperParameters = value => value.parameters.map(parameter => [parameter.name, parameter.type, parameter.erasure]);
  if (wrapper.uri !== method.uri || wrapper.returnType !== method.returnType || wrapper.erasureKey !== method.erasureKey ||
      !same(wrapperParameters(wrapper), wrapperParameters(method)) || !same(wrapper.modifiers, method.modifiers) ||
      !same(wrapper.throwsTypes, method.throwsTypes) || wrapper.annotations.length || wrapper.generic || wrapper.varargs) {
    throw Error('The old method signature or accessibility changed.');
  }
  const calls = after.calls.filter(call => call.enclosingKey === method.key);
  const source = sources.find(unit => unit.uri === wrapper.uri);
  if (!source || calls.length !== 1 || calls[0].methodKey !== change.newKey ||
      calls[0].uri !== wrapper.uri || source.text.slice(calls[0].start, calls[0].end) !== forwarder ||
      calls[0].start < wrapper.start || calls[0].end > wrapper.end) {
    throw Error('The old descriptor does not forward once to the reviewed overload and literal.');
  }
  return { ...after, methods: after.methods.filter(item => item !== wrapper),
    calls: after.calls.filter(item => item !== calls[0]) };
}

module.exports = { compatibilityOption, compatibilityChange, compatibilityEdits, verifyCompatibility };
