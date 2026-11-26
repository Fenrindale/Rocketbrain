'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { fileURLToPath } = require('node:url');
const { registerJavaChangeSignature } = require('../src/java/change-signature');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { uri, headlessHost } = require('./helpers/java-signature-jdt-host');
const { declaration, implementation, caller, chosen, selected, sources, selection, createParameterReactor,
  buildParameterReactor, runParameterSpring, assertParameterPlan } = require('./helpers/java-parameter-rename-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_PARAMETER_RENAME_CLASSPATH;
const mavenHome = process.env.ROCKETBRAIN_PARAMETER_RENAME_MAVEN;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_PARAMETER_RENAME_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const same = (a, b) => path.relative(a, b) === '';

test('JDT and Javac rename only a formal parameter across a real interface family and Spring Maven reactor', {
  skip: !runtimeFile || !classpathFile || !mavenHome || !engines.every(([, file]) => file), timeout: 360000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-param-name-'));
  const root = path.join(owned, 'contract-application'), runtime = await read(runtimeFile);
  let lsp, service, refactoring;
  t.after(async () => {
    await service?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    const real = await fs.realpath(owned);
    assert.ok(same(owned, real) && same(parent, path.dirname(real)) && path.basename(real).startsWith('rb-param-name-'));
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const app = await createParameterReactor(root), tools = { javaHome: runtime.javaHome, mavenHome };
  const fixtures = await Promise.all(engines.map(async ([engine, file]) => [engine, await read(file)]));
  const run = () => Promise.all(fixtures.map(([engine, database]) => runParameterSpring({
    javaHome: runtime.javaHome, root, classpathFile, database, engine
  })));
  await buildParameterReactor(root, tools);
  const before = await run();
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'parameter family' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: { documentChanges: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { workspace, vscode, save, submitted } = headlessHost(root, lsp);
  const address = uri(path.join(app, declaration));
  let corrupt, requested = 0;
  const request = async (method, args) => {
    const result = await lsp.request(method, args, 90000);
    if (method !== 'java/getRefactorEdit') return result;
    requested++;
    if (result?.edit && corrupt) {
      const file = uri(path.join(app, corrupt === 'caller' ? caller : implementation)).toString();
      (result.edit.changes ??= {})[file] ??= [];
      result.edit.changes[file].push({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// unrelated\n'
      });
    }
    return result;
  };
  await until(async () => {
    const packet = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [address.toString(), { scope: 'test' }] });
    return packet?.projectRoot && same(app, fileURLToPath(packet.projectRoot)) &&
      packet.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar'));
  }, 120000);
  const docs = new Map();
  for (const name of sources.keys()) docs.set(name, await workspace.openTextDocument(uri(path.join(app, name))));
  const target = docs.get(declaration);
  const context = { globalStorageUri: uri(path.join(owned, 'compiler')) };
  refactoring = registerJavaRefactoring(context, vscode, { request });
  service = registerJavaChangeSignature(context, vscode, { request, refactoring, getJavaHome: () => runtime.javaHome });
  const inspect = () => service.info(target, selection(target.getText(), chosen));
  const preview = (info, renameParameter = selected) => service.preview(info.id, { renameParameter });

  const guarded = path.join(app, path.dirname(declaration), 'MetadataConsumer.java');
  await fs.writeFile(guarded,
    'package fixture.parametername; class MetadataConsumer { int inspect(java.lang.reflect.Method method) { return method.getParameters().length; } }\n',
    { flag: 'wx' });
  try {
    const info = await inspect();
    await assert.rejects(preview(info), /reflective parameter-name contracts/u);
  } finally { await fs.unlink(guarded); }

  const info = await inspect();
  for (const name of ['count', 'existing']) await assert.rejects(preview(info, { ...selected, name }), /conflicts/u);
  await assert.rejects(preview(info, { ...selected, name: 'label' }), /distinct from the current family names/u);
  await assert.rejects(preview(info, { ...selected, name: 'for' }), /valid new Java identifier/u);
  await assert.rejects(service.preview(info.id, { renameParameter: selected, parameters: info.parameters }), /either an ordered/u);
  assert.equal(requested, 0);
  for (const kind of ['caller', 'implementation']) {
    corrupt = kind;
    await assert.rejects(preview(info), /edited a caller|changed more than a bound formal parameter/u);
  }
  corrupt = undefined;
  assert.equal(submitted.length, 0);
  const plan = await preview(info);
  assertParameterPlan(info, plan);
  const file = target.uri.fsPath;
  await fs.appendFile(file, '// source changed after review\n');
  try { await assert.rejects(refactoring.apply(plan.id), /source changed|membership changed/u); }
  finally { await fs.writeFile(file, target.getText()); }
  assert.equal(submitted.length, 0);
  assert.equal((await refactoring.apply(plan.id)).state, 'applied');
  await save();
  assert.equal(submitted.length, 1);
  assert.equal(await fs.readFile(path.join(app, caller), 'utf8'), sources.get(caller));
  for (const changed of plan.documents) assert.equal(await fs.readFile(fileURLToPath(changed.uri), 'utf8'), changed.after);
  await buildParameterReactor(root, tools);
  const after = await run();
  assert.deepEqual(after, before);
  if (process.env.ROCKETBRAIN_PARAMETER_RENAME_RECEIPT) await fs.writeFile(
    process.env.ROCKETBRAIN_PARAMETER_RENAME_RECEIPT,
    JSON.stringify({ family: plan.signature.parameterRename, preservedDirectFamilyCalls: plan.signature.resolvedReferences,
      actualMavenReactor: true, overloadedSiblingUnchanged: true, callerBytesUnchanged: true, before, after,
      callerAndUnrelatedJdtEditsRefused: true, freshParameterConflictRefused: true,
      reflectiveParameterUsageRefused: true, staleReviewRefused: true }, null, 2) + '\n');
});
