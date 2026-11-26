'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { analyzeJavaSources } = require('./signature-compiler');
const { editedSources, verifySemanticChange } = require('./change-signature');

const uriKey = uri => {
  const file = path.resolve(fileURLToPath(uri));
  return process.platform === 'win32' ? file.replace(/^[a-z]:/u, drive => drive.toUpperCase()) : file;
};
const slotSeparator = /^(?:[ \t\r\n]*,[ \t\r\n]*)$/u;

function deletion(source, slots, ordinal) {
  if (!Array.isArray(slots) || ordinal < 0 || ordinal >= slots.length ||
      slots.some(({ start, end }, index) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < (slots[index - 1]?.end || 0) || end <= start || end > source.length)) {
    throw Error('The compiler did not provide exact constructor slot ranges.');
  }
  const selected = slots[ordinal];
  if (slots.length === 1) return selected;
  const next = slots[ordinal + 1];
  const previous = slots[ordinal - 1];
  const gap = next ? source.slice(selected.end, next.start) : source.slice(previous.end, selected.start);
  if (!slotSeparator.test(gap)) throw Error('A comment or nonstandard separator borders the removed constructor slot.');
  return next ? { start: selected.start, end: next.start } : { start: previous.end, end: selected.end };
}

function constructorEvidence(before, uri, caret, nameStart, nameEnd) {
  if (before.errors.length) throw Error('The saved project must compile before constructor parameter Safe Delete: ' + before.errors[0].message);
  const evidence = before.constructorParameter;
  const failure = {
    'no-exact-parameter': 'Select the name of a constructor parameter to review its deletion.',
    'unsupported-constructor': 'Safe Delete requires a plain private top-level constructor without a generic, inherited or varargs contract.',
    'annotated-constructor': 'A Spring, injection or other annotated constructor, owner or parameter is protected.',
    'overloaded-constructor': 'Overloaded constructors require a separate Safe Delete binding analysis.'
  };
  if (evidence?.state !== 'attributed') throw Error(failure[evidence?.state] || 'The compiler did not establish constructor parameter coverage.');
  const matching = before.methods.filter(method => method.constructor && method.key === evidence.key &&
    uriKey(method.uri) === uriKey(uri) && method.nameStart === nameStart && nameEnd === nameStart + method.name.length);
  if (matching.length !== 1) throw Error('JDT and javac disagree about the selected constructor declaration.');
  const method = matching[0], param = method.parameters[evidence.ordinal];
  const declaration = evidence.binding.spans.filter(span => span.kind === 'declaration');
  if (!param || declaration.length !== 1 || caret < declaration[0].start || caret > declaration[0].end) {
    throw Error('Select the exact name of an unused constructor parameter.');
  }
  if (param.used || evidence.binding.spans.some(span => span.kind === 'reference')) {
    throw Error('The constructor parameter is used by the attributed Java source.');
  }
  if (evidence.binding.spans.some(span => span.kind === 'javadoc')) {
    throw Error('The constructor parameter has a Javadoc contract. Review that documentation first.');
  }
  if (before.methodReferences.some(reference => reference.methodKey === method.key)) {
    throw Error('Constructor method references require a separate adaptation review.');
  }
  const calls = before.calls.filter(call => call.methodKey === method.key);
  const key = call => JSON.stringify([uriKey(call.uri), call.start, call.end]);
  const actual = new Set(evidence.calls.map(key));
  if (calls.length > 200 || actual.size !== calls.length || calls.some(call => !call.constructor || !actual.has(key(call))) ||
      evidence.calls.some(call => !call.direct || !call.safeRemoved || call.arguments.length !== method.parameters.length)) {
    throw Error('A constructor call is unresolved or its removed argument may have side effects or a throwing conversion.');
  }
  return { name: param.name, method, declaration: declaration[0], evidence, calls };
}

function checkReferences(refs, saved, selection, { uri, nameStart, nameEnd }) {
  if (!Array.isArray(refs) || refs.length !== selection.calls.length + 1) {
    throw Error('JDT and javac disagree about constructor reference coverage.');
  }
  const matched = new Set();
  for (const ref of refs) {
    const source = saved.get(uriKey(ref.uri));
    if (!source) throw Error('A constructor reference is outside the reviewed Java sources.');
    const start = source.offset(ref.range.start), end = source.offset(ref.range.end);
    const declarations = uriKey(ref.uri) === uriKey(uri) && start === nameStart && end >= nameEnd && end <= selection.evidence.end;
    const callers = selection.evidence.calls.map((call, index) => ({ call, index })).filter(({ call }) =>
      uriKey(ref.uri) === uriKey(call.uri) && start >= call.start && start < call.arguments[0].start && end <= call.end);
    const match = declarations && !callers.length ? 'declaration' : !declarations && callers.length === 1 ? callers[0].index : undefined;
    if (match === undefined || end <= start || matched.has(match)) throw Error('JDT and javac disagree about a constructor source reference.');
    matched.add(match);
  }
}

