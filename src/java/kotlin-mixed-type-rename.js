'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { lexJava, rangeAt, matching } = require('../spring/java');
const { editedText } = require('./refactoring');
const { exactEntries, verifyProspectiveSpans } = require('./java-type-rename');
const { offsetsForClassRename, sourceKey, sourceSpan, sameRange } = require('./kotlin-rename');
const { kotlinProtocolUri } = require('./kotlin-editor-runtime');
const { validIdentifier } = require('./file-templates');
const { packageName, fail } = require('./workbench-model');
const { analyzeJavaSources } = require('./signature-compiler');
const { isMain, reviewedClasspath, compileMixedKotlin, withMixedClasspath } = require('./kotlin-mixed-compilation');

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const extendedClassKinds = new Set(['private','protected','internal','annotation','value','data','enum','sealed','expect','actual']);

function classCandidate(files, uri, position, root) {
  if (![...files.values()].some(source => source.file.endsWith('.java') && isMain(root, source.file))) return;
  const file = files.get(sourceKey(uri));
  if (!file || !isMain(root, file.file)) return;
  const { range, start, end } = offsetsForClassRename(file.text, position);
  const oldName = file.text.slice(start, end);
  const prefix = file.text.slice(0, start).split('\n').at(-1);
  if (!identifier.test(oldName) || !/^\s*(?:public\s+)?class\s+$/u.test(prefix || '')) return;
  const { tokens, issues } = lexJava(file.text);
  const index = tokens.findIndex(token => token.start === start && token.end === end);
  let depth = 0;
  for (const token of tokens.slice(0, index)) {
    if (token.text === '{' && token.kind === 'symbol') depth++;
    if (token.text === '}' && token.kind === 'symbol') depth--;
  }
  const preceding = tokens[index - 2];
  if (index < 1 || issues.length || depth !== 0 || tokens.some(token => token.text === '@' && token.kind === 'symbol') ||
      extendedClassKinds.has(preceding?.text)) {
    throw fail('Select an ordinary unannotated public top-level Kotlin class.');
  }
  const namespace = packageName(file.text, 'kotlin');
  if (!namespace || /^(?:java|kotlin)(?:\.|$)/u.test(namespace) ||
      !namespace.split('.').every(part => identifier.test(part))) {
    throw fail('Use a reviewed Kotlin class in an ordinary named JVM package.');
  }
  const close = tokens[index + 1]?.text === '(' ? matching(tokens,index + 1) : -1;
  const constructor = close < 0 ? undefined : rangeAt(file.text,tokens[index + 1].start,tokens[close].end);
  return { file, range, start, end, constructor, id: file.key + '\0' + start + '\0' + end, oldName, namespace };
}

function reviewContracts(root, sources, selection, newName) {
  if(!validIdentifier(newName)||newName.toLowerCase()===selection.oldName.toLowerCase()){
    throw fail('Choose a different JVM class identifier. Case-only names require a separate review.');
  }
  const whole = new RegExp('(?<![\\p{L}\\p{N}_$])' + selection.oldName + '(?![\\p{L}\\p{N}_$])', 'u');
  const proposed = new RegExp('(?<![\\p{L}\\p{N}_$])' + newName + '(?![\\p{L}\\p{N}_$])', 'u');
  for (const source of sources.values()) {
    if (!isMain(root, source.file)) {
      if (whole.test(source.text) || path.basename(source.file) === selection.namespace + '.' + selection.oldName) {
        throw fail('A test, build or resource declaration uses this name. Review that JVM contract separately.');
      }
      if (/\.(?:gradle(?:\.kts)?|toml)$/u.test(source.file) &&
          /\b(?:kapt|ksp|annotationProcessor|compilerOptions|kotlinOptions|freeCompilerArgs)\b/u.test(source.text)) {
        throw fail('Use standard JVM compilation without generated sources or compiler plugins for mixed type rename.');
      }
      continue;
    }
    const { tokens, issues } = lexJava(source.text);
    if (issues.length || proposed.test(source.text)) throw fail('The destination name already appears or a mixed JVM source is ambiguous.');
    if (tokens.some(token => (token.kind === 'string' || token.kind === 'text-block') &&
        whole.test(token.value ?? token.text))) throw fail('A string uses this JVM class name. Review reflective or configured references separately.');
  }
}

