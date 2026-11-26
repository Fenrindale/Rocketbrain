'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { registerJavaSafeDelete } = require('../src/java/safe-delete');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, positionOf, until } = require('./helpers/stdio-lsp');
const { uri, headlessHost } = require('./helpers/java-signature-jdt-host');
const { target, fixtureSources, sourceFolder, negatives,
  populateConstructorDelete, runConstructorSpring } = require('./helpers/java-constructor-delete-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_CONSTRUCTOR_DELETE_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_CONSTRUCTOR_DELETE_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('actual JDT and javac Safe Delete preserves direct constructor evaluation, Spring injection and both JDBC results', {
  skip: !runtimeFile || !classpathFile || !engines.every(([, file]) => file), timeout: 400000
}, async t => {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-constructor-delete-'));
  const root = path.join(owned, 'project'), runtime = await read(runtimeFile);
  let lsp, service, refactoring;
  t.after(async () => {
    await service?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-constructor-delete-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  await populateConstructorDelete(root, classpathFile, 'mysql');
  const fixtures = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
  const run = stage => Promise.all(fixtures.map(async ([engine, database]) => runConstructorSpring({
    javaHome: runtime.javaHome, root, work: path.join(owned, stage, engine), database, engine, classpathFile
  })));
  const before = await run('before');
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', {
    processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'constructor-safe-delete' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false, workspaceEdit: { documentChanges: true } },
      textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings }
  }, 90000);
  lsp.notify('initialized', {});
  const { workspace, vscode, save, submitted } = headlessHost(root, lsp);
  for (const unit of fixtureSources.keys()) await workspace.openTextDocument(uri(path.join(root, unit)));
  const declaration = await workspace.openTextDocument(uri(path.join(root, target)));
  let omitCaller = false;
  const request = async (method, args) => {
    const result = await lsp.request(method, args, 30000);
    if (omitCaller && method === 'textDocument/references' && args.context.includeDeclaration) return result.slice(0, -1);
    return result;
  };
  await until(async () => {
    const model = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [declaration.uri.toString(), { scope: 'test' }] });
    return model?.projectRoot && model.classpaths.some(file => file.endsWith('spring-context-7.0.10.jar'));
  });
  const context = { globalStorageUri: uri(path.join(owned, 'compiler')) };
  refactoring = registerJavaRefactoring(context, vscode, { request });
  service = registerJavaSafeDelete(context, vscode, { request, refactoring, runtime: () => ({
    javaHome: runtime.javaHome, storagePath: context.globalStorageUri.fsPath
  }) });
  const caret = positionOf(declaration.getText(), 'discardedSlot', 2);
  await assert.rejects(service.prepare(declaration, positionOf(declaration.getText(), 'int discardedSlot', 1)), /exact name/u);
  omitCaller = true;
  await assert.rejects(service.prepare(declaration, caret), /disagree about constructor reference coverage/u);
  omitCaller = false;
  const plan = await service.prepare(declaration, caret);
  assert.deepEqual(plan.safeDelete.kind, 'constructor-parameter');
  assert.equal(plan.safeDelete.updatedConstructorCallers, 2);
  assert.equal(plan.safeDelete.jdtAndJavacVerified, true);
  assert.equal(plan.documents.length, 1);
  assert.match(plan.documents[0].after, /AdjustedCounter\(int left, int right\)/u);
  assert.match(plan.documents[0].after, /new AdjustedCounter\(count\("A", 11\), count\("B", 9\)\)/u);
  assert.match(plan.documents[0].after, /new AdjustedCounter\(count\("C", 12\), count\("D", 10\)\)/u);
  const changed = path.join(root, 'safeDeleteContract.properties');
  await fs.writeFile(changed, 'fixture=changed\n', { flag: 'wx' });
  try { await assert.rejects(service.apply(plan.id), /file set changed|after review/u); }
  finally { await fs.rm(changed); }
  assert.equal(submitted.length, 0);
  assert.equal((await service.apply(plan.id)).state, 'applied');
  assert.equal(submitted.length, 1);
  await save();
  await assert.rejects(service.apply(plan.id), /expired/u);

  for (const [name, parameter, error] of negatives) {
    const doc = await workspace.openTextDocument(uri(path.join(root, sourceFolder, name + '.java')));
    await assert.rejects(service.prepare(doc, positionOf(doc.getText(), parameter, 2)), error, name);
  }
  const after = await run('after');
  assert.deepEqual(after, before);
  const report = { directCallSites: 2, jdtAndJavacVerified: true, wholeEditDispatches: submitted.length,
    usedOrProtectedOrUnsafeRefused: negatives.map(([name]) => name), newResourceRejected: true, missingJdtCallerRejected: true,
    bindingAndArgumentOrderRetained: true, before, after };
  if (process.env.ROCKETBRAIN_CONSTRUCTOR_DELETE_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_CONSTRUCTOR_DELETE_RECEIPT, JSON.stringify(report, null, 2) + '\n');
  }
});