async function inspectConstructorParameter({ anchor, selection, sources, runtime, send, cancellation, offset, position, root }) {
  const uri = anchor.uri;
  async function environment() {
    const classpaths = await send('workspace/executeCommand',
      { command: 'java.project.getClasspaths', arguments: [uri, { scope: 'test' }] }, cancellation);
    const settings = await send('workspace/executeCommand', { command: 'java.project.getSettings', arguments: [uri,
      ['org.eclipse.jdt.core.compiler.source', 'org.eclipse.jdt.core.compiler.compliance']] }, cancellation);
    if (!classpaths?.projectRoot || path.relative(fs.realpathSync(fileURLToPath(classpaths.projectRoot)), root) ||
        !Array.isArray(classpaths.classpaths) || classpaths.modulepaths?.length) {
      throw Error('Import the exact nonmodular Java project with an observed test classpath before Safe Delete.');
    }
    const rawRelease = settings?.['org.eclipse.jdt.core.compiler.source'] || settings?.['org.eclipse.jdt.core.compiler.compliance'];
    const release = Number(String(rawRelease).replace(/^1\./u, ''));
    const external = classpaths.classpaths.filter(file => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Choose a bounded observed local Java compiler classpath.');
      if (!fs.existsSync(file)) return false;
      const relative = path.relative(root, fs.realpathSync(file));
      return relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || file.endsWith('.jar');
    });
    const options = { ...runtime(), classpath: external, release, cancellation };
    return { options, anchor: JSON.stringify([classpaths, release, options.javaHome, options.storagePath]) };
  }
  const config = await environment();
  const java = sources.filter(source => /\.java$/iu.test(source.uri));
  const saved = new Map(java.map(source => [uriKey(source.uri), { ...source, offset: point => offset(source.text, point) }]));
  if (saved.size !== java.length) throw Error('Java source identities are ambiguous.');
  const anchorSource = saved.get(uriKey(uri));
  if (!anchorSource) throw Error('The constructor declaration is outside the reviewed Java sources.');
  const source = anchorSource.text;
  const state = { uri, nameStart: offset(source, selection.symbol.start), nameEnd: offset(source, selection.symbol.end) };
  const before = await analyzeJavaSources({ ...config.options, sources: java, inspection: {
    kind: 'constructorParameterDelete', uri: anchorSource.uri, offset: selection.caret
  } });
  const target = constructorEvidence(before, uri, selection.caret, state.nameStart, state.nameEnd);
  const parameterRange = { start: position(source, target.declaration.start), end: position(source, target.declaration.end) };
  const references = (cursor, includeDeclaration) => send('textDocument/references', { textDocument: { uri },
    position: cursor, context: { includeDeclaration } }, cancellation);
  async function checkBindings() {
    const paramRefs = await references(parameterRange.start, false);
    if (!Array.isArray(paramRefs) || paramRefs.length !== 0) {
      throw Error('JDT did not confirm that the selected constructor parameter has no callers or uses.');
    }
    checkReferences(await references(selection.symbol.start, true), saved, target, state);
  }
  await checkBindings();

  const edits = new Map();
  function add(address, slots) {
    const unit = saved.get(uriKey(address));
    if (!unit) throw Error('A constructor caller is outside the reviewed Java source scope.');
    const span = deletion(unit.text, slots, target.evidence.ordinal);
    const removed = unit.text.slice(slots[target.evidence.ordinal].start, slots[target.evidence.ordinal].end);
    if (address === anchorSource.uri && slots === target.evidence.formals && /\/[*/]/u.test(removed)) {
      throw Error('A source comment belongs to the selected constructor parameter.');
    }
    const edit = { range: { start: position(unit.text, span.start), end: position(unit.text, span.end) }, newText: '' };
    if (!edits.has(unit.uri)) edits.set(unit.uri, []);
    edits.get(unit.uri).push(edit);
  }
  add(uri, target.evidence.formals);
  for (const call of target.evidence.calls) add(call.uri, call.arguments);
  const after = await analyzeJavaSources({ ...config.options, sources: editedSources(java, edits) });
  if (after.classpathFingerprint !== before.classpathFingerprint) {
    throw Error('The Java compiler runtime or classpath changed during constructor review.');
  }
  const remaining = target.method.parameters.map((param, originalIndex) => ({ ...param, originalIndex }))
    .filter(param => param.originalIndex !== target.evidence.ordinal);
  verifySemanticChange({ before, family: [target.method], keys: new Set([target.method.key]), calls: target.calls }, after, remaining);

  return { candidate: { kind: 'constructor-parameter', name: target.name, constructorName: target.method.name,
    owner: target.method.owner, start: target.evidence.start, end: target.evidence.end,
    declarationRange: parameterRange, constructorRange: selection.symbol, eligibilityConflicts: [] },
  edit: { changes: Object.fromEntries(edits) }, callerCount: target.calls.length,
  preApply() { before.validateClasspath(); },
  async validate() {
    if ((await environment()).anchor !== config.anchor) throw Error('The observed Java compiler configuration changed after Safe Delete review.');
    await checkBindings();
    before.validateClasspath();
  } };
}

module.exports = { inspectConstructorParameter };
