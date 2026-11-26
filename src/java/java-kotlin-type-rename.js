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

function qualifierAt(tokens, index) {
  let head = index;
  while (tokens[head - 1]?.text === '.' && tokens[head - 2]?.kind === 'id') head -= 2;
  return { head, qualified: tokens.slice(head, index + 1).map(token => token.text).join('') };
}

function importBinding(source, tokens, fqn, oldName) {
  const selected = [];
  for (const [at, keyword] of tokens.entries()) {
    if (keyword.text !== 'import' || tokens[at+1]?.kind !== 'id') continue;
    let index = at+1;
    while (tokens[index+1]?.text === '.' && tokens[index+2]?.kind === 'id') index += 2;
    const word = tokens[index];
    if (word.text !== oldName || tokens.slice(at+1,index+1).map(token=>token.text).join('') !== fqn) continue;
    if (/[\r\n]/u.test(source.text.slice(keyword.end,word.start))) {
      throw fail('Review a single-line exact Kotlin import for the Java class.');
    }
    const binding = { index };
    if (tokens[index + 1]?.text === 'as' && !/[\r\n]/u.test(source.text.slice(word.end,tokens[index + 1].start))) {
      const alias = tokens[index + 2];
      if (alias?.kind !== 'id' || /[\r\n]/u.test(source.text.slice(word.end,alias.start)) || verifyName(alias.text) === oldName) {
        throw fail('Use a distinct plain Kotlin import alias for the Java class.');
      }
      binding.alias = alias.text;
      binding.aliasIndex = index + 2;
    }
    selected.push(binding);
  }
  if (selected.length > 1) throw fail('Multiple imports of the selected Java class in one Kotlin file require separate review.');
  return selected[0];
}

const callableContexts = new Set(['=', '(', ',', 'return', '{', '[', ';']);
function sourceRole(source, tokens, index, fqn, binding, isAlias) {
  if (binding?.index === index) return 'type';
  const { head, qualified } = qualifierAt(tokens,index);
  const before = tokens[head - 1]?.text, after = tokens[index + 1]?.text;
  const colon = before === '::' ? head - 1 : before === ':' && tokens[head - 2]?.text === ':' ? head - 2 : undefined;
  const rightCallable = after === '::' || after === ':' && tokens[index + 2]?.text === ':';
  if (rightCallable) throw fail('Kotlin class literals and qualified callable references require separate Java rename review.');
  const unqualified = head === index && (isAlias || binding && !binding.alias ||
    packageName(source.text,'kotlin') === fqn.slice(0, fqn.lastIndexOf('.')));
  if (qualified !== fqn && !unqualified) {
    throw fail('Use an exact Kotlin import, import alias, package name or fully qualified Java type.');
  }
  if (colon !== undefined) {
    if (!unqualified || !callableContexts.has(tokens[colon - 1]?.text)) {
      throw fail('Only an unqualified Kotlin constructor callable reference is supported.');
    }
    return 'constructor-reference';
  }
  if (after === '(') return 'constructor';
  const functionResult = before === '->' || before === '>' && tokens[head - 2]?.text === '-';
  if ((before === ':' || functionResult) && after !== '.') return 'type';
  throw fail('Only ordinary Kotlin imports, explicit type positions, constructor calls and direct constructor references are supported.');
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
    const binding = importBinding(source,tokens,fqn,oldName);
    for (const [index, token] of tokens.entries()) {
      const isAlias = token.text === binding?.alias;
      if (token.kind === 'id' && (token.text === oldName || isAlias && index !== binding.aliasIndex)) {
        candidates.push({ source, tokens, index, token, binding, isAlias });
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
      const { source, tokens, index, token, binding, isAlias } = candidate;
      const range = rangeAt(source.text, token.start, token.end);
      const response = await runtime.request('textDocument/definition', {
        textDocument: { uri: kotlinProtocolUri(source.file) }, position: range.start
      }, cancellation);
      const definitions = Array.isArray(response) ? response : response ? [response] : [];
      if (definitions.length !== 1) throw fail('A Kotlin use could not be attributed to one reviewed source declaration.');
      const definition = definitions[0], key = physicalSource(definition.targetUri || definition.uri);
      if (!key || !files.has(key)) throw fail('A Kotlin definition leaves the reviewed physical source set.');
      if (key !== selected) return;
      const role = sourceRole(source,tokens,index,fqn,binding,isAlias);
      const expected = role === 'type' ? targets.type : targets.constructor;
      if (!sameRange(definition.targetSelectionRange || definition.range, expected)) {
        throw fail('Kotlin did not resolve the exact attributed Java class or its single constructor.');
      }
      return { uri: source.uri, start: token.start, end: token.end, role,
        ...(isAlias&&{ keepAlias:true }), ...(binding?.index===index&&binding.alias&&{ importAlias:true }) };
    }));
    sites.push(...batch.filter(Boolean));
  }
  runtime.check();
  if (!sites.some(site=>!site.keepAlias)) throw fail('No Kotlin call site resolves to the selected Java class.');
  const aliasImports = new Set(sites.filter(site=>site.importAlias).map(site=>site.uri));
  if (sites.some(site=>site.keepAlias&&!aliasImports.has(site.uri))) {
    throw fail('Kotlin did not bind the preserved alias to an exact import of the selected Java class.');
  }
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

function verifyConstructorReferenceBindings(classes, sources, sites, owner) {
  const references = sites.filter(site=>site.role === 'constructor-reference');
  if (!references.length) return 0;
  const units = new Map(), identities = new Map();
  for (const source of sources.filter(item=>item.file.endsWith('.kt'))) {
    const namespace = packageName(source.text,'kotlin')?.replaceAll('.','/');
    const filename = path.basename(source.file), key = JSON.stringify([namespace,filename]);
    units.set(source.uri,{ source, namespace, filename, key });
    identities.set(key,(identities.get(key)||0)+1);
  }
  const witnesses = new Set();
  for (const site of references) {
    const unit = units.get(site.uri);
    if (!unit || identities.get(unit.key) !== 1) throw fail('A Kotlin constructor reference has an ambiguous source identity.');
    const { source, filename, namespace } = unit;
    const line = rangeAt(source.text,site.start,site.end).start.line + 1;
    const matching = classes.filter(value=>value.source === filename &&
      value.name.slice(0,Math.max(0,value.name.lastIndexOf('/'))) === namespace &&
      value.superName === 'kotlin/jvm/internal/FunctionReferenceImpl' &&
      value.methods.some(method=>method.name === 'invoke' && method.descriptor.endsWith('L' + owner + ';')) &&
      value.calls.filter(call=>call.owner === owner && call.name === '<init>' && call.line === line).length === 1);
    if (matching.length !== 1 || witnesses.has(matching[0].name)) {
      throw fail('Kotlin compilation did not establish a distinct JVM constructor reference for the reviewed source site.');
    }
    witnesses.add(matching[0].name);
  }
  return witnesses.size;
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
    const callableReferences = verifyConstructorReferenceBindings(before,original,sites,oldName);
    // A class rename changes identifier widths, never source lines. Use the original source positions to join both builds.
    verifyConstructorReferenceBindings(after,original,sites,newName);
    runtime.check();
    return { constructors, callableReferences, validateRuntime };
  });
}

module.exports = { hasKotlinMentions, mixedJavaClasspath, boundKotlinSites, validateKotlinProjection };
