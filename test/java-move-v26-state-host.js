'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { projectFiles } = require('../src/java/move');
const { buildStateV26 } = require('../scripts/refactoring-v26-state');
const { verifyRefactoringHttp } = require('../scripts/refactoring-spring');
const { waitPackageOutputs } = require('./java-package-move-v23-host');

const route = '/probe/move-state-v26';
const expected = { sharedFirst: 1578, sharedSecond: 2022, distinctSameOwner: 3572, distinctNewOwner: 2576,
  parameterFirst: 612, parameterSecond: 545, parameterNewOwner: 612 };
const isolation = { people: 2, departments: 1, rolledBackNames: 0 };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function runJavaMoveV26StateChecks(api, vscode, checks) {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MOVE_STATE_V26_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  const project = config.stateRoot, base = path.join(project, 'src/main/java/fixture/statev26');
  const file = name => path.join(base, name + '.java');
  const files = [...new Set([...projectFiles(project), path.join(project, 'build.gradle'), path.join(project, 'settings.gradle')])];
  const original = new Map(files.map(name => [name, fs.readFileSync(name)]));
  const retained = new Map();
  const report = { version: '0.26.0', project, route, expected, operations: [], negative: [], classOutputReadiness: [], editorEdits: [] };
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.26';
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
      assert.ok(!document.isClosed && !document.isDirty);
      assert.deepEqual(fs.readFileSync(name), bytes);
      assert.deepEqual(Buffer.from(document.getText()), bytes);
    }
  }

  async function edit(name, contents, phase) {
    const document = retained.get(name), version = document.version;
    assert.ok(!document.isClosed && !document.isDirty);
    const edits = new vscode.WorkspaceEdit();
    edits.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), contents);
    assert.equal(await vscode.workspace.applyEdit(edits), true);
    assert.ok(document.version > version);
    assert.equal(await document.save(), true);
    assert.equal(document.getText(), contents);
    assert.equal(fs.readFileSync(name, 'utf8'), contents);
    report.editorEdits.push({ phase, file: path.relative(project, name), beforeVersion: version, afterVersion: document.version });
  }

  async function restore() {
    for (const [name, bytes] of original) {
      const document = retained.get(name);
      if (!fs.readFileSync(name).equals(bytes)) fs.writeFileSync(name, bytes);
      if (document.isDirty || !Buffer.from(document.getText()).equals(bytes)) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    }
    baseline();
  }

  async function prepare(operation, ready = true) {
    if (ready) {
      baseline();
      await waitPackageOutputs({ api, vscode, root: project, record: report.classOutputReadiness, timeoutMs: 90000 });
      baseline();
    }
    const document = retained.get(file(operation.source)), target = retained.get(file('GraphTarget'));
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

  const field = { source: 'FieldGraphSource', name: 'routeGraph', receiver: 'primary', kind: 'field', depth: 4,
    roots: ['primary', 'primary', 'primary', 'pair[1]'], nestedPaths: 3 };
  const parameter = { source: 'ParameterGraphSource', name: 'measureGraph', receiver: 'target', kind: 'parameter', depth: 2,
    roots: ['root[0][0]', 'root[0][0]'], nestedPaths: 2 };
  try {
    for (const operation of [field, parameter]) {
      try {
        const plan = await prepare(operation);
        baseline();
        assert.equal(plan.documents.length, 2);
        assert.equal(plan.memberMove.receiverKind, operation.kind);
        const proof = plan.memberMove.statefulContract;
        for (const key of ['nestedReferencePathsPreserved', 'ownerReferenceFieldsPreserved', 'referenceCaptureOrderPreserved',
          'sharedReferenceIdentityPreserved', 'stateUpdateOrderPreserved', 'constructorsPreserved']) assert.equal(proof[key], true);
        assert.equal(proof.referenceGraph.maximumCarrierDepth, operation.depth);
        assert.equal(proof.referenceGraph.reviewedJavaSourceBindings, operation.depth + 1);
        assert.equal(proof.referenceGraph.capturedPaths.length, operation.nestedPaths);
        assert.deepEqual(proof.referenceArgumentCaptures.map(capture => capture.root), operation.roots);
        assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
        await checkPlan(plan, true, true);
        buildStateV26(java);
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

    const stale = await prepare(field), leaf = file('GraphLeaf');
    const untouched = original.get(leaf).toString('utf8');
    try {
      await edit(leaf, untouched.replace('return this.primary;', 'return this.alternate;'), 'late-carrier-rebind');
      await assert.rejects(api.java.refactoring.apply(stale.id), /changed|source|buffer/i);
      report.negative.push('stale-carrier-target-refused');
    } finally {
      if (fs.readFileSync(leaf, 'utf8') !== untouched) await edit(leaf, untouched, 'restore-carrier-target');
      await restore();
    }

    for (const [from, to, diagnostic, named] of [
      ['return this.primary;', 'return new GraphTarget(2);', /carrier accessors/i, 'effectful-carrier-getter-refused'],
      ['private final GraphTarget primary;', 'private GraphTarget primary;', /carrier.*final/i, 'mutable-carrier-field-refused']
    ]) {
      try {
        await edit(leaf, untouched.replace(from, to), named);
        await assert.rejects(prepare(field, false), diagnostic);
        report.negative.push(named);
      } finally {
        if (fs.readFileSync(leaf, 'utf8') !== untouched) await edit(leaf, untouched, 'restore-' + named);
        await restore();
      }
    }
    checks.push('Native JDT moved both instance methods with reviewed carrier source bindings. Fresh Spring rebuilds retained seven shared/distinct state results and real JDBC isolation, with Undo/Redo and three graph refusals.');
  } finally {
    await restore();
    report.retainedDocumentCount = retained.size;
    fs.writeFileSync(path.resolve(__dirname, '../test-output', prefix + '-native-java-move-state-v26-' + engine + '.json'),
      JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

module.exports = { runJavaMoveV26StateChecks };
