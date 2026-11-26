'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerJavaSafeDelete } = require('../src/java/safe-delete');
const { registerJavaRefactoring, editedText } = require('../src/java/refactoring');
const { possibleFactoryAnnotations } = require('../src/java/spring-binary-lifecycle');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { beanPath, factoryPath, markers, bean, factory, maven, populateBinaryLifecycle, runBinaryLifecycle, position, exactConflict } =
  require('./helpers/spring-binary-lifecycle-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome = process.env.ROCKETBRAIN_BINARY_LIFECYCLE_MAVEN_HOME;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_BINARY_LIFECYCLE_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });

test('trigger identifies external annotations on the exact named factory return type', () => {
  const inputs = { uri: 'file:///LifecycleFactory.java', text: factory };
  assert.deepEqual(possibleFactoryAnnotations([inputs], 'fixture.lifecycle.LifecycleValue').map(item => [item.annotation, item.range.start.line]),
    [['fixture.binary.ExternalLifecycle', 4], ['fixture.binary.ExternalLifecycle', 5]]);
  assert.deepEqual(possibleFactoryAnnotations([inputs], 'fixture.lifecycle.Other'), []);
  const interleaved = { ...inputs, text: factory.replace('@ExternalLifecycle public', 'public @ExternalLifecycle') };
  assert.equal(possibleFactoryAnnotations([interleaved], 'fixture.lifecycle.LifecycleValue').length, 2);
});

function headless(root, lsp) {
  const documents = new Map(), submitted = [];
  class Range {
    constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
  }
  class TextEdit { constructor(range, newText) { Object.assign(this, { range, newText }); } }
  class WorkspaceEdit {
    constructor() { this.entries = []; }
    set(value, edits) { this.entries.push([value, edits]); }
  }
  const workspace = {
    isTrusted: true,
    get textDocuments() { return [...documents.values()]; },
    getWorkspaceFolder(address) {
      const relative = path.relative(root, address.fsPath);
      if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return { uri: uri(root) };
    },
    async openTextDocument(address) {
      const id = address.fsPath.toLowerCase();
      if (documents.has(id)) return documents.get(id);
      const document = { uri: address, languageId: address.fsPath.endsWith('.java') ? 'java' : 'xml', version: 1, isClosed: false,
        isDirty: false, text: await fs.readFile(address.fsPath, 'utf8'), getText() { return this.text; } };
      documents.set(id, document);
      if (document.languageId === 'java') lsp.notify('textDocument/didOpen', { textDocument: { uri: address.toString(),
        languageId: 'java', version: 1, text: document.text } });
      return document;
    },
    async applyEdit(edit) {
      assert.ok(edit instanceof WorkspaceEdit);
      for (const [address, changes] of edit.entries) {
        const document = await this.openTextDocument(address);
        await rewrite(document, editedText(document.text, changes), false);
      }
      submitted.push(edit);
      return true;
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} })
  };
  async function rewrite(document, text, save) {
    document.text = text;
    document.version++;
    document.isDirty = true;
    lsp.notify('textDocument/didChange', { textDocument: { uri: document.uri.toString(), version: document.version },
      contentChanges: [{ text }] });
    if (!save) return;
    await fs.writeFile(document.uri.fsPath, text);
    document.isDirty = false;
    lsp.notify('textDocument/didSave', { textDocument: { uri: document.uri.toString() } });
  }
  const vscode = { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) }, workspace, Range, TextEdit, WorkspaceEdit,
    commands: { registerCommand: () => ({ dispose() {} }) } };
  return { vscode, workspace, submitted, rewrite };
}

