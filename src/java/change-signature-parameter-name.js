'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { lexJava } = require('../spring/java');
const { analyzeJavaSources } = require('./signature-compiler');

const physicalKey = uri => {
  const value = path.resolve(fileURLToPath(uri));
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parameterRenameOption(semantic, target, signature) {
  const family = semantic?.family;
  if (!family || target.owner.kind !== 'interface' || family.length < 2 || !signature.parameters.length ||
      family.filter(method => method.ownerKind === 'INTERFACE').length !== 1 || semantic.methodReferences.length ||
      family.some(method => method.generic || method.varargs || method.constructor ||
        method.parameters.length !== signature.parameters.length)) return undefined;
  return { slots: signature.parameters.map((parameter, originalIndex) => ({
    originalIndex, name: parameter.name, type: parameter.type,
    declarations: family.map(method => ({ owner: method.owner, name: method.parameters[originalIndex].name }))
  })) };
}

function parameterRenameChange(record, input, isIdentifier) {
  const option = parameterRenameOption(record.semantic, record.target, record.signature);
  if (!option) throw Error('Select the reviewed interface declaration with a concrete source override family.');
  if (!input || Object.keys(input).some(key => key !== 'originalIndex' && key !== 'name') ||
      !Number.isInteger(input.originalIndex) || !option.slots[input.originalIndex] ||
      typeof input.name !== 'string' || input.name.length > 128 || !isIdentifier(input.name)) {
    throw Error('Choose one existing parameter slot and a valid new Java identifier.');
  }
  const { originalIndex, name } = input, slot = option.slots[originalIndex];
  if (slot.declarations.some(declaration => declaration.name === name)) {
    throw Error('Choose a new parameter name distinct from the current family names.');
  }
  for (const method of record.semantic.family) {
    const source = record.scope.sources.find(item => physicalKey(item.uri) === physicalKey(method.uri));
    if (!source || !Number.isInteger(method.start) || !Number.isInteger(method.end) || method.start < 0 || method.end < method.start) {
      throw Error('The source declaration family is incomplete.');
    }
    const { tokens, issues } = lexJava(source.text.slice(method.start, method.end));
    if (issues.length || tokens.some(token => token.kind === 'id' && token.text === name)) {
      throw Error('The new parameter name conflicts with an existing family declaration or body identifier.');
    }
  }
  for (const source of record.scope.sources) {
    const { tokens } = lexJava(source.text);
    if (tokens.some((token, index) => token.kind === 'id' &&
        ['getParameters', 'getParameterNames', 'isNamePresent'].includes(token.text) && tokens[index + 1]?.text === '(')) {
      throw Error('Review reflective parameter-name contracts separately before renaming this family.');
    }
  }
  return { originalIndex, name, declarations: slot.declarations };
}

async function bind(record, change, sources, cancellation) {
  const result = await analyzeJavaSources({
    ...record.semantic.compilerOptions, cancellation, sources,
    inspection: { kind: 'parameterNameBindings', ordinal: change.originalIndex,
      methods: record.semantic.family.map(method => method.key) }
  });
  const bound = result.parameterNameBindings;
  if (result.errors?.length || !Array.isArray(bound) || bound.length !== record.semantic.family.length) {
    throw Error('Javac could not prove the complete formal parameter binding set.');
  }
  return bound;
}

async function prepareParameterEdits(record, change, engineEdit, targets, projected, positionAt, cancellation) {
  const bound = await bind(record, change, record.scope.sources, cancellation);
  const files = new Map(), byKey = new Map(record.semantic.family.map(method => [method.key, method]));
  for (const binding of bound) {
    const method = byKey.get(binding.key), key = physicalKey(binding.uri);
    if (!method || key !== physicalKey(method.uri) || method.parameters[change.originalIndex].name !== binding.name ||
        !Array.isArray(binding.spans) || binding.spans.filter(span => span.kind === 'declaration').length !== 1) {
      throw Error('The formal parameter binding changed during review.');
    }
    const source = record.scope.sources.find(item => physicalKey(item.uri) === key);
    const saved = record.documents.find(item => physicalKey(item.uri) === key);
    if (!source || !saved || source.text !== saved.text) throw Error('The formal parameter source snapshot changed.');
    if (!files.has(key)) files.set(key, { source, saved, spans: [] });
    for (const span of binding.spans) {
      if (!['declaration', 'reference', 'javadoc'].includes(span.kind) ||
          !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
          span.start < 0 || span.end <= span.start || source.text.slice(span.start, span.end) !== binding.name) {
        throw Error('The compiler returned an incomplete parameter-name source span.');
      }
      files.get(key).spans.push({ ...span, method: binding.key });
    }
  }
  for (const change of engineEdit.documentChanges || []) {
    const saved = files.get(physicalKey(change.textDocument.uri))?.saved;
    if (change.textDocument.version != null && (!saved || saved.version !== change.textDocument.version)) {
      throw Error('The Java engine parameter edit is based on a different buffer version.');
    }
  }
  const anchor = [...byKey.values()].find(method => physicalKey(method.uri) === physicalKey(record.anchor.uri) &&
    method.nameStart === record.target.method.start);
  for (const [uri, edits] of targets) {
    if (edits.length && !files.has(physicalKey(uri))) {
      throw Error('The Java engine edited a caller or an unrelated source during parameter rename.');
    }
    if (edits.some(edit => edit.annotationId)) throw Error('Annotated Java engine parameter edits require separate review.');
  }
  // The provider can group several source replacements into one text edit. Compare its resulting
  // bytes against the original chunks and the exact old/new spelling at each approved binding.
  const projection = new Map(projected.map(source => [physicalKey(source.uri), source.text]));
  let providerSpans = 0, anchorDeclarationProven = false;
  for (const [key, file] of files) {
    const spans = file.spans.sort((a, b) => a.start - b.start), prior = file.source.text, proposed = projection.get(key);
    let position = spans[0].start;
    if (typeof proposed !== 'string' || !proposed.startsWith(prior.slice(0, position))) {
      throw Error('The Java engine changed more than a bound formal parameter or its exact uses.');
    }
    for (const [index, span] of spans.entries()) {
      const next = spans[index + 1]?.start ?? prior.length;
      if (span.end > next) throw Error('The compiler returned overlapping formal parameter spans.');
      const unchanged = prior.slice(span.end, next), oldName = prior.slice(span.start, span.end);
      const retained = proposed.startsWith(oldName + unchanged, position);
      const renamed = proposed.startsWith(change.name + unchanged, position);
      if (retained === renamed) throw Error('The Java engine changed more than a bound formal parameter or its exact uses.');
      if (renamed) {
        providerSpans++;
        if (span.kind === 'declaration' && span.method === anchor?.key) anchorDeclarationProven = true;
      }
      position += (renamed ? change.name.length : oldName.length) + unchanged.length;
    }
    if (position !== proposed.length) throw Error('The Java engine changed more than a bound formal parameter or its exact uses.');
  }
  if (!anchorDeclarationProven) throw Error('The Java engine did not rename the reviewed interface formal parameter.');

  const verifiedSpans = new Map(), changes = {};
  let references = 0, javadoc = 0;
  for (const file of files.values()) {
    const spans = file.spans.sort((a, b) => a.start - b.start);
    let shift = 0;
    changes[file.saved.uri] = spans.map(span => {
      const afterStart = span.start + shift;
      shift += change.name.length - (span.end - span.start);
      if (!verifiedSpans.has(span.method)) verifiedSpans.set(span.method, []);
      verifiedSpans.get(span.method).push([span.kind, afterStart, afterStart + change.name.length]);
      references += Number(span.kind === 'reference');
      javadoc += Number(span.kind === 'javadoc');
      return { newText: change.name, range: { start: positionAt(file.source.text, span.start), end: positionAt(file.source.text, span.end) } };
    });
  }
  return { edit: { changes }, verifiedSpans, references, javadoc, providerSpans };
}

async function verifyParameterEdits(record, change, result, sources, cancellation) {
  const bound = await bind(record, change, sources, cancellation);
  const original = new Map(record.semantic.family.map(method => [method.key, method.uri]));
  const processed = new Set();
  for (const binding of bound) {
    const uri = original.get(binding.key), expected = result.verifiedSpans.get(binding.key);
    const spans = binding.spans.map(span => [span.kind, span.start, span.end]).sort((a, b) => a[1] - b[1]);
    if (!expected || !uri || processed.has(binding.key) || physicalKey(uri) !== physicalKey(binding.uri) ||
        binding.name !== change.name || !equal(expected, spans)) {
      throw Error('A renamed parameter use no longer binds to the reviewed formal parameter.');
    }
    processed.add(binding.key);
  }
  if (processed.size !== original.size) throw Error('The renamed parameter family is incomplete.');
}

module.exports = { parameterRenameOption, parameterRenameChange, prepareParameterEdits, verifyParameterEdits };
