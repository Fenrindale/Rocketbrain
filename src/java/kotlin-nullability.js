'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lexJava, matching, rangeAt } = require('../spring/java');
const { sourceKey, offsetsForClassRename } = require('./kotlin-rename');
const { kotlinProtocolUri } = require('./kotlin-editor-runtime');
const { reviewedClasspath } = require('./kotlin-mixed-type-rename');
const { inspectCompilerJar, sanitizeCompilerJar, snapshotClasspath } = require('./signature-compiler');
const { cancelled, fail, inside, packageName } = require('./workbench-model');
const { execute } = require('./testing/provision');
const workerSource = require('./kotlin-nullability-source.json');

const diagnosticCodes = new Set(['UNSAFE_CALL', 'UNSAFE_OPERATOR_CALL', 'ARGUMENT_TYPE_MISMATCH', 'NULL_FOR_NONNULL_TYPE',
  'INITIALIZER_TYPE_MISMATCH', 'ASSIGNMENT_TYPE_MISMATCH', 'RETURN_TYPE_MISMATCH', 'UPPER_BOUND_VIOLATED',
  'INAPPLICABLE_CANDIDATE']);
const mainSource = (root, file) => /^src[\\/]main[\\/](?:java|kotlin)[\\/]/u.test(path.relative(root, file));
const plainName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function selectedCall(source, position) {
  const { start, end, range } = offsetsForClassRename(source.text, position);
  const { tokens, issues } = lexJava(source.text);
  const index = tokens.findIndex(token => token.start === start && token.end === end);
  const receiver = tokens[index - 2], method = tokens[index];
  let args = index + 1;
  if (tokens[args]?.text === '<') args = matching(tokens, args, '<', '>') + 1;
  const close = tokens[args]?.text === '(' ? matching(tokens, args) : -1;
  if (issues.length || !method || !plainName.test(method.text) || receiver?.kind !== 'id' ||
      tokens[index - 1]?.text !== '.' || close <= args || tokens[args].start < end ||
      rangeAt(source.text, receiver.start, tokens[close].end).end.line !== range.start.line ||
      rangeAt(source.text, receiver.start, start).start.line !== range.start.line) {
    throw fail('Place the cursor on a Java method name in an ordinary single-line Kotlin call.');
  }
  let chainEnd = close;
  for (let cursor = close + 1; cursor < tokens.length;) {
    const next = tokens[cursor];
    if (rangeAt(source.text, next.start, next.end).start.line !== range.start.line) break;
    if (next.text === '[') {
      const afterIndex = matching(tokens, cursor);
      if (afterIndex < cursor) break;
      chainEnd = afterIndex;
      cursor = afterIndex + 1;
      continue;
    }
    if (next.text !== '.' || tokens[cursor + 1]?.kind !== 'id') break;
    chainEnd = cursor + 1;
    cursor += 2;
    if (tokens[cursor]?.text === '(') {
      const afterCall = matching(tokens, cursor);
      if (afterCall < cursor) break;
      chainEnd = afterCall;
      cursor = afterCall + 1;
    }
  }
  return { name: method.text, namePosition: range.start,
    receiver: receiver.text, receiverPosition: rangeAt(source.text, receiver.start, receiver.end).start,
    range: rangeAt(source.text, receiver.start, tokens[chainEnd].end) };
}

async function linkedJavaSource(session, sources, from, call, cancellation) {
  const textDocument = { uri: kotlinProtocolUri(from.file) };
  for (const [mode, position] of [['method', call.namePosition], ['owner', call.receiverPosition]]) {
    const response = await session.request('textDocument/definition', { textDocument, position }, cancellation);
    const links = Array.isArray(response) ? response : response ? [response] : [];
    if (links.length > 1) throw fail('The Kotlin compiler found multiple declaration candidates.');
    if (!links.length) continue;
    const link = links[0], uri = link.targetUri || link.uri;
    let source;
    try { source = sources.get(sourceKey(uri)); } catch { /* The provider can return a library URI. */ }
    if (!source?.file.endsWith('.java') || !mainSource(session.root, source.file)) {
      throw fail('Choose a declaration in the same project’s saved Java main sources.');
    }
    const selection = link.targetSelectionRange || link.range;
    const candidate = offsetsForClassRename(source.text, selection?.start);
    if (mode === 'owner' && source.text.slice(candidate.start, candidate.end) !== call.receiver) {
      throw fail('Kotlin did not resolve the receiver to an exact Java class name.');
    }
    const anchor = candidate.start;
    return { source, anchor, mode };
  }
  throw fail('Kotlin could not resolve the Java declaration. Check project import and wait for indexing.');
}

