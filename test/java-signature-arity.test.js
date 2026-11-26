'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { registerJavaChangeSignature } = require('../src/java/change-signature');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { uri, headlessHost } = require('./helpers/java-signature-jdt-host');
const { sources, targetPath, unrelatedPath, marker, selection, rejected, primitiveFacts, instanceFacts,
  populateArity, runAritySpring, assertArityPlan } = require('./helpers/java-signature-arity-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_VARARGS_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_SIGNATURE_VARARGS_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('reviewed private varargs conversion preserves typed method references and saved Spring JDBC behavior', {
  skip: !runtimeFile || !classpathFile || !engines.every(([, file]) => file), timeout: 360000
}, async t => {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-signature-arity-'));
  const root = path.join(owned, 'project'), runtime = await read(runtimeFile);
  let lsp, service, refactoring;
  t.after(async () => {
    await service?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-signature-arity-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  await populateArity(root, classpathFile, 'mysql');
  const fixtures = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
  const run = () => Promise.all(fixtures.map(async ([engine, database]) => runAritySpring({
    javaHome: runtime.javaHome, root, classes: await fs.mkdtemp(path.join(owned, 'classes-')), database, engine, classpathFile
  })));
  const before = await run();
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'signature arity conversion' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: { documentChanges: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { workspace, vscode, save, submitted } = headlessHost(root, lsp);
  for (const unit of sources.keys()) await workspace.openTextDocument(uri(path.join(root, unit)));
  const declaration = await workspace.openTextDocument(uri(path.join(root, targetPath)));
  let nativeEdits = 0;
  const request = (method, args) => {
    if (method === 'java/getRefactorEdit') nativeEdits++;
    return lsp.request(method, args, 30000);
  };
  await until(async () => {
    const result = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [declaration.uri.toString(), { scope: 'test' }] });
    return result?.projectRoot && result.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar'));
  }, 85000);
  const context = { globalStorageUri: uri(path.join(owned, 'compiler')) };
  refactoring = registerJavaRefactoring(context, vscode, { request });
  service = registerJavaChangeSignature(context, vscode, { request, refactoring, getJavaHome: () => runtime.javaHome });
  const inspect = at => service.info(declaration, selection(declaration.getText(), at));
  for (const [at, reason] of rejected) await assert.rejects(inspect(at), reason);
  const collision = await inspect('collision(Object');
  assert.equal(collision.arityConversion.spreadCalls, 1);
  await assert.rejects(service.preview(collision.id, { arity: 'array' }), /overload resolution or an unrelated caller binding/u);
  const info = await inspect(marker);
  await assert.rejects(service.preview(info.id, { arity: 'varargs' }), /reviewed private varargs/u);
  await assert.rejects(service.preview(info.id, { arity: 'array', parameters: info.parameters }), /Review one .* change/u);
  const plan = await service.preview(info.id, { arity: 'array' });
  assertArityPlan(info, plan);
  const unrelated = path.join(root, unrelatedPath);
  const original = sources.get(unrelatedPath);
  await fs.appendFile(unrelated, '// Scope changed after review\n');
  try { await assert.rejects(refactoring.apply(plan.id), /source changed|membership changed|after review/u); }
  finally { await fs.writeFile(unrelated, original); }
  assert.equal(submitted.length, 0);
  assert.equal((await refactoring.apply(plan.id)).state, 'applied');
  await save();
  const primitive = await inspect('sum(int');
  const primitivePlan = await service.preview(primitive.id, { arity: 'array' });
  assertArityPlan(primitive, primitivePlan, primitiveFacts);
  assert.equal((await refactoring.apply(primitivePlan.id)).state, 'applied');
  assert.equal(submitted.length, 2);
  await save();
  const instance = await inspect('collect(String');
  const instancePlan = await service.preview(instance.id, { arity: 'array' });
  assertArityPlan(instance, instancePlan, instanceFacts);
  assert.equal((await refactoring.apply(instancePlan.id)).state, 'applied');
  assert.equal(submitted.length, 3);
  assert.equal(nativeEdits, 0);
  await save();
  assert.equal(await fs.readFile(unrelated, 'utf8'), original);
  const after = await run();
  assert.deepEqual(after, before);
  const receipt = { referenceArray: plan.signature.arityConversion, primitiveArray: primitivePlan.signature.arityConversion,
    instanceArray: instancePlan.signature.arityConversion, refusedUnsupportedContracts: rejected.map(([target])=>target),
    changedOverloadRefused: true, staleReviewRefused: true,
    explicitArrayIdentityAndOrderVerified: true, realJdtImportedProject: true, before, after };
  if (process.env.ROCKETBRAIN_SIGNATURE_ARITY_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_SIGNATURE_ARITY_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  }
});