async function kotlinTypeReferences({ root, sources, selection, references, request, cancellation }) {
  const sites = [];
  for (const source of sources.values()) {
    if (!source.file.endsWith('.kt') || !isMain(root,source.file)) continue;
    const uri = kotlinProtocolUri(source.file);
    for (const token of lexJava(source.text).tokens) {
      if (token.kind !== 'id' || token.text !== selection.oldName ||
          source.key === selection.file.key && token.start === selection.start) continue;
      sites.push({ uri, range: rangeAt(source.text,token.start,token.end) });
      if (sites.length > 64) throw fail('Mixed Kotlin type rename reviews at most 64 candidate Kotlin references.');
    }
  }
  if (!Array.isArray(references) || references.length > 1000) throw fail('The Kotlin server returned an unbounded class reference list.');
  const owned = new Map();
  const deadline = Date.now() + 45000;
  for (let index = 0; index < sites.length; index += 8) {
    if (Date.now() > deadline) throw fail('Kotlin class attribution timed out. Wait for project indexing and retry.');
    await Promise.all(sites.slice(index,index + 8).map(async site => {
      const definition = await request('textDocument/definition',
        {textDocument:{uri:site.uri},position:site.range.start},cancellation);
      const locations = Array.isArray(definition) ? definition : definition ? [definition] : [];
      if (locations.length !== 1) throw fail('A Kotlin class use could not be attributed to one declaration.');
      const target = locations[0];
      if (sourceKey(target.targetUri || target.uri) !== selection.file.key) return;
      const range = target.targetSelectionRange || target.range;
      if (sameRange(range,selection.range) || selection.constructor && sameRange(range,selection.constructor)) {
        owned.set(sourceSpan(site,sources,selection.oldName).id,site);
      }
    }));
  }
  for (const reference of references) {
    const {id}=sourceSpan(reference,sources,selection.oldName);
    if (id!==selection.id && !owned.has(id)) throw fail('The Kotlin references include a declaration outside the selected class.');
  }
  return [...owned.values()];
}

async function stagedCompilation({ root, directory, files, classpath, compiler, fqn, other, cancellation }) {
  const { kotlinOutput, java, dependencies } = await compileMixedKotlin({ root, directory, files, classpath, compiler, cancellation });
  const target = path.join(kotlinOutput, ...fqn.split('.')) + '.class';
  if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isFile() || fs.existsSync(path.join(kotlinOutput, ...other.split('.')) + '.class')) {
    throw fail('Kotlin compilation did not produce exactly the reviewed JVM class identity.');
  }
  const inspected = await analyzeJavaSources({ javaHome: compiler.javaHome, classpath: [kotlinOutput, ...dependencies],
    sources: java, storagePath: directory, manifestLimit: 256 * 1024, cancellation,
    inspection: { kind: 'typeRenameBinary', fqn, other } });
  if (inspected.errors.length) throw fail('Javac could not verify the reviewed mixed source snapshot. ' + inspected.errors[0].message);
  if (!inspected.typeRename?.supported || !inspected.typeRename.binaryOwner || inspected.typeRename.destinationOccupied) {
    throw fail('Javac found an ambiguous or occupied Kotlin JVM class identity.');
  }
  inspected.validateClasspath();
  const byKey = new Map(java.map(source => [sourceKey(source.uri), source]));
  const simple = fqn.split('.').at(-1);
  const spans = inspected.typeRename.spans.map(span => {
    const source = byKey.get(sourceKey(span.uri));
    if (!source || source.text.slice(span.start, span.end) !== simple) throw fail('Javac returned a Kotlin reference outside the exact reviewed Java source.');
    return { ...span, uri: source.uri };
  });
  return { java, spans };
}

async function mixedTypeEdits({ root, sources, selection, newName, kotlin, compiler, classpath, cancellation, check }) {
  const original = [...sources.values()].filter(file => isMain(root, file.file));
  if ([...kotlin.changed.values()].some(({file}) => !isMain(root, file.file))) {
    throw fail('Kotlin type rename requires reviewed main callers in this mixed project.');
  }
  const oldFqn = selection.namespace + '.' + selection.oldName, newFqn = selection.namespace + '.' + newName;
  return withMixedClasspath({ compiler, classpath, fqns: [oldFqn, newFqn] }, async ({ stage, isolated, validateRuntime }) => {
    check();
    const before = await stagedCompilation({ root, directory: path.join(stage, 'before'), files: original, classpath: isolated,
      compiler, fqn: oldFqn, other: newFqn, cancellation });
    if (!before.spans.length) throw fail('Choose a Kotlin class with a compiler-attributed Java caller.');
    const javaEntries = exactEntries(before.java, before.spans, newName);
    const editsByFile = new Map(javaEntries.map(entry => [sourceKey(entry.textDocument.uri), entry.edits]));
    for (const [file, { edits }] of kotlin.changed) editsByFile.set(file, edits);
    const prospective = original.map(file => ({ ...file, text: editedText(file.text, editsByFile.get(file.key) || []) }));
    const after = await stagedCompilation({ root, directory: path.join(stage, 'after'), files: prospective, classpath: isolated,
      compiler, fqn: newFqn, other: oldFqn, cancellation });
    verifyProspectiveSpans(before.spans, after.spans, {}, newName.length - selection.oldName.length);
    check();
    const changes = new Map();
    for (const file of original) if (editsByFile.has(file.key)) changes.set(file.file, editsByFile.get(file.key));
    return { changes, javaReferences: before.spans.length, sourceFiles: original.length, validateRuntime };
  });
}

module.exports = { classCandidate, reviewContracts, kotlinTypeReferences, reviewedClasspath, mixedTypeEdits };