test('actual JDT Safe Delete protects compiled Spring lifecycle declarations and preserves both JDBC apps', {
  skip: !runtimeFile || !mavenHome || !engines.every(([, file]) => file), timeout: 320000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-binary-lifecycle-'));
  const root = path.join(owned, 'project'), java = await read(runtimeFile), tools = { javaHome: java.javaHome, mavenHome };
  let lsp, service, refactoring;
  t.after(async () => {
    await service?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-binary-lifecycle-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const fixture = await populateBinaryLifecycle(root, path.join(owned, 'aux'), tools, { addEclipse: true });
  const configs = await Promise.all(engines.map(async ([engine, file]) => [engine, await read(file)]));
  const runBoth = () => Promise.all(configs.map(([engine, config]) => runBinaryLifecycle(fixture, tools, config, engine)));
  const before = await runBoth();
  const settings = serverSettings([{ name: 'JavaSE-25', path: java.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  settings.java.import.maven.enabled = false;
  if (settings.java.import.gradle) settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...java, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'binary lifecycle' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: { documentChanges: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const host = headless(root, lsp);
  const selected = await host.workspace.openTextDocument(uri(path.join(root, beanPath)));
  const config = await host.workspace.openTextDocument(uri(path.join(root, factoryPath)));
  let duplicate;
  const request = async (method, params) => {
    const result = await lsp.request(method, params, 30000);
    if (duplicate && method === 'workspace/executeCommand' && params.command === 'java.project.getClasspaths' && result?.classpaths) {
      return { ...result, classpaths: [...result.classpaths, duplicate] };
    }
    return result;
  };
  await until(async () => {
    const response = await request('workspace/executeCommand', {command: 'java.project.getClasspaths',
      arguments: [selected.uri.toString(), { scope: 'runtime' }] });
    return response?.projectRoot && response.classpaths.some(file => file.endsWith('external-lifecycle.jar'));
  }, 85000);
  const state = { javaHome: tools.javaHome, storagePath: path.join(owned, 'compiler') };
  const extension = { globalStorageUri: uri(state.storagePath) };
  refactoring = registerJavaRefactoring(extension, host.vscode, { request });
  service = registerJavaSafeDelete(extension, host.vscode, { request, refactoring, runtime: () => state });
  const inspect = async marker => (await service.inspect(selected, position(selected, marker))).springAnalysis;
  const prepare = marker => service.prepare(selected, position(selected, marker));
  const checked = [];
  for (const [marker, reason] of [[markers.default, 'binary-alias-default'], [markers.explicit, 'source-alias'],
    [markers.shutdown, 'binary-meta']]) {
    checked.push(exactConflict(await inspect(marker), marker, reason));
  }
  await assert.rejects(prepare(markers.default), error => error.code === 'ROCKETBRAIN_SAFE_DELETE_CONFLICT' &&
    error.springAnalysis.conflicts.some(item => item.kind === 'spring.binary-bean-lifecycle'));
  assert.equal(host.submitted.length, 0);
  duplicate = path.join(owned, 'duplicate.jar');
  await fs.copyFile(fixture.archive, duplicate);
  let refused = await inspect(markers.unused);
  assert.equal(refused.verdict, 'unknown');
  assert.ok(refused.unknowns.some(item => item.reason === 'unverified-binary-origin'));
  duplicate = undefined;
  await host.rewrite(config, factory.replaceAll('ExternalLifecycle', 'AmbiguousLifecycle'), true);
  refused = await inspect(markers.unused);
  assert.equal(refused.verdict, 'unknown');
  assert.ok(refused.unknowns.some(item => item.reason === 'unsupported-binary-contract'));
  await host.rewrite(config, factory, true);
  const computed = factory.replace('public class LifecycleFactory {', 'public class LifecycleFactory {\n    private static final String SOURCE = "sourceChosen";')
    .replace('warmStart = "sourceChosen"', 'warmStart = SOURCE');
  await host.rewrite(config, computed, true);
  refused = await inspect(markers.unused);
  assert.equal(refused.verdict, 'unknown');
  assert.ok(refused.unknowns.some(item => item.reason === 'unsupported-source-value'));
  await host.rewrite(config, factory, true);
  const plan = await prepare(markers.unused);
  assert.equal(plan.springAnalysis.verdict, 'allowed');
  assert.equal(plan.springAnalysis.binaryLifecycle.state, 'inspected');
  const bytes = await fs.readFile(fixture.archive);
  await fs.appendFile(fixture.archive, Buffer.from([0]));
  try { await assert.rejects(service.apply(plan.id), /classpath changed after signature inspection/u); }
  finally { await fs.writeFile(fixture.archive, bytes); }
  const clean = await prepare(markers.unused);
  assert.equal((await service.apply(clean.id)).state, 'applied');
  assert.equal(host.submitted.length, 1);
  assert.doesNotMatch(selected.getText(), /unreferencedHelper/u);
  await host.rewrite(selected, selected.getText(), true);
  await maven(tools, root, ['compile']);
  const after = await runBoth();
  assert.deepEqual(after, before);
  assert.ok(bean.includes(markers.unused));
  if (process.env.ROCKETBRAIN_BINARY_LIFECYCLE_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_BINARY_LIFECYCLE_RECEIPT,
    JSON.stringify({ checked, before, after, duplicateRefused: true, ambiguousRefused: true, computedSourceRefused: true, staleRefused: true,
      unreferencedApplied: true, processorsDisabled: true, noProjectCodeDuringReview: true }, null, 2) + '\n');
});