function neutralizeContract(source, contract) {
  const edits = contract.annotations.map(({ start, end }) => {
    if (source.text[start] !== '@') throw fail('Javac returned an invalid annotation range.');
    return { start, end, text: source.text.slice(start, end).replace(/[^\r\n]/gu, ' ') };
  });
  // K2 can retain the enhanced upper bound under a method-level NullUnmarked.
  // Relax the nullness of that method's bound while keeping its Java type.
  for (const { offset, implicit } of contract.bounds) {
    edits.push({ start: offset, end: offset, text: implicit
      ? ' extends @org.jspecify.annotations.Nullable Object' : '@org.jspecify.annotations.Nullable ' });
  }
  let text = source.text, upper = contract.headerEnd;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < contract.start ||
        edit.end < edit.start || edit.end > upper) throw fail('Javac returned conflicting contract ranges.');
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    upper = edit.start;
  }
  return text.slice(0, contract.start) + '@org.jspecify.annotations.NullUnmarked ' + text.slice(contract.start);
}

function contractLocation(source, contract, call) {
  const header = lexJava(source.text.slice(contract.start, contract.headerEnd));
  const matchingNames = header.tokens.filter((token, index) => token.kind === 'id' && token.text === call.name &&
    header.tokens[index + 1]?.text === '(' && header.tokens[index - 1]?.text !== '@');
  if (header.issues.length || matchingNames.length !== 1) throw fail('Javac did not identify one exact Java method name.');
  const { start, end } = matchingNames[0];
  return { file: source.file, owner: contract.owner, signature: contract.signature,
    range: rangeAt(source.text, contract.start + start, contract.start + end),
    annotations: [...new Set(contract.annotations.map(item => item.name))],
    defaults: contract.defaults };
}

function issuesForSource(result, stagedPath, source) {
  if (![0, 1].includes(result.exitCode) || !Array.isArray(result.issues) ||
      result.exitCode === 1 && !result.issues.length || result.issues.some(issue => !issue.path)) {
    throw fail('The pinned Kotlin compiler could not check the reviewed JVM inputs.');
  }
  const lines = source.text.split('\n');
  const valid = (line, column) => Number.isSafeInteger(line) && Number.isSafeInteger(column) &&
    line >= 1 && line <= lines.length && column >= 1 && column <= lines[line - 1].replace(/\r$/u, '').length + 1;
  const issues = [];
  for (const issue of result.issues) {
    if (path.relative(stagedPath, issue.path)) continue;
    const parsed = /^\[([A-Z][A-Z_0-9]+)\] (.+)$/su.exec(issue.message);
    if (!parsed || !valid(issue.line, issue.column) || !valid(issue.lineEnd, issue.columnEnd) ||
        issue.line > issue.lineEnd || issue.line === issue.lineEnd && issue.column >= issue.columnEnd) continue;
    issues.push({ code: parsed[1], message: parsed[2], range: { start: { line: issue.line - 1, character: issue.column - 1 },
      end: { line: issue.lineEnd - 1, character: issue.columnEnd - 1 } } });
  }
  return issues;
}

function contractIssues(strict, ignored, neutral, call) {
  const key = issue => JSON.stringify([issue.code, issue.range]);
  const absent = new Set([...ignored, ...neutral].map(key));
  const found = new Map();
  for (const issue of strict) {
    if (diagnosticCodes.has(issue.code) && !absent.has(key(issue)) && issue.range.start.line === call.range.start.line &&
        issue.range.end.line === call.range.end.line && issue.range.start.character >= call.range.start.character &&
        issue.range.end.character <= call.range.end.character) found.set(key(issue), issue);
  }
  return [...found.values()];
}

