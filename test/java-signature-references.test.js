'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerJavaChangeSignature, editedSources } = require('../src/java/change-signature');
const { registerJavaRefactoring, editedText } = require('../src/java/refactoring');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { springJdbcClasspath } = require('./helpers/instance-inline-fixture');
const { sources, targetPath, clientPath, negativeTargets, operations, selection, nextParameters, assertPlan,
  populateSignatureReferences, runSignatureSpring } = require('./helpers/java-signature-references-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_REF_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_SIGNATURE_REF_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

function headlessHost(root, lsp) {
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
      const id = key(address.fsPath);
      if (documents.has(id)) return documents.get(id);
      const document = { uri: address, languageId: 'java', version: 1, isClosed: false, isDirty: false,
        text: await fs.readFile(address.fsPath, 'utf8'), getText() { return this.text; } };
      documents.set(id, document);
      lsp.notify('textDocument/didOpen', { textDocument: { uri: address.toString(), languageId: 'java', version: 1,
        text: document.text } });
      return document;
    },
    async applyEdit(edit) {
      assert.ok(edit instanceof WorkspaceEdit);
      for (const [address, changes] of edit.entries) {
        const document = await this.openTextDocument(address);
        document.text = editedText(document.text, changes);
        document.version++;
        document.isDirty = true;
        lsp.notify('textDocument/didChange', { textDocument: { uri: address.toString(), version: document.version },
          contentChanges: [{ text: document.text }] });
      }
      submitted.push(edit);
      return true;
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} })
  };
  async function save() {
    for (const doc of documents.values()) {
      if (!doc.isDirty) continue;
      await fs.writeFile(doc.uri.fsPath, doc.text);
      doc.isDirty = false;
      lsp.notify('textDocument/didSave', { textDocument: { uri: doc.uri.toString() } });
    }
  }
  return { workspace, save, submitted, vscode: { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) },
    workspace, Range, TextEdit, WorkspaceEdit, commands: { registerCommand: () => ({ dispose() {} }) } } };
}

test('real JDT Change Signature and Javac keep method references callable on both Spring JDBC servers', {
  skip: !runtimeFile || !classpathFile || !engines.every(([,file]) => file), timeout: 280000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-signature-ref-'));
  const root = path.join(owned, 'project'), runtime = await read(runtimeFile);
  let lsp, signature, refactoring;
  t.after(async () => {
    await signature?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-signature-ref-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await populateSignatureReferences(root, await springJdbcClasspath(classpathFile, 'mysql'));
  const configs = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
  const run = () => Promise.all(configs.map(async ([engine, database]) =>
    runSignatureSpring({ javaHome: runtime.javaHome, root, database, engine, classpathFile,
      classes: await fs.mkdtemp(path.join(owned, 'classes-')) })));
  const baseline = await run();
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'signature references' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: { documentChanges: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { workspace, vscode, save, submitted } = headlessHost(root, lsp);
  for (const input of sources.keys()) await workspace.openTextDocument(uri(path.join(root, input)));
  const declaration = await workspace.openTextDocument(uri(path.join(root, targetPath)));
  const caller = await workspace.openTextDocument(uri(path.join(root, clientPath)));
  const engineEdits = [];
  const request = async (method, args) => {
    const result = await lsp.request(method, args, 30000);
    if (method === 'java/getRefactorEdit') engineEdits.push(result);
    return result;
  };
  await until(async () => {
    const model = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [declaration.uri.toString(), { scope: 'test' }] });
    return model?.projectRoot && model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar'));
  }, 85000);
  const storage = { globalStorageUri: uri(path.join(owned, 'compiler')) };
  refactoring = registerJavaRefactoring(storage, vscode, { request });
  signature = registerJavaChangeSignature(storage, vscode, { request, refactoring, getJavaHome: () => runtime.javaHome });
  const inspect = marker => signature.info(declaration, selection(declaration.getText(), marker));
  const completed = [];
  for (const operation of operations) {
    const info = await inspect(operation.marker);
    assert.equal(info.adaptableMethodReferences, operation.refs);
    const plan = await signature.preview(info.id, { parameters: nextParameters(info, operation.operation) });
    const report = assertPlan(plan, operation);
    const raw = engineEdits.at(-1).edit;
    const originals = workspace.textDocuments.map(doc => ({ uri: doc.uri.toString(), text: doc.getText() }));
    const plain = editedSources(originals, [...Object.entries(raw.changes || {}),
      ...(raw.documentChanges || []).map(entry => [entry.textDocument.uri, entry.edits])]).map(doc => doc.text).join('\n');
    for (const reference of operation.references) assert.ok(plain.includes(reference), 'Pinned JDT raw reference ' + reference);
    if (!completed.length) {
      await fs.appendFile(caller.uri.fsPath, '// changed after review\n');
      await assert.rejects(refactoring.apply(plan.id), /source changed|membership changed/u);
      await fs.writeFile(caller.uri.fsPath, caller.getText());
      assert.equal(submitted.length, 0);
    }
    assert.equal((await refactoring.apply(plan.id)).state, 'applied');
    await assert.rejects(refactoring.apply(plan.id), /expired/u);
    await save();
    const result = await run();
    assert.deepEqual(result, baseline);
    completed.push({ ...report, rawJdtRetainsReference: true, result });
  }

  const refused = [];
  const count = engineEdits.length;
  for (const [marker, label] of negativeTargets) {
    await assert.rejects(inspect(marker), /Method or constructor references need additional signature adaptation analysis/u);
    refused.push(label);
  }
  assert.equal(engineEdits.length, count);
  assert.equal(submitted.length, 3);
  assert.equal(completed.reduce((sum, check) => sum + check.adapters, 0), 4);
  const receipt = { scope: 'compiler-attributed-method-reference-adapters', completed, refused, staleReviewRefused: true,
    exactSamAndOverloadsVerified: true, unrelatedLambdaAndMethodReferencePreserved: true, bothDbServers: baseline };
  if (process.env.ROCKETBRAIN_SIGNATURE_REF_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SIGNATURE_REF_RECEIPT,
    JSON.stringify(receipt, null, 2) + '\n');
});
