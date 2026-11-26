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
const { sourcePath, before: oldType, after: proposedType, selected, failures, selection, populateReturnNarrowing, runReturnNarrowing,
  assertReturnPlan } = require('./helpers/java-signature-return-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_RETURN_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_SIGNATURE_RETURN_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('real JDT and Javac apply private reference return narrowing with Spring on MySQL and MariaDB', {
  skip: !runtimeFile || !classpathFile || !engines.every(([, file]) => file), timeout: 350000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-sig-return-'));
  const root = path.join(owned, 'project'), runtime = await read(runtimeFile);
  let lsp, service, refactoring;
  t.after(async () => {
    await service?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    const real = await fs.realpath(owned);
    assert.equal(path.relative(owned, real), '');
    assert.equal(path.relative(parent, path.dirname(real)), '');
    assert.match(path.basename(real), /^rb-sig-return-/u);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  await populateReturnNarrowing(root, classpathFile, 'mysql');
  const fixtures = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
  const run = () => Promise.all(fixtures.map(async ([engine, database]) => runReturnNarrowing({
    javaHome: runtime.javaHome, root, classes: await fs.mkdtemp(path.join(owned, 'classes-')), database, engine, classpathFile
  })));
  const before = await run();
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'signature return narrowing' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: { documentChanges: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { workspace, vscode, save, submitted } = headlessHost(root, lsp);
  const declaration = await workspace.openTextDocument(uri(path.join(root, sourcePath)));
  let corrupt = null;
  const engineEdits = [];
  const request = async (method, args) => {
    const result = await lsp.request(method, args, 30000);
    if (method === 'java/getRefactorEdit') {
      engineEdits.push(args.commandArguments[4]);
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
  for (const [marker, proposed, reason] of failures) {
    const info = await inspect(marker);
    await assert.rejects(service.preview(info.id, { returnType: proposed }), reason);
  }
  assert.equal(engineEdits.length, 2);
  assert.equal(submitted.length, 0);
  const info = await inspect(selected);
  await assert.rejects(service.preview(info.id, { returnType: oldType }), /return type has not changed/u);
  await assert.rejects(service.preview(info.id, { returnType: proposedType, parameters: info.parameters }), /either an ordered/u);
  await assert.rejects(service.preview(info.id, { returnType: 'int' }), /fully qualified/u);
  corrupt = 'outside';
  await assert.rejects(service.preview(info.id, { returnType: proposedType }), /more than the reviewed return type/u);
  corrupt = 'comment';
  await assert.rejects(service.preview(info.id, { returnType: proposedType }), /plain reference return type/u);
  corrupt = null;
  const plan = await service.preview(info.id, { returnType: proposedType });
  assertReturnPlan(info, plan);
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
  if (process.env.ROCKETBRAIN_SIGNATURE_RETURN_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_SIGNATURE_RETURN_RECEIPT, JSON.stringify({
      returnNarrowing: plan.signature.returnNarrowing, preservedCalls: plan.signature.resolvedReferences,
      before, after, submitted: submitted.length, refusedSemanticOrScope: failures.length,
      staleReviewRefused: true, outOfTypeEditsRefused: true, inTypeCommentRefused: true
    }, null, 2) + '\n');
  }
});
