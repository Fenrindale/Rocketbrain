'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { packageClassOutputSnapshot } = require('./java-package-move-v23-host');
const { buildPackageV27 } = require('../scripts/refactoring-v27-package');

const moduleName = 'fixture.packagev27';
const endpoint = '/probe/package-v27';
const expected = { module: moduleName, providerValues: '[29, 17]', people: 2 };

async function runJavaPackageMoveV27Checks(api, vscode, checks) {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MOVE_V27_PACKAGE_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  const root = fs.realpathSync(config.moduleProjectPath);
  assert.equal(path.relative(path.resolve(__dirname, 'fixtures/refactoring-v27-package'), root), '');
  const main = path.join(root, 'src/main/java');
  const pkg = path.join(main, 'fixture/packagev27');
  const source = path.join(pkg, 'payload');
  const target = path.join(pkg, 'relocated');
  const descriptor = path.join(main, 'module-info.java');
  const factory = path.join(source, 'FactoryProvider.java');
  const consumer = path.join(pkg, 'client/ModuleProbe.java');
  const names = ['FactoryProvider.java', 'FactoryValue.java', 'PackageValue.java'];
  const baseline = new Map(require('../src/java/move').projectFiles(root).map(file => [file, fs.readFileSync(file)]));
  const oldModule = baseline.get(descriptor).toString('utf8');
  const newModule = oldModule.replaceAll(moduleName + '.payload.', moduleName + '.relocated.');
  const destinations = names.map(file => path.join(target, file));
  const report = { version: '0.27.0', engine: config.dbEngine, operations: [], negative: [] };
  const uri = file => vscode.Uri.file(file);
  let plan;
  let applied = false;

  function originalFiles() {
    for (const [file, bytes] of baseline) assert.deepEqual(fs.readFileSync(file), bytes, file);
    for (const file of destinations) assert.equal(fs.existsSync(file), false, file);
  }
  async function read(route) {
    const response = await fetch(config.baseUrl + route, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, route);
    return response.json();
  }
  async function indexed(file) {
    const doc = await vscode.workspace.openTextDocument(uri(file));
    await vscode.window.showTextDocument(doc, { preview: false });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      if ((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri))?.length) return doc;
      await pause(300);
    }
    throw Error('The named service fixture was not indexed: ' + path.basename(file));
  }
  async function prepare() {
    for (const file of [...names.map(name => path.join(source, name)), consumer, path.join(target, 'DestinationMarker.java')]) await indexed(file);
    const cp = await api.java.executeWorkspaceCommand('java.project.getClasspaths', uri(root).toString(), { scope: 'runtime' });
    assert.equal(path.relative(vscode.Uri.parse(cp.projectRoot).fsPath, root), '');
    const outputs = [...cp.classpaths, ...(cp.modulepaths || [])];
    let prior;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const snapshot = packageClassOutputSnapshot(outputs, root);
      if (prior === snapshot.fingerprint && !snapshot.missing.length && snapshot.files.some(file => path.basename(file.file) === 'module-info.class')) break;
      if (Date.now() + 1000 > deadline) throw Error('Wait for stable named-module Java outputs before Package Move.');
      prior = snapshot.fingerprint;
      await pause(1000);
    }
    return api.java.move.preparePackage(uri(source), uri(target));
  }
  async function documents(after, save = false) {
    for (const item of plan.documents) {
      const location = vscode.Uri.parse(after && item.resourceOperation === 'rename' ? item.newUri : item.uri);
      const doc = await vscode.workspace.openTextDocument(location);
      assert.equal(doc.getText(), after ? item.after : item.before, location.fsPath);
      if (save && doc.isDirty) assert.equal(await doc.save(), true);
    }
    for (const file of destinations) assert.equal(fs.existsSync(file), after, file);
  }
  async function history(command, after) {
    const current = path.join(after ? source : target, path.basename(factory));
    const doc = await vscode.workspace.openTextDocument(uri(current));
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    assert.equal(vscode.window.activeTextEditor.document, doc);
    await vscode.commands.executeCommand(command);
    await pause(150);
    await documents(after);
  }
  async function setText(doc, value) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), value);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await doc.save(), true);
    assert.equal(fs.readFileSync(doc.uri.fsPath, 'utf8'), value);
  }

  try {
    originalFiles();
    assert.deepEqual(await read(endpoint), expected);
    for (const file of baseline.keys()) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(file)), { preview: false });
    plan = await prepare();
    const proof = plan.move.resourceProof;
    assert.equal(plan.move.movedJavaFiles, 3);
    assert.equal(plan.move.movedServiceDescriptors, 0);
    assert.equal(plan.move.semantic.independentNamedModuleCompilation, true);
    assert.equal(proof.namedModule.name, moduleName);
    assert.equal(proof.namedModule.directiveEdits, 3);
    assert.equal(proof.compilerCheckedCalls, 7);
    assert.equal(proof.compilerCheckedServiceDeclarations, 4);
    assert.equal(proof.serviceCalls[0].loader, 'named-module-boot-layer');
    const contract = proof.services[0];
    assert.deepEqual(contract.newProviders, [moduleName + '.relocated.FactoryProvider', moduleName + '.peers.DirectValue']);
    assert.deepEqual(contract.providerFactories, [{
      provider: moduleName + '.payload.FactoryProvider', nextProvider: moduleName + '.relocated.FactoryProvider',
      implementation: moduleName + '.payload.FactoryValue', nextImplementation: moduleName + '.relocated.FactoryValue'
    }]);
    const moduleEdit = plan.documents.find(item => path.basename(vscode.Uri.parse(item.uri).fsPath) === 'module-info.java');
    assert.equal(moduleEdit.before, oldModule);
    assert.equal(moduleEdit.after, newModule);
    originalFiles();
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    applied = true;
    await documents(true, true);
    assert.equal(fs.readFileSync(descriptor, 'utf8'), newModule);
    assert.equal(buildPackageV27(java).cleanBuild, true);
    const runtime = await read(endpoint);
    assert.deepEqual(runtime, expected);
    const isolation = await read('/probe/testing-state');
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    await history('undo', false);
    await history('redo', true);
    await history('undo', false);
    await documents(false, true);
    applied = false;
    originalFiles();
    report.operations.push({ nativeUndo: true, nativeRedo: true, module: proof.namedModule, providerFactory: contract.providerFactories[0],
      providerOrderPreserved: true, namedModuleRuntime: runtime, freshSpringRuntime: { isolation }, compilerCheckedCalls: proof.compilerCheckedCalls,
      compilerCheckedServiceDeclarations: proof.compilerCheckedServiceDeclarations });

    const stale = await prepare();
    const moduleDoc = await vscode.workspace.openTextDocument(uri(descriptor));
    try {
      await setText(moduleDoc, oldModule.replace('module ' + moduleName, '// late edit\nmodule ' + moduleName));
      await assert.rejects(api.java.refactoring.apply(stale.id), /changed|fresh|preview/i);
      report.negative.push('late-module-descriptor-change-refused');
    } finally {
      await setText(moduleDoc, oldModule);
    }
    const factoryDoc = await indexed(factory);
    const oldFactory = factoryDoc.getText();
    try {
      await setText(factoryDoc, oldFactory.replace('new FactoryValue()', 'null'));
      await assert.rejects(prepare(), /provider factory/i);
      report.negative.push('unproven-factory-allocation-refused');
    } finally {
      await setText(factoryDoc, oldFactory);
    }
    checks.push('JPMS uses/provides and factory bindings survive one native package move, ordered module-path loading in a fresh Gradle build, Spring JDBC, and Undo/Redo.');
  } finally {
    if (applied && plan) {
      if (fs.existsSync(destinations[0])) await history('undo', false);
      await documents(false, true);
    }
    originalFiles();
  }
  return report;
}

module.exports = { runJavaPackageMoveV27Checks };