async function inspectKotlinNullability({session, sources, source, position, cancellation, check}) {
  const call = selectedCall(source, position);
  const target = await linkedJavaSource(session, sources, source, call, cancellation);
  const classpath = reviewedClasspath(session.root, await session.classpath(cancellation));
  const main = [...sources.values()].filter(input => mainSource(session.root, input.file));
  if ([...sources.values()].some(input => /\.(?:gradle(?:\.kts)?|toml)$/u.test(input.file) &&
      /\b(?:kapt|ksp|annotationProcessor|compilerOptions|kotlinOptions|freeCompilerArgs)\b/u.test(input.text)) ||
      main.some(input => /^org\.jspecify\.annotations(?:\.|$)/u.test(
        packageName(input.text, input.file.endsWith('.java') ? 'java' : 'kotlin') || ''))) {
    throw fail('Inspect a standard mixed JVM build without generated sources, Java compiler plugins or redefined JSpecify annotations.');
  }
  const compiler = session.compiler, runtime = snapshotClasspath(compiler.javaHome, [...compiler.libraries, ...classpath]);
  const parent = await fs.realpath(os.tmpdir());
  const stage = await fs.mkdtemp(path.join(parent, 'rb-kotlin-null-'));
  const identity = await fs.lstat(stage, { bigint: true });
  try {
    const dependencies = [compiler.stdlib];
    for (const [index, file] of classpath.entries()) {
      if (cancelled(cancellation)) throw fail('Kotlin nullability inspection was cancelled.');
      const metadata = await inspectCompilerJar(file, 256 * 1024);
      if (metadata.sanitized) {
        const clean = path.join(stage, 'dependency-' + index + '.jar');
        await sanitizeCompilerJar(file, clean);
        dependencies.push(clean);
      } else dependencies.push(file);
    }
    const roots = new Set(), files = new Map();
    for (const input of main) {
      const relative = path.relative(session.root, input.file);
      if (relative.length > 220 || !inside(session.root, input.file)) throw fail('Use bounded main JVM sources.');
      const physical = path.join(stage, relative);
      await fs.mkdir(path.dirname(physical), { recursive: true });
      await fs.writeFile(physical, input.text, { flag: 'wx' });
      files.set(input.key, physical);
      roots.add(path.join(stage, ...relative.split(path.sep).slice(0, 3)));
    }
    const worker = path.join(stage, 'InteropNullability.java');
    await fs.writeFile(worker, workerSource, { flag: 'wx' });
    const cp = dependencies.join(path.delimiter);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/iu.test(name)));
    env.JAVA_HOME = compiler.javaHome;
    async function run(args) {
      check();
      runtime.validate();
      const finished = await execute(compiler.java, ['-XX:ActiveProcessorCount=2', '-Xmx768m', '-Dfile.encoding=UTF-8',
        '-cp', compiler.libraries.join(path.delimiter), worker, ...args], { cwd: stage, env, cancellation, timeoutMs: 45000 });
      if (finished.timedOut || finished.cancelled) throw fail('Kotlin nullability inspection did not finish.');
      const rows = finished.output.split(/\r?\n/u).filter(line => line.startsWith('ROCKETBRAIN_NULLABILITY '));
      if (finished.code !== 0 || rows.length !== 1) {
        const attributed = finished.output.match(/IllegalArgumentException: (Javac could not attribute[^\r\n]*|The observed classpath does not contain JSpecify\.)/u);
        throw fail(attributed?.[1] || 'The pinned compiler could not inspect the reviewed nullability inputs.');
      }
      return JSON.parse(rows[0].slice('ROCKETBRAIN_NULLABILITY '.length));
    }
    const javaStage = files.get(target.source.key), kotlinStage = files.get(source.key);
    const declarations = await run(['declaration', javaStage, cp, [...roots].join(path.delimiter), call.name,
      String(target.anchor), target.mode]);
    if (!Array.isArray(declarations) || declarations.length !== 1) throw fail('Javac could not attribute one exact Java method.');
    const contract = declarations[0], link = contractLocation(target.source, contract, call);
    const compile = (mode, name) => run(['compile', '-Xrender-internal-diagnostic-names', '-Xjspecify-annotations=' + mode,
      '-no-stdlib', '-no-reflect', '-jvm-target', '21', '-classpath', cp,
      '-d', path.join(stage, name), ...roots]);
    const strict = issuesForSource(await compile('strict', 'strict'), kotlinStage, source);
    const relevant = strict.some(issue => diagnosticCodes.has(issue.code) && issue.range.start.line === call.range.start.line);
    let diagnostics = [];
    if (relevant) {
      const ignored = issuesForSource(await compile('ignore', 'ignored'), kotlinStage, source);
      await fs.writeFile(javaStage, neutralizeContract(target.source, contract));
      const neutral = issuesForSource(await compile('strict', 'neutral'), kotlinStage, source);
      diagnostics = contractIssues(strict, ignored, neutral, call);
    }
    runtime.validate();
    check();
    const validate = async token => {
      const latest = reviewedClasspath(session.root, await session.classpath(token));
      if (JSON.stringify(latest) !== JSON.stringify(classpath)) throw fail('The mixed JVM classpath changed. Inspect the contract again.');
      runtime.validate();
      check();
    };
    return { call: call.range, target: { ...link, uri: pathToFileURL(link.file).href }, diagnostics, validate };
  } finally {
    const real = await fs.realpath(stage), current = await fs.lstat(real, { bigint: true });
    if (path.relative(stage, real) || path.dirname(real) !== parent || !path.basename(real).startsWith('rb-kotlin-null-') ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw fail('Kotlin compiler staging changed ownership.');
    await fs.rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}

module.exports = { inspectKotlinNullability, selectedCall, contractIssues };
