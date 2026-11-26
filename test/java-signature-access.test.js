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
const { sourcePath, sharedPath, siblingPath, selected, failures, selection, populateAccessProject, populateAccessSibling,
  compareSeparateCaller, runAccessProject, assertAccessPlan } = require('./helpers/java-signature-access-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_ACCESS_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_SIGNATURE_ACCESS_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('real JDT and Javac apply package-private to private Java access with Spring on MySQL and MariaDB', {
  skip: !runtimeFile || !classpathFile || !engines.every(([, file]) => file), timeout: 350000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-sig-access-'));
  const root = path.join(owned, 'project'), siblingRoot = path.join(owned, 'sibling'), runtime = await read(runtimeFile);
  let lsp, service, refactoring;
  t.after(async () => {
    await service?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    const real = await fs.realpath(owned);
    assert.equal(path.relative(owned, real), '');
    assert.equal(path.relative(parent, path.dirname(real)), '');
    assert.match(path.basename(real), /^rb-sig-access-/u);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  await populateAccessProject(root, classpathFile, 'mysql');
  await populateAccessSibling(siblingRoot, path.basename(root));
  for (const makePrivate of [false, true]) {
    await compareSeparateCaller({ javaHome: runtime.javaHome, root, siblingRoot, makePrivate,
      base: await fs.mkdtemp(path.join(owned, 'sibling-compile-')) });
  }
  const fixtures = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
  const run = () => Promise.all(fixtures.map(async ([engine, database]) => runAccessProject({
    javaHome: runtime.javaHome, root, classes: await fs.mkdtemp(path.join(owned, 'classes-')), database, engine, classpathFile
  })));
  const before = await run();
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled = false;
  const rootUri = uri(owned).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'signature access change' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: { documentChanges: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { workspace, vscode, save, submitted } = headlessHost(owned, lsp);
  const declaration = await workspace.openTextDocument(uri(path.join(root, sourcePath)));
  let corrupt = null, hideSibling = false;
  const engineEdits = [];
  const request = async (method, args) => {
    const result = await lsp.request(method, args, 30000);
    if (method === 'textDocument/references' && hideSibling) {
      return result.filter(item => !item.uri.includes('/sibling/'));
    }
    if (method === 'java/getRefactorEdit') {
      engineEdits.push(args.commandArguments[3]);
      if (result?.edit && corrupt === 'outside') {
        (result.edit.changes ??= {})[declaration.uri.toString()] ??= [];
        result.edit.changes[declaration.uri.toString()].push({
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// unrelated\n'
        });
      } else if (result?.edit && corrupt === 'comment') {
        const edits = [...Object.values(result.edit.changes || {}), ...((result.edit.documentChanges || []).map(change => change.edits))].flat();
        assert.ok(edits.length > 0);
        edits[0].newText += ' /* unrelated comment */';
      }
    }
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
  const inspect = marker => service.info(declaration, selection(declaration.getText(), marker));
  const shared = await workspace.openTextDocument(uri(path.join(root, sharedPath)));
  await workspace.openTextDocument(uri(path.join(siblingRoot, siblingPath)));
  const sharedRange = selection(shared.getText(), 'siblingValue(int');
  await until(async () => {
    const references = await request('textDocument/references', { textDocument: { uri: shared.uri.toString() },
      position: sharedRange.start, context: { includeDeclaration: false } });
    return references?.some(item => item.uri.includes('/sibling/') && item.uri.endsWith('/SiblingClient.java'));
  }, 60000);
  await assert.rejects(service.info(shared, sharedRange), /Callers outside this Maven\/Gradle project/u);
  hideSibling = true;
  const unindexed = await service.info(shared, sharedRange);
  assert.equal(unindexed.visibilityChange, undefined);
  await assert.rejects(service.preview(unindexed.id, { visibility: 'private' }), /closed Java source nest/u);
  hideSibling = false;

  for (const [marker, reason] of failures) await assert.rejects(inspect(marker), reason);
  assert.equal(engineEdits.length, 0);
  const info = await inspect(selected);
  await assert.rejects(service.preview(info.id, { parameters: info.parameters }), /reviewed access change/u);
  await assert.rejects(service.preview(info.id, { visibility: 'protected' }), /reviewed change to private/u);
  await assert.rejects(service.preview(info.id, { visibility: 'private', parameters: info.parameters }), /either an ordered/u);
  corrupt = 'outside';
  await assert.rejects(service.preview(info.id, { visibility: 'private' }), /reviewed private modifier insertion/u);
  corrupt = 'comment';
  await assert.rejects(service.preview(info.id, { visibility: 'private' }), /reviewed private modifier insertion/u);
  corrupt = null;
  const plan = await service.preview(info.id, { visibility: 'private' });
  assertAccessPlan(info, plan);
  assert.equal(engineEdits.at(-1), 'private');
  const file = declaration.uri.fsPath;
  await fs.appendFile(file, '// changed after review\n');
  try { await assert.rejects(refactoring.apply(plan.id), /source changed|membership changed/u); }
  finally { await fs.writeFile(file, declaration.getText()); }
  assert.equal(submitted.length, 0);
  assert.equal((await refactoring.apply(plan.id)).state, 'applied');
  assert.equal(declaration.getText(), plan.documents[0].after);
  await save();
  assert.equal(submitted.length, 1);
  const after = await run();
  assert.deepEqual(after, before);
  if (process.env.ROCKETBRAIN_SIGNATURE_ACCESS_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_SIGNATURE_ACCESS_RECEIPT, JSON.stringify({
      visibilityChange: plan.signature.visibilityChange, preservedCalls: plan.signature.resolvedReferences,
      before, after, submitted: submitted.length, refusedScope: failures.length, indexedCrossProjectCallerRefused: true,
      externalCallerCompiledBeforeOnly: true, unindexedOrdinaryPackageMemberRefused: true, staleReviewRefused: true,
      outOfModifierEditsRefused: true, inModifierCommentRefused: true
    }, null, 2) + '\n');
  }
});
