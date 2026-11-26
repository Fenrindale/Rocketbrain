'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerKotlinNullability } = require('../src/java/kotlin-nullability-vscode');
const { selectedCall, contractIssues } = require('../src/java/kotlin-nullability');
const { kotlinEditorLaunch, kotlinProtocolUri } = require('../src/java/kotlin-editor-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until, positionOf } = require('./helpers/stdio-lsp');
const { javaFile, kotlinFile, prepareNullabilityFixture, brokenCalls, restoreCalls, runJdbc } =
  require('./helpers/mixed-nullability-fixture');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const serverHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const gradleHome = process.env.ROCKETBRAIN_MIXED_RENAME_GRADLE_HOME;
const gradleUserHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
const engines = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_MIXED_NULLABILITY_' + engine.toUpperCase() + '_CONFIG']]);

const markers = {
  maybe: ['UNSAFE_CALL'],
  demand: ['ARGUMENT_TYPE_MISMATCH'],
  checked: ['UPPER_BOUND_VIOLATED'],
  items: ['UNSAFE_CALL'],
  platform: []
};

test('a Java nullability link needs independent JSpecify and selected-declaration compiler differences', () => {
  const text = 'fun example() {\r\n    Names.checked<String?>(value)\r\n}';
  const call = selectedCall({ text }, positionOf(text, 'checked'));
  assert.equal(call.name, 'checked');
  assert.deepEqual(call.range, { start: { line: 1, character: 4 }, end: { line: 1, character: 33 } });
  const issue = (code, line, start, end) => ({ code, range: { start: { line, character: start }, end: { line, character: end } } });
  const match = issue('UPPER_BOUND_VIOLATED', 1, 18, 25);
  const unrelated = issue('UNSAFE_CALL', 2, 18, 19);
  const remains = issue('ARGUMENT_TYPE_MISMATCH', 1, 27, 32);
  assert.deepEqual(contractIssues([match, unrelated, remains], [unrelated], [remains], call), [match]);
  assert.deepEqual(contractIssues([match], [match], [], call), []);
  assert.throws(() => selectedCall({ text }, { line: 0, character: 5 }), /ordinary single-line Kotlin call/u);
});

function editorHost(document) {
  const changes = new Set(), displayed = [], published = new Map();
  const noOp = () => ({ dispose() {} });
  const event = listener => { changes.add(listener); return { dispose: () => changes.delete(listener) }; };
  return {
    displayed, published, notify: file => { for (const listener of changes) listener({ document: { uri: uri(file) } }); },
    vscode: {
      Uri: { file: uri },
      Range: class { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } },
      Location: class { constructor(target, range) { this.uri = target; this.range = range; } },
      Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
      DiagnosticRelatedInformation: class { constructor(location, message) { Object.assign(this, { location, message }); } },
      DiagnosticSeverity: { Error: 0 },
      languages: { createDiagnosticCollection: () => ({
        dispose() {}, clear: () => published.clear(), set: (value, entries) => published.set(value.toString(), entries)
      }) },
      workspace: {
        textDocuments: [document], onDidChangeTextDocument: event,
        createFileSystemWatcher: () => ({ dispose() {}, onDidChange: noOp, onDidCreate: noOp, onDidDelete: noOp }),
        openTextDocument: async value => ({ uri: value, isClosed: false, isDirty: false, getText: () => fs.readFile(value.fsPath, 'utf8') })
      },
      window: { async showTextDocument(doc, options) { displayed.push({ path: doc.uri.fsPath, options }); } },
      commands: { registerCommand: noOp }
    }
  };
}

