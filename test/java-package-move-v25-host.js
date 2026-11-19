'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { waitPackageOutputs } = require('./java-package-move-v23-host');
const { buildPackageV25 } = require('../scripts/refactoring-v25-package');
const { verifyRefactoringHttp } = require('../scripts/refactoring-spring');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { service: 29, utility: 13, system: 'source main data', systemUrl: 'literal custom data', spring: 'literal custom data' };
const endpoint = '/probe/package-v25';

async function runJavaPackageMoveV25Checks(api, vscode, checks) {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MOVE_V25_PACKAGE_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  const root = config.projectPath;
  const javaRoot = path.join(root, 'src/main/java/fixture/packagev25');
  const source = path.join(javaRoot, 'payload');
  const target = path.join(javaRoot, 'relocated');
  const sourceClass = path.join(source, 'RootValue.java');
  const destinationClass = path.join(target, 'RootValue.java');
  const controller = path.join(javaRoot, 'PackageController.java');
  const servicePath = 'META-INF/services/fixture.packagev25.spi.PackageValue';
  const descriptor = path.join(root, 'src/main/resources', servicePath);
  const originalDescriptor = fs.readFileSync(descriptor, 'utf8');
  const newDescriptor = originalDescriptor.replace('fixture.packagev25.payload.nested.ScalarProvider', 'fixture.packagev25.relocated.nested.ScalarProvider');
  const dataFiles = [path.join(root, 'src/main/resources/fixture/packagev25/payload/root.txt'),
    path.join(root, 'src/package-assets/fixture/packagev25/payload/nested/child.txt')];
  const inputs = new Set([...require('../src/java/move').projectFiles(root), descriptor, ...dataFiles,
    path.join(root, 'build.gradle'), path.join(root, 'settings.gradle')]);
  const baseline = new Map([...inputs].map(file => [file, fs.readFileSync(file)]));
  const destinations = [destinationClass, path.join(target, 'nested/ScalarProvider.java'),
    ...dataFiles.map(file => file.replace(path.sep + 'payload' + path.sep, path.sep + 'relocated' + path.sep))];
  const report = { version: '0.25.0', engine: config.dbEngine, operations: [], negative: [], classOutputReadiness: [] };
  const uri = file => vscode.Uri.file(file);
  let plan, applied = false;

  function originalFiles() {
    for (const [file, bytes] of baseline) assert.deepEqual(fs.readFileSync(file), bytes, file);
    for (const file of destinations) assert.equal(fs.existsSync(file), false, file);
  }
  async function indexed(file) {
    const doc = await vscode.workspace.openTextDocument(uri(file));
    await vscode.window.showTextDocument(doc, { preview: false });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      if ((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri))?.length) return doc;
      await pause(350);
    }
    throw Error('The v0.25 service/package fixture was not indexed: ' + path.basename(file));
  }
  async function prepare() {
    for (const file of [sourceClass, path.join(source, 'nested/ScalarProvider.java'),
      path.join(target, 'DestinationMarker.java'), path.join(target, 'nested/NestedMarker.java')]) await indexed(file);
    await waitPackageOutputs({ api, vscode, root, record: report.classOutputReadiness });
    return api.java.move.preparePackage(uri(source), uri(target));
  }
  async function documents(after, save = false) {
    for (const item of plan.documents) {
      const location = vscode.Uri.parse(after && item.resourceOperation === 'rename' ? item.newUri : item.uri);
      const doc = await vscode.workspace.openTextDocument(location);
      assert.equal(doc.getText(), after ? item.after : item.before, location.fsPath);
      if (save) assert.equal(await doc.save(), true);
    }
    for (const file of destinations) assert.equal(fs.existsSync(file), after, file);
  }
  async function history(command, after) {
    const doc = await vscode.workspace.openTextDocument(uri(after ? sourceClass : destinationClass));
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
    const before = await fetch(config.baseUrl + endpoint, { signal: AbortSignal.timeout(5000) });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), expected);
    for (const file of inputs) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(file)), { preview: false });

    plan = await prepare();
    const proof = plan.move.resourceProof;
    assert.equal(plan.move.movedJavaFiles, 2);
    assert.equal(plan.move.movedResourceFiles, 2);
    assert.equal(plan.move.semantic.beforeErrors, 0);
    assert.equal(plan.move.semantic.afterErrors, 0);
    assert.deepEqual(proof.lookup.map(item => item.loader).sort(), ['spring-classloader', 'system-classloader', 'system-classloader']);
    assert.equal(proof.compilerCheckedCalls, 8);
    assert.equal(proof.springProvider.version, '7.0.10');
    assert.equal(proof.services.length, 1);
    assert.equal(proof.serviceCalls.length, 1);
    assert.ok(proof.classpathIsolation.jars > 0);
    const descriptorEdit = plan.documents.find(item => item.serviceDescriptor);
    assert.equal(descriptorEdit.before, originalDescriptor);
    assert.equal(descriptorEdit.after, newDescriptor);
    assert.equal(descriptorEdit.resourceOperation, undefined);
    originalFiles();

    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    applied = true;
    await documents(true, true);
    const built = buildPackageV25(java);
    assert.equal(built.cleanBuild, true);
    assert.equal(fs.readFileSync(descriptor, 'utf8'), newDescriptor);
    assert.equal(fs.readFileSync(path.join(root, 'build/resources/main', servicePath), 'utf8'), newDescriptor);
    const resourceChecks = proof.files.map(item => {
      assert.equal(fs.existsSync(item.file), false);
      assert.equal(hash(fs.readFileSync(item.newFile)), item.sha256);
      const output = path.join(root, 'build/resources/main', path.relative(item.resourceRoot, item.newFile));
      assert.equal(hash(fs.readFileSync(output)), item.sha256);
      return { bytes: item.bytes, sha256: item.sha256, destinationBytesIdentical: true };
    });
    const runtime = await verifyRefactoringHttp(config, {
      classpath: fs.readFileSync(built.classpathFile, 'utf8').trim(), expectations: { [endpoint]: expected }
    });
    assert.deepEqual(runtime.isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    await history('undo', false);
    await history('redo', true);
    await history('undo', false);
    await documents(false, true);
    applied = false;
    originalFiles();
    report.operations.push({ nativeUndo: true, nativeRedo: true, resourceChecks, freshSpringRuntime: runtime,
      lookupCount: proof.lookup.length, compilerCheckedCalls: proof.compilerCheckedCalls, services: proof.services,
      classpathIsolation: proof.classpathIsolation, sameDescriptorPath: true, registrationCommentsPreserved: true });

    const late = await prepare();
    try {
      fs.appendFileSync(descriptor, '# late change\n');
      await assert.rejects(api.java.refactoring.apply(late.id), /service|resource|changed/i);
      report.negative.push('late-service-descriptor-bytes-refused');
    } finally {
      fs.writeFileSync(descriptor, baseline.get(descriptor));
    }
    const doc = await indexed(controller);
    const old = doc.getText();
    const dynamic = old.replace('PackageValue.class, PackageValue.class.getClassLoader()', 'PackageValue.class');
    assert.notEqual(old, dynamic);
    try {
      await setText(doc, dynamic);
      await assert.rejects(prepare(), /service loading|service loader|resource/i);
      report.negative.push('context-service-classloader-refused');
    } finally {
      await setText(doc, old);
    }
    checks.push('Service descriptor/provider edits and explicit Java/Spring classloader paths survive a fresh build and Spring HTTP/database reads. Native Undo/Redo restores source bytes; a stale descriptor and a context service loader are refused.');
  } finally {
    if (applied && plan) {
      if (fs.existsSync(destinationClass)) await history('undo', false);
      await documents(false, true);
    }
    originalFiles();
    const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.25';
    fs.writeFileSync(path.resolve(__dirname, '../test-output', `${prefix}-native-java-package-v25-${config.dbEngine}.json`), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

module.exports = { runJavaPackageMoveV25Checks };
