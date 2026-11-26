'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { registerJavaChangeSignature, editedSources } = require('../src/java/change-signature');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { springJdbcClasspath } = require('./helpers/instance-inline-fixture');
const { sources, targetPath, clientPath, negativeTargets, operations, selection, nextParameters, assertPlan,
  populateSignatureReferences, runSignatureSpring } = require('./helpers/java-signature-references-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_REF_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_SIGNATURE_REF_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const { uri, headlessHost } = require('./helpers/java-signature-jdt-host');

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