test('pinned Kotlin and Javac trace Java JSpecify method contracts in a Spring JDBC Gradle project', {
  skip: !runtimeFile || !serverHome || !gradleHome || !gradleUserHome || !engines.every(([,file]) => file),
  timeout: 440000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-kotlin-null-proof-'));
  const root = path.join(owned, 'project'), runtime = await read(runtimeFile);
  const tools = { javaHome: runtime.javaHome, gradleHome, gradleUserHome };
  let jdt, kotlin, launch, service;
  t.after(async () => {
    service?.dispose();
    await Promise.allSettled([jdt?.close(), kotlin?.close()]);
    await launch?.dispose();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-kotlin-null-proof-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  await prepareNullabilityFixture(root, tools);
  const jdbc = await Promise.all(engines.map(async ([engine, file]) => [engine, await read(file)]));
  const initial = await Promise.all(jdbc.map(([engine, config]) => runJdbc(root, tools, config, engine)));
  const kotlinText = await brokenCalls(root);
  const kotlinPath = path.join(root, kotlinFile), javaPath = path.join(root, javaFile);
  const document = { uri: uri(kotlinPath), version: 1, languageId: 'kotlin', isDirty: false, isClosed: false,
    getText: () => kotlinText };
  const host = editorHost(document), projectUri = uri(root).toString();

  jdt = new StdioLsp(resolveLaunch({ javaHome: tools.javaHome, serverPath: runtime.serverPath, storagePath: path.join(owned, 'jdt') }));
  const settings = serverSettings([{ name: 'JavaSE-25', path: tools.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled = false;
  await jdt.request('initialize', { processId: process.pid, rootUri: projectUri,
    workspaceFolders: [{ uri: projectUri, name: 'mixed nullability' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true } },
    initializationOptions: { bundles: [], workspaceFolders: [projectUri], settings } }, 90000);
  jdt.notify('initialized', {});
  const classpath = () => jdt.request('workspace/executeCommand', {
    command: 'java.project.getClasspaths', arguments: [projectUri, { scope: 'runtime' }]
  }, 20000);
  assert.ok(await until(async () => {
    const cp = await classpath();
    return cp?.projectRoot && cp.classpaths.some(file => file.endsWith('jspecify-1.0.1.jar')) ? cp : undefined;
  }, 85000));

  launch = await kotlinEditorLaunch({ ...tools, serverHome, root, storageRoot: path.join(owned, 'ktlsp') });
  kotlin = new StdioLsp(launch);
  const started = await kotlin.request('initialize', { processId: process.pid, rootUri: projectUri, rootPath: root,
    workspaceFolders: [{ uri: projectUri, name: 'mixed nullability' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: { definition: { linkSupport: true } } } }, 90000);
  assert.equal(started.capabilities.definitionProvider, true);
  kotlin.notify('initialized', {});
  const textDocument = { uri: kotlinProtocolUri(kotlinPath) };
  kotlin.notify('textDocument/didOpen', { textDocument: { ...textDocument, languageId: 'kotlin', version: 1, text: kotlinText } });
  assert.ok(await until(async () => {
    const result = await kotlin.request('textDocument/definition',
      { textDocument, position: positionOf(kotlinText, 'Names.platform', 'Names.'.length) }, 20000);
    return (Array.isArray(result) ? result : [result]).find(link => (link?.targetUri || link?.uri)?.endsWith('/Names.java'));
  }, 85000));

  service = registerKotlinNullability(host.vscode, { output: { appendLine() {} },
    begin: async () => ({ root, compiler: launch.compiler, check() {}, classpath,
      request: (method, params) => kotlin.request(method, params, 30000) }) });
  const verified = [];
  for (const [name, codes] of Object.entries(markers)) {
    const result = await service.inspect({ document, position: positionOf(kotlinText, 'Names.' + name, 'Names.'.length) });
    assert.equal(result.target.file, javaPath);
    assert.equal(result.target.owner, 'mixed.rename.contract.Names');
    assert.equal(result.target.signature.split('(')[0].replace(/^<[^>]+>/u, ''), name);
    const language = (await fs.readFile(javaPath, 'utf8')).split('\n')[result.target.range.start.line];
    assert.equal(language.slice(result.target.range.start.character, result.target.range.end.character), name);
    const reported = result.diagnostics.map(item => item.code);
    for (const code of codes) assert.ok(reported.includes(code), name + ': ' + reported.join(', '));
    if (!codes.length) assert.deepEqual(reported, []);
    const diagnostics = host.published.get(document.uri.toString());
    assert.equal(diagnostics.length, reported.length);
    assert.ok(diagnostics.every(item => item.relatedInformation[0].location.uri.fsPath === javaPath));
    await service.openJava(result);
    const shown = host.displayed.at(-1);
    assert.equal(shown.path, javaPath);
    assert.deepEqual(shown.options.selection.start, result.target.range.start);
    verified.push({ name, diagnostics: reported, signature: result.target.signature,
      annotations: result.target.annotations, defaults: result.target.defaults, targetLine: result.target.range.start.line });
  }
  const ordinary = () => service.inspect({ document, position: positionOf(kotlinText, 'value.trim()', 'value.'.length) });
  await assert.rejects(ordinary, /same project's saved Java|same project’s saved Java|Kotlin could not resolve the Java/u);
  const stale = await service.inspect({ document, position: positionOf(kotlinText, 'Names.platform', 'Names.'.length) });
  const bytes = await fs.readFile(javaPath);
  stale.target.file = kotlinPath;
  await service.openJava(stale);
  assert.equal(host.displayed.at(-1).path, javaPath);
  await fs.appendFile(javaPath, '\n// The reviewed Java source changed.\n');
  await assert.rejects(service.openJava(stale), /Gradle project changed/u);
  host.notify(javaPath);
  assert.equal(host.published.size, 0);
  await fs.writeFile(javaPath, bytes);
  await restoreCalls(root, tools);
  const results = await Promise.all(jdbc.map(([engine, config]) => runJdbc(root, tools, config, engine)));
  assert.deepEqual(results, initial);
  const receipt = { scope: 'compiler-attributed-jspecify-call', server: launch.serverVersion, compiler: launch.compilerVersion,
    javacDeclaration: true, compilerDifferences: ['strict', 'ignore JSpecify', 'selected Java declaration neutralized'],
    linkedDiagnostics: verified, rejectedChangedSource: true, ordinaryKotlinExcluded: true, results };
  if (process.env.ROCKETBRAIN_MIXED_NULLABILITY_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_MIXED_NULLABILITY_RECEIPT,
    JSON.stringify(receipt, null, 2) + '\n');
});
