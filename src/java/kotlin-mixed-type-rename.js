'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { lexJava, rangeAt, matching } = require('../spring/java');
const { editedText } = require('./refactoring');
const { exactEntries, verifyProspectiveSpans } = require('./java-type-rename');
const { offsetsForClassRename, sourceKey, sourceSpan, sameRange } = require('./kotlin-rename');
const { kotlinProtocolUri } = require('./kotlin-editor-runtime');
const { validIdentifier } = require('./file-templates');
const { inside, packageName, fail } = require('./workbench-model');
const { analyzeJavaSources, inspectCompilerJar, sanitizeCompilerJar, snapshotClasspath } = require('./signature-compiler');
const { execute } = require('./testing/provision');

const outputs = ['build/classes/java/main', 'build/classes/kotlin/main', 'build/resources/main',
  'build/classes/java/test', 'build/classes/kotlin/test', 'build/resources/test', 'bin', 'bin/main', 'bin/test'];
const isMain = (root, file) => /^src[\\/]main[\\/](?:java|kotlin)[\\/]/u.test(path.relative(root, file));
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
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
  if (!namespace || !namespace.split('.').every(part => identifier.test(part))) {
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

function reviewedClasspath(root, cp) {
  const project = cp?.projectRoot;
  if (!project || !Array.isArray(cp.classpaths) || cp.classpaths.length > 180 || cp.modulepaths?.length) {
    throw fail('Import the single Gradle JVM project and resolve its ordinary Java compile classpath first.');
  }
  const observed = String(project).startsWith('file:') ? fileURLToPath(project) : project;
  if (typeof observed !== 'string' || !path.isAbsolute(observed) || pathKey(observed) !== pathKey(root)) {
    throw fail('The Java language server resolved a different JVM project.');
  }
  const knownOutputs = new Set(outputs.map(file => pathKey(path.join(root, file))));
  const workspaceOutputs = new Set(outputs.map(file => ('/' + path.basename(root) + '/' + file).toLowerCase()));
  const result = new Map();
  for (const input of cp.classpaths) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes(path.delimiter)) {
      throw fail('Use physical local JVM compiler classpaths.');
    }
    // The Eclipse model can return its own workspace-relative output spelling.
    const spelling=input.replaceAll('\\','/');
    if (knownOutputs.has(pathKey(input)) ||
        process.platform==='win32' && workspaceOutputs.has(spelling.toLowerCase())) continue;
    if (spelling.startsWith('//') || process.platform==='win32' && spelling.startsWith('/')) {
      throw fail('The Java model returned an unreviewed workspace-relative or network classpath.');
    }
    const file = fs.realpathSync(input), stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || pathKey(file) !== pathKey(input) || !file.endsWith('.jar')) {
      throw fail('Mixed type rename does not use another project output or an unreviewed classpath directory.');
    }
    if (/^kotlin-stdlib(?:-[A-Za-z0-9_.-]+)?\.jar$/u.test(path.basename(file))) continue;
    result.set(pathKey(file), file);
  }
  return [...result.values()].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
}

async function stagedCompilation({ root, directory, files, classpath, compiler, fqn, other, cancellation }) {
  const source = path.join(directory, 'src'), kotlinOutput = path.join(directory, 'kotlin-output');
  await fsp.mkdir(kotlinOutput, { recursive: true });
  const roots = new Set(), java = [];
  for (const file of files) {
    const relative = path.relative(root, file.file);
    if (!isMain(root, file.file) || relative.length > 220 || !inside(root, file.file)) throw fail('Use bounded main JVM sources.');
    const staged = path.join(source, relative);
    await fsp.mkdir(path.dirname(staged), { recursive: true });
    await fsp.writeFile(staged, file.text, { flag: 'wx' });
    roots.add(path.join(source, ...relative.split(path.sep).slice(0, 3)));
    if (file.file.endsWith('.java')) java.push({ ...file, uri: pathToFileURL(file.file).href });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/iu.test(name)));
  const dependencies = [compiler.stdlib, ...classpath];
  const result = await execute(compiler.java, ['-XX:ActiveProcessorCount=2', '-Xmx768m',
    '-cp', compiler.libraries.join(path.delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib',
    '-no-reflect', '-jvm-target', '24', '-classpath', dependencies.join(path.delimiter),
    '-d', kotlinOutput, ...roots], { cwd: directory, env, timeoutMs: 45000, cancellation });
  if (result.code !== 0 || result.timedOut || result.cancelled) {
    throw fail('The Kotlin compiler could not verify the reviewed mixed source snapshot. ' + result.output.slice(-1800));
  }
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
  const runtime = snapshotClasspath(compiler.javaHome, [...compiler.libraries, ...classpath]);
  const parent = await fsp.realpath(os.tmpdir()), stage = await fsp.mkdtemp(path.join(parent, 'rb-mixed-type-'));
  const identity = await fsp.lstat(stage, { bigint: true });
  try {
    const isolated = [];
    for (const [index, file] of classpath.entries()) {
      const metadata = await inspectCompilerJar(file, 256 * 1024);
      if (metadata.sanitized) {
        const target = path.join(stage, index + '.jar');
        await sanitizeCompilerJar(file, target);
        isolated.push(target);
      } else isolated.push(file);
    }
    runtime.validate();
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
    runtime.validate();
    check();
    const changes = new Map();
    for (const file of original) if (editsByFile.has(file.key)) changes.set(file.file, editsByFile.get(file.key));
    return { changes, javaReferences: before.spans.length, sourceFiles: original.length, validateRuntime: runtime.validate };
  } finally {
    const real = await fsp.realpath(stage), current = await fsp.lstat(real, { bigint: true });
    if (pathKey(real) !== pathKey(stage) || path.dirname(real) !== parent || !path.basename(real).startsWith('rb-mixed-type-') ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw fail('Mixed compiler staging changed ownership.');
    await fsp.rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}

module.exports = { classCandidate, reviewContracts, kotlinTypeReferences, reviewedClasspath, mixedTypeEdits };
