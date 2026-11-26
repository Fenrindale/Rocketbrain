'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { fileURLToPath } = require('node:url');
const { registerJavaChangeSignature, editedSources } = require('../src/java/change-signature');
const { verifyVarargsPermutation } = require('../src/java/change-signature-varargs');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { uri, headlessHost } = require('./helpers/java-signature-jdt-host');
const { sources, targetPath, callerPath, marker, negativeTargets, parameters, selection, populateVarargs,
  runVarargsSpring, assertVarargsPlan } = require('./helpers/java-signature-varargs-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_VARARGS_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_SIGNATURE_VARARGS_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('varargs edits accept a fixed permutation with the original tail last', () => {
  const facts = { fixedCount: 2 }, items = values => values.map(originalIndex => ({ originalIndex }));
  verifyVarargsPermutation(facts, items([1, 0, 2]));
  for (const invalid of [[1, 2, 0], [1, 0], [1, -1, 2], [1, 1, 2], [1, 0, 2, -1]]) {
    assert.throws(() => verifyVarargsPermutation(facts, items(invalid)), /keep the original varargs parameter last/u);
  }
});

const corruptions = [
  { from: 'combine("b", "a")', to: 'combine("a", "b")', reason: /argument sequence/u },
  { from: 'combine("f", "e", supplied)', to: 'combine("f", "e", (Object) supplied)', reason: /fixed-array versus spread/u },
  { from: 'take("x"), take("y")', to: 'take("y"), take("x")', reason: /argument sequence/u }
];

test('real JDT reorders varargs fixed parameters and preserves actual Spring JDBC calls on MySQL and MariaDB', {
  skip: !runtimeFile || !classpathFile || !engines.every(([, file]) => file), timeout: 320000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-sig-varargs-'));
  const root = path.join(owned, 'project'), runtime = await read(runtimeFile);
  let lsp, service, refactoring;
  t.after(async () => {
    await service?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-sig-varargs-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  await populateVarargs(root, classpathFile, 'mysql');
  const fixtures = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
  const run = () => Promise.all(fixtures.map(async ([engine, database]) => runVarargsSpring({
    javaHome: runtime.javaHome, root, classes: await fs.mkdtemp(path.join(owned, 'classes-')), database, engine, classpathFile
  })));
  const before = await run();
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'signature varargs' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: { documentChanges: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { workspace, vscode, save, submitted } = headlessHost(root, lsp);
  for (const input of sources.keys()) await workspace.openTextDocument(uri(path.join(root, input)));
  const declaration = await workspace.openTextDocument(uri(path.join(root, targetPath)));
  const caller = await workspace.openTextDocument(uri(path.join(root, callerPath)));
  let corrupt, editCount = 0;
  const request = async (method, args) => {
    const result = await lsp.request(method, args, 30000);
    if (method !== 'java/getRefactorEdit') return result;
    editCount++;
    if (!corrupt || !result?.edit) return result;
    const affected = [...Object.entries(result.edit.changes || {}), ...(result.edit.documentChanges || [])
      .map(change => [change.textDocument.uri, change.edits])];
    const callerUri = caller.uri.toString();
    const original = caller.getText();
    const [projected] = editedSources([{ uri: callerUri, text: original }], affected);
    assert.ok(projected.text.includes(corrupt.from), 'The owned JDT result must contain the rewritten call.');
    const isCaller = value => !path.relative(caller.uri.fsPath, fileURLToPath(value));
    const lines = original.split('\n');
    result.edit.changes = Object.fromEntries(Object.entries(result.edit.changes || {}).filter(([value]) => !isCaller(value)));
    if (result.edit.documentChanges) {
      result.edit.documentChanges = result.edit.documentChanges.filter(change => !isCaller(change.textDocument.uri));
    }
    result.edit.changes[callerUri] = [{
      range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } },
      newText: projected.text.replace(corrupt.from, corrupt.to)
    }];
    return result;
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
  for (const [at, reason] of negativeTargets) await assert.rejects(inspect(at), reason);
  assert.equal(editCount, 0);
  const info = await inspect(marker);
  await assert.rejects(service.preview(info.id, { parameters: [...info.parameters].reverse() }), /keep the original varargs parameter last/u);
  assert.equal(editCount, 0);
  const proposed = parameters(info);
  for (const change of corruptions) {
    corrupt = change;
    await assert.rejects(service.preview(info.id, { parameters: proposed }), change.reason);
  }
  corrupt = undefined;
  assert.equal(submitted.length, 0);
  const plan = await service.preview(info.id, { parameters: proposed }).catch(error => {
    throw Error('Clean JDT preview failed after the rejected test edits.', { cause: error });
  });
  assertVarargsPlan(info, plan);
  await fs.appendFile(caller.uri.fsPath, '// Changed after review\n');
  try { await assert.rejects(refactoring.apply(plan.id), /source changed|membership changed/u); }
  finally { await fs.writeFile(caller.uri.fsPath, caller.getText()); }
  assert.equal(submitted.length, 0);
  assert.equal((await refactoring.apply(plan.id)).state, 'applied');
  assert.equal(submitted.length, 1);
  await save();
  const after = await run();
  assert.deepEqual(after, before);
  const report = { invocationModes: plan.signature.varargs, verifiedCalls: plan.signature.resolvedReferences,
    before, after, corruptedEditsRefused: corruptions.length, refusedBeforeJdt: negativeTargets.length,
    varargsSlotRefused: true, staleReviewRefused: true };
  if (process.env.ROCKETBRAIN_SIGNATURE_VARARGS_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SIGNATURE_VARARGS_RECEIPT,
    JSON.stringify(report, null, 2) + '\n');
});
