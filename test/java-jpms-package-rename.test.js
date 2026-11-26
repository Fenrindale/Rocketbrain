'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { registerJavaMove } = require('../src/java/move');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const {packageRenameHeadless} = require('./helpers/package-rename-headless');
const { reviewClosedModule } = require('../src/java/package-module');
const { bindModuleDescriptor, verifyModuleProjection, reconcileModuleText } = require('../src/java/package-rename-module');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { uri } = require('./helpers/java-signature-jdt-host');
const { moduleName, oldPackage, newPackage, sourceFolder, targetFolder, owner, descriptor, unrelatedProvider, fixtureSources,
  populate, compileModule, runSpring } = require('./helpers/java-jpms-package-rename-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const cpFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH;
const dbs = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_PACKAGE_RENAME_' + engine.toUpperCase() + '_CONFIG']]);
const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('JPMS descriptor review binds every original visibility and service position and reconciles exact edits', () => {
  const root = path.resolve('test-output', 'module-rename-policy');
  const file = path.join(root, descriptor), address = uri(file).toString();
  const text = fixtureSources.get(descriptor);
  const parse = (value, moduleOptions = { allowVisibility: true }) =>
    reviewClosedModule(root, [{ file, uri: address, text: value }], moduleOptions);
  const selected = parse(text);
  assert.equal(selected.name, moduleName);
  assert.deepEqual(selected.declarations.map(item => item.role), ['requires', 'exports', 'exports', 'opens', 'uses', 'provides', 'with', 'with']);
  assert.throws(() => parse(text, {}), /literal uses\/provides/u);
  for (const unsupported of [
    text.replace('module fixture', 'open module fixture'),
    text.replace('exports ' + oldPackage + ';', 'exports ' + oldPackage + ' to other.module;'),
    text.replace('opens ' + oldPackage + '.impl;', 'opens ' + oldPackage + '.impl to other.module;'),
    text.replace('requires java.base;', 'requires java.sql;')
  ]) assert.throws(() => parse(unsupported), /closed named module/u);
  assert.throws(() => reviewClosedModule(root, [
    { file, uri: address, text }, { file: path.join(root, 'src/test/java/module-info.java'), text }
  ], { allowVisibility: true }), /one standard main source set/u);
  const spans = selected.declarations.filter(row => row.name.startsWith(oldPackage) && !row.name.startsWith(oldPackage + 's'))
    .map(row => ({ start: row.start, end: row.start + oldPackage.length }));
  const unit = { module: { name: moduleName, declarations: selected.declarations }, spans };
  const bound = bindModuleDescriptor(unit, selected, oldPackage);
  assert.equal(bound.spans.length, 5);
  assert.throws(() => bindModuleDescriptor({ ...unit, module: { name: moduleName,
    declarations: selected.declarations.map(row => row.role === 'opens' ? { ...row, start: row.start + 1 } : row) } },
    selected, oldPackage), /exact declared package/u);
  const edited = text.replace(/fixture\.jpmsrename\.billing(?!s)/gu, newPackage);
  assert.equal(reconcileModuleText(text, edited, spans, oldPackage, newPackage), 5);
  assert.equal(reconcileModuleText(text, text.replace('exports ' + oldPackage, 'exports ' + newPackage), spans, oldPackage, newPackage), 1);
  assert.equal(reconcileModuleText(text, text, spans, oldPackage, newPackage), 0);
  assert.throws(() => reconcileModuleText(text, edited.replace('public ledger', 'changed comment'), spans, oldPackage, newPackage),
    /outside exact attributed/u);
  const renamed = parse(edited);
  verifyModuleProjection(bound, { module: renamed }, oldPackage, newPackage);
  assert.throws(() => verifyModuleProjection(bound, { module: { ...renamed, declarations: renamed.declarations.toReversed() } },
    oldPackage, newPackage), /unrelated module/u);
});


test('stock JDT and Javac rename one JPMS package and preserve the running named module in both real Spring JDBC clients', {
  skip: !runtimeFile || !cpFile || !dbs.every(([, file]) => file), timeout: 300000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-jpms-rename-'));
  const root = path.join(owned, 'project'), runtime = await load(runtimeFile);
  const data = await Promise.all(dbs.map(async ([engine, file]) => [engine, await load(file)]));
  let refactoring, move, lsp;
  t.after(async () => {
    await move?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await populate(root);
  const readSpring = (classes, renamed) => Promise.all(data.map(async ([engine, data]) => runSpring({
    root: await fs.mkdtemp(path.join(owned, 'spring-')), classes, javaHome: runtime.javaHome, cpFile, data, engine, renamed
  })));
  const installed = path.join(root, 'bin/main');
  const moduleBefore = await compileModule(root, installed, runtime.javaHome);
  const springBefore = await readSpring(installed, false);
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'JPMS rename' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true,
      workspaceEdit: { documentChanges: true, resourceOperations: ['rename'] } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { vscode, submitted } = packageRenameHeadless(root,lsp,sourceFolder,targetFolder,() => refactoring);
  const document = await vscode.workspace.openTextDocument(uri(path.join(root, owner)));
  await until(async () => {
    const model = await lsp.request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [document.uri.toString(), { scope: 'test' }] }, 25000);
    return model?.projectRoot && model.modulepaths?.some(file => path.relative(installed, file) === '');
  }, 85000);
  refactoring = registerJavaRefactoring({}, vscode);
  move = registerJavaMove({}, vscode, { refactoring, request: (method, params) => lsp.request(method, params, 30000),
    runtime: () => ({ javaHome: runtime.javaHome, storagePath: path.join(owned, 'compiler') }) });
  const plan = await move.prepareRenamePackage(document, 'settlement');
  assert.deepEqual(plan.packageRename.namedModule, { name: moduleName, directiveNamesChanged: 5, directivesChecked: 8, compilerVerified: true });
  assert.equal(plan.packageRename.engineModuleDirectives, 5);
  assert.equal(plan.resourceOperations.length, 1);
  assert.equal(plan.packageRename.services.bindings[0].providerFactories.length, 1);
  const moduleFile = path.join(root, descriptor);
  const before = fixtureSources.get(descriptor);
  const after = before.replace(/fixture\.jpmsrename\.billing(?!s)/gu, newPackage);
  assert.equal(plan.documents.find(file => file.uri.endsWith('/module-info.java')).after, after);
  await fs.appendFile(moduleFile, '\n// late edit\n');
  await assert.rejects(refactoring.apply(plan.id), /descriptor changed after review/u);
  assert.equal(submitted.length, 0);
  await fs.writeFile(moduleFile, before);
  assert.equal((await refactoring.apply(plan.id)).state, 'applied');
  assert.equal(submitted.length, 1);
  await assert.rejects(refactoring.apply(plan.id), /expired/u);
  assert.equal(await fs.readFile(moduleFile, 'utf8'), after);
  assert.equal(await fs.readFile(path.join(root, unrelatedProvider), 'utf8'),
    fixtureSources.get(unrelatedProvider).replace(oldPackage + '.Ledger', newPackage + '.Ledger'));
  const compiled = await fs.mkdtemp(path.join(owned, 'classes-'));
  assert.deepEqual(await compileModule(root, compiled, runtime.javaHome, true), moduleBefore);
  const springAfter = await readSpring(compiled, true);
  assert.deepEqual(springAfter, springBefore);
  const receipt = process.env.ROCKETBRAIN_JPMS_RENAME_RECEIPT;
  if (receipt) await fs.writeFile(receipt, JSON.stringify({ ...plan.packageRename, module: moduleBefore, spring: springAfter,
    ordinarySourcesVerifiedByJdt: true, staleDescriptorRefused: true, replayRefused: true, oneWorkspaceEdit: true }, null, 2) + '\n');
});
