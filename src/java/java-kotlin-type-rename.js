'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { lexJava, rangeAt } = require('../spring/java');
const { kotlinBuildTool, kotlinProtocolUri } = require('./kotlin-editor-runtime');
const { verifyName, sourceKey, sameRange } = require('./kotlin-rename');
const { isMain, reviewedClasspath, compileMixedKotlin, withMixedClasspath } = require('./kotlin-mixed-compilation');
const { readStagedKotlinClasses } = require('./mixed-jvm-index');
const { editedText } = require('./refactoring');
const { fail, packageName } = require('./workbench-model');

function namePattern(name) {
  return new RegExp('(?<![\\p{L}\\p{N}_])' + name.replaceAll('$','\\$') + '(?![\\p{L}\\p{N}_])', 'u');
}

function hasKotlinMentions(sources, name) {
  const pattern = namePattern(name);
  return sources.some(source => source.file.endsWith('.kt') && pattern.test(source.text));
}

function mixedJavaClasspath(scope, sources, owner) {
  if (kotlinBuildTool(scope.source.root) !== 'gradle' || !isMain(scope.source.root,owner.file)) {
    throw fail('Java type rename with Kotlin callers requires one imported Gradle JVM project.');
  }
  if (['buildSrc','gradle/libs.versions.toml'].some(file=>fs.existsSync(path.join(scope.source.root,file)))) {
    throw fail('Gradle build logic and version catalogs require separate Java rename review with Kotlin callers.');
  }
  if (sources.some(source=>/\.(?:gradle(?:\.kts)?)$/u.test(source.file) &&
      /\b(?:kapt|ksp|annotationProcessor|compilerOptions|kotlinOptions|freeCompilerArgs|sourceSets|includeBuild)\b|\binclude\s*[("']/u.test(source.text))) {
    throw fail('Use conventional source roots and compilation without extra Gradle projects or compiler plugins for Java rename with Kotlin callers.');
  }
  return reviewedClasspath(scope.source.root, scope.source.classpaths);
}

function physicalSource(uri) {
  if (!sourceKey(uri)) return;
  try { return fs.realpathSync.native(fileURLToPath(uri)); } catch { return; }
}

function javaTargets(owner, declaration) {
  const constructors = declaration?.constructors;
  if (declaration?.typeParameters !== 0 || declaration?.annotations?.length ||
      constructors?.length !== 1 || !constructors[0].public || constructors[0].varargs || constructors[0].typeParameters !== 0) {
    throw fail('Kotlin callers require an unannotated, nongeneric Java class with one explicit public constructor.');
  }
  return { type: rangeAt(owner.text, declaration.start, declaration.end),
    constructor: rangeAt(owner.text, constructors[0].start, constructors[0].end) };
}

function sourceRole(source, tokens, index, fqn, imported) {
  const word = tokens[index];
  let head = index;
  while (tokens[head - 1]?.text === '.' && tokens[head - 2]?.kind === 'id') head -= 2;
  const qualifier = tokens.slice(head, index + 1).map(token => token.text).join('');
  const before = tokens[head - 1]?.text, after = tokens[index + 1]?.text;
  const leftCallable = before === '::' || before === ':' && tokens[head - 2]?.text === ':';
  const rightCallable = after === '::' || after === ':' && tokens[index + 2]?.text === ':';
  if (leftCallable || rightCallable || after === 'as' && before === 'import') {
    throw fail('Kotlin callable references, class literals and aliased imports require separate Java rename review.');
  }
  if (before === 'import' && qualifier === fqn && !/\r?\n/u.test(source.text.slice(tokens[head - 1].end, word.start))) {
    return 'type';
  }
  if (qualifier !== fqn && (head !== index || !imported && packageName(source.text,'kotlin') !== fqn.slice(0, fqn.lastIndexOf('.')))) {
    throw fail('Use an exact Kotlin import, package name or fully qualified Java type.');
  }
  if (after === '(') return 'constructor';
  if (before === ':' && after !== '.') return 'type';
  throw fail('Only ordinary Kotlin imports, explicit type positions and direct Java constructor calls are supported.');
}

async function boundKotlinSites({ root, sources, owner, declaration, fqn, newName, runtime, cancellation }) {
  const oldName = verifyName(fqn.split('.').at(-1));
  verifyName(newName);
  const targets = javaTargets(owner, declaration);
  const oldPattern = namePattern(oldName), newPattern = namePattern(newName);
  const files = new Set(sources.filter(source=>/\.(?:kt|java)$/u.test(source.file)).map(source=>physicalSource(source.uri)).filter(Boolean));
  const selected = physicalSource(owner.uri);
  if (!selected) throw fail('The selected Java class does not have a physical source identity.');
  const candidates = [];
  for (const source of sources.filter(source=>source.file.endsWith('.kt'))) {
    if (!oldPattern.test(source.text)) continue;
    if (!/^src[\\/]main[\\/]kotlin[\\/]/u.test(path.relative(root,source.file))) {
      throw fail('A Kotlin source outside conventional main roots uses the Java class name.');
    }
    const { tokens, issues } = lexJava(source.text);
    if (issues.length || newPattern.test(source.text) || tokens.some(token=>token.text === '`' ||
      ['string', 'text-block'].includes(token.kind) && oldPattern.test(token.value ?? token.text))) {
      throw fail('A Kotlin source contains a destination collision, unsupported identifier or string use of the Java class name.');
    }
    const directImport = source.text.split(/\r?\n/u).some(line=>line.replace(/\s*\/\/.*$/u,'').trim() === 'import ' + fqn);
    for (const [index, token] of tokens.entries()) {
      if (token.kind === 'id' && token.text === oldName) {
        candidates.push({ source, tokens, index, token, directImport });
        if (candidates.length > 64) throw fail('Review at most 64 Kotlin candidates for a Java class rename.');
      }
    }
  }
  const sites = [];
  const deadline = Date.now() + 45000;
  for (let index = 0; index < candidates.length; index += 8) {
    if (Date.now() > deadline) throw fail('Kotlin caller attribution timed out. Wait for indexing and retry.');
    runtime.check();
    const batch = await Promise.all(candidates.slice(index, index + 8).map(async candidate => {
      const { source, tokens, index, token, directImport } = candidate;
      const range = rangeAt(source.text, token.start, token.end);
      const response = await runtime.request('textDocument/definition', {
        textDocument: { uri: kotlinProtocolUri(source.file) }, position: range.start
      }, cancellation);
      const definitions = Array.isArray(response) ? response : response ? [response] : [];
      if (definitions.length !== 1) throw fail('A Kotlin use could not be attributed to one reviewed source declaration.');
      const definition = definitions[0], key = physicalSource(definition.targetUri || definition.uri);
      if (!key || !files.has(key)) throw fail('A Kotlin definition leaves the reviewed physical source set.');
      if (key !== selected) return;
      const role = sourceRole(source, tokens, index, fqn, directImport);
      if (!sameRange(definition.targetSelectionRange || definition.range, targets[role])) {
        throw fail('Kotlin did not resolve the exact attributed Java class or its single constructor.');
      }
      return { uri: source.uri, start: token.start, end: token.end, role };
    }));
    sites.push(...batch.filter(Boolean));
  }
  runtime.check();
  if (!sites.length) throw fail('No Kotlin call site resolves to the selected Java class.');
  return sites;
}

function bindings(classes, oldName, newName) {
  const internalName = value => value === oldName ? newName : value;
  const descriptor = value => value.replaceAll('L' + oldName + ';', 'L' + newName + ';');
  return [...classes].sort((a,b)=>a.name.localeCompare(b.name)).map(value=>({
    name:value.name, source:value.source, superName:internalName(value.superName),
    methods:value.methods.map(method=>({...method,descriptor:descriptor(method.descriptor)})),
    calls:value.calls.map(call=>({...call,owner:internalName(call.owner),descriptor:descriptor(call.descriptor)}))
  }));
}

async function validateKotlinProjection({ root, sources, rename, entries, fqn, newFqn, classpath, runtime, sites, cancellation }) {
  const original = sources.filter(source=>isMain(root,source.file) && /\.(?:java|kt)$/u.test(source.file));
  if (!original.some(source=>source.file.endsWith('.kt')) || original.length > 240 ||
      original.reduce((size, source)=>size + Buffer.byteLength(source.text), 0) > 8 * 1024 * 1024) {
    throw fail('Kotlin rename verification requires at most 240 conventional main JVM sources and 8 MiB.');
  }
  const edits = new Map(entries.map(entry=>[entry.textDocument.uri,entry.edits]));
  const proposed = original.map(source=>({
    ...source, file:source.uri === rename.oldUri ? fileURLToPath(rename.newUri) : source.file,
    text:editedText(source.text, edits.get(source.uri) || [])
  }));
  const { compiler } = runtime;
  return withMixedClasspath({ compiler, classpath, fqns: [fqn,newFqn] }, async ({ stage, isolated, validateRuntime }) => {
    const inspect = async (label, files) => {
      runtime.check();
      const { kotlinOutput } = await compileMixedKotlin({
        root, directory:path.join(stage,label), files, classpath:isolated, compiler, cancellation
      });
      runtime.check();
      return readStagedKotlinClasses(kotlinOutput, compiler.javaHome, cancellation);
    };
    const before = await inspect('before', original), after = await inspect('after', proposed);
    const oldName = fqn.replaceAll('.','/'), newName = newFqn.replaceAll('.','/');
    const constructors = before.flatMap(value=>value.calls).filter(call=>call.owner === oldName && call.name === '<init>').length;
    if (sites.some(site=>site.role === 'constructor') && !constructors ||
        JSON.stringify(bindings(before,oldName,newName)) !== JSON.stringify(bindings(after,newName,newName))) {
      throw fail('The renamed Kotlin code would change a JVM type or invocation beyond the reviewed Java class.');
    }
    runtime.check();
    return { constructors, validateRuntime };
  });
}

module.exports = { hasKotlinMentions, mixedJavaClasspath, boundKotlinSites, validateKotlinProjection };
