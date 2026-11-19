'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { projectFiles } = require('../src/java/move');
const { buildStateV25 } = require('../scripts/refactoring-v25-state');
const { verifyRefactoringHttp } = require('../scripts/refactoring-spring');
const { waitPackageOutputs } = require('./java-package-move-v23-host');

const route = '/probe/move-state-v25';
const expected = { sharedFirst: 1578, sharedSecond: 2022, distinctSameOwner: 3572, distinctNewOwner: 2576,
  parameterFirst: 612, parameterSecond: 545, parameterNewOwner: 612 };
const isolation = { people: 2, departments: 1, rolledBackNames: 0 };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function runJavaMoveV25StateChecks(api, vscode, checks) {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MOVE_STATE_V25_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  const project = config.stateRoot;
  const base = path.join(project, 'src/main/java/fixture/statev25');
  const file = name => path.join(base, name + '.java');
  const files = [...new Set([...projectFiles(project), path.join(project, 'build.gradle'), path.join(project, 'settings.gradle')])];
  const original = new Map(files.map(name => [name, fs.readFileSync(name)]));
  const retained = new Map();
  const report = { version: '0.25.0', project, route, expected, operations: [], negative: [], classOutputReadiness: [], editorEdits: [] };
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.25';
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.equal(config.dbEngine, engine);

  async function getJson(uri) {
    const response = await fetch(config.baseUrl + uri, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    return response.json();
  }
  report.initialRuntime = await getJson(route);
  assert.deepEqual(report.initialRuntime, expected);
  assert.deepEqual(await getJson('/probe/testing-state'), isolation);

  for (const name of files) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(name));
    await vscode.window.showTextDocument(document, { preview: false });
    retained.set(name, document);
  }

  function baseline() {
    for (const [name, bytes] of original) {
      const document = retained.get(name);
      assert.ok(document && !document.isClosed && !document.isDirty);
      assert.deepEqual(fs.readFileSync(name), bytes);
      assert.deepEqual(Buffer.from(document.getText()), bytes);
    }
  }

  async function restore() {
    for (const [name, bytes] of original) {
      const document = retained.get(name);
      assert.ok(document && !document.isClosed);
      if (!fs.readFileSync(name).equals(bytes)) fs.writeFileSync(name, bytes);
      if (document.isDirty || !Buffer.from(document.getText()).equals(bytes)) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    }
    baseline();
  }

  async function prepare(operation, checkDisk = true) {
    if (checkDisk) {
      baseline();
      await waitPackageOutputs({ api, vscode, root: project, record: report.classOutputReadiness });
      baseline();
    }
    const document = retained.get(file(operation.source)), target = retained.get(file(operation.target));
    await vscode.window.showTextDocument(document, { preview: false });
    const offset = document.getText().indexOf(operation.name);
    assert.ok(offset >= 0);
    const selection = new vscode.Range(document.positionAt(offset), document.positionAt(offset + operation.name.length));
    return api.java.memberMove.prepareInstance(document, selection, target, { targetParameter: operation.receiver });
  }

  async function checkPlan(plan, after, save = false) {
    for (const entry of plan.documents) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
      assert.equal(document.getText(), after ? entry.after : entry.before);
      if (save && document.isDirty) assert.equal(await document.save(), true);
    }
  }

  async function history(operation, command) {
    const document = retained.get(file(operation.source));
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    assert.equal(vscode.window.activeTextEditor?.document, document);
    await vscode.commands.executeCommand(command);
    await pause(100);
  }

  async function edit(name, before, after, phase) {
    const document = retained.get(name), version = document.version;
    assert.ok(!document.isDirty && !document.isClosed);
    assert.deepEqual(fs.readFileSync(name), before);
    assert.deepEqual(Buffer.from(document.getText()), before);
    assert.notDeepEqual(after, before);
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), after.toString('utf8'));
    assert.equal(await vscode.workspace.applyEdit(workspaceEdit), true);
    assert.ok(document.version > version);
    assert.equal(await document.save(), true);
    assert.deepEqual(fs.readFileSync(name), after);
    assert.deepEqual(Buffer.from(document.getText()), after);
    report.editorEdits.push({ phase, file: path.relative(project, name), beforeVersion: version, afterVersion: document.version,
      exactDiskAndBufferBytesVerified: true });
  }

  const field = { source: 'FieldSource', target: 'FieldTarget', name: 'routeReferences', receiver: 'primary', kind: 'field',
    identity: [['mirror', 'primary'], ['forward', 'primary'], ['mirror', 'primary'], ['other', 'other']] };
  const parameter = { source: 'ParameterSource', target: 'ParameterTarget', name: 'measureReferences', receiver: 'target', kind: 'parameter',
    identity: [['stored', 'stored'], ['storedAlias', 'stored']] };
  try {
    for (const operation of [field, parameter]) {
      try {
        const plan = await prepare(operation);
        baseline();
        assert.equal(plan.documents.length, 2);
        assert.equal(plan.memberMove.receiverKind, operation.kind);
        const proof = plan.memberMove.statefulContract;
        for (const key of ['ownerReferenceFieldsPreserved', 'referenceCaptureOrderPreserved', 'sharedReferenceIdentityPreserved',
          'stateUpdateOrderPreserved', 'constructorsPreserved', 'returnExpressionPreserved']) {
          assert.equal(proof[key], true);
        }
        assert.deepEqual(proof.referenceArgumentCaptures.map(({ field, root }) => [field, root]), operation.identity);
        assert.equal(proof.receiverReference.kind, operation.kind === 'field' ? 'allocation' : 'fresh-caller-allocation');
        assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
        await checkPlan(plan, true, true);
        buildStateV25(java);
        const runtime = await verifyRefactoringHttp(config, { expectations: { [route]: expected } });
        assert.deepEqual(runtime.isolation, isolation);
        await history(operation, 'undo');
        await checkPlan(plan, false);
        await history(operation, 'redo');
        await checkPlan(plan, true);
        await history(operation, 'undo');
        await checkPlan(plan, false, true);
        report.operations.push({ name: operation.name, receiverKind: operation.kind, nativeUndo: true, nativeRedo: true,
          reviewedJavaFiles: plan.documents.length, move: plan.memberMove, runtime });
      } finally {
        await restore();
      }
    }
    const stale = await prepare(field);
    const name = file(field.source), before = original.get(name);
    const changed = Buffer.from(before.toString().replace('this.forward = this.mirror', 'this.forward = this.other'));
    try {
      await edit(name, before, changed, 'late-alias-rebind');
      await assert.rejects(api.java.refactoring.apply(stale.id), /source|changed|disk/i);
      report.negative.push('stale-alias-rebind-refused');
    } finally {
      if (fs.readFileSync(name).equals(changed)) await edit(name, changed, before, 'restore-alias');
      await restore();
    }

    for (const [operation, from, to, diagnostic, named] of [
      [field, 'this.mirror, this.forward', 'this.mirror, null', /object arguments/i, 'nullable-capture-refused'],
      [field, 'this.forward = this.mirror', 'this.forward = this.forward', /constructor reference/i, 'cyclic-alias-refused'],
      [parameter, 'private final ParameterTarget stored;', 'private ParameterTarget stored;', /fields/i, 'mutable-reference-refused']
    ]) {
      const name = file(operation.source), before = original.get(name);
      const modified = Buffer.from(before.toString().replace(from, to));
      try {
        await edit(name, before, modified, named);
        await assert.rejects(prepare(operation, false), diagnostic);
        report.negative.push(named);
      } finally {
        if (fs.readFileSync(name).equals(modified)) await edit(name, modified, before, 'restore-' + named);
        await restore();
      }
    }
    checks.push('Actual JDT Move and fresh Spring retain field and parameter receiver ownership, shared and distinct identity, and all seven ordered mutation values; native Undo/Redo and four rejected controls verified.');
  } finally {
    await restore();
    report.retainedDocumentCount = retained.size;
    fs.writeFileSync(path.resolve(__dirname, '../test-output', prefix + '-native-java-move-state-v25-' + engine + '.json'),
      JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

module.exports = { runJavaMoveV25StateChecks };
