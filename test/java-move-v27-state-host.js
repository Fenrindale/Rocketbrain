'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { projectFiles } = require('../src/java/move');
const { buildStateV27 } = require('../scripts/refactoring-v27-state');
const { verifyRefactoringHttp } = require('../scripts/refactoring-spring');
const { waitPackageOutputs } = require('./java-package-move-v23-host');

const route = '/probe/move-state-v27';
const expected = { incomingAlias: 1723, retainedAcrossCalls: 2862, ownedRebind: 3116,
  allocationRebind: 3192, clear: 13001, retainedNull: 14001, borrowed: 2694, borrowedAlias: 1600,
  borrowedNull: 7002, externalFirst: 20, externalSecond: 24 };
const isolation = { people: 2, departments: 1, rolledBackNames: 0 };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function runJavaMoveV27StateChecks(api, vscode, checks) {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MOVE_STATE_V27_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  const project = config.stateRoot, base = path.join(project, 'src/main/java/fixture/statev27');
  const file = name => path.join(base, name + '.java');
  const files = [...new Set([...projectFiles(project), path.join(project, 'build.gradle'), path.join(project, 'settings.gradle')])];
  const original = new Map(files.map(name => [name, fs.readFileSync(name)]));
  const retained = new Map();
  const report = { version: '0.27.0', project, route, expected, operations: [], negative: [], classOutputReadiness: [], editorEdits: [] };
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.27';
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
    const document = retained.get(file(operation.source)), target = retained.get(file('RefTarget'));
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

  const field = { source: 'MutableOwner', name: 'measureOwned', receiver: 'primary', kind: 'field',
    mutableFields: ['active'], kinds: ['external-caller-parameter', 'owner-reference-read', 'owner-reference-read', 'reviewed-allocation', 'null'],
    captures: 8, external: 3 };
  const parameter = { source: 'IncomingOwner', name: 'measureBorrowed', receiver: 'target', kind: 'parameter',
    mutableFields: [], kinds: [], captures: 4, external: 4 };
  try {
    for (const operation of [field, parameter]) {
      try {
        const plan = await prepare(operation);
        baseline();
        assert.equal(plan.documents.length, 2);
        assert.equal(plan.memberMove.receiverKind, operation.kind);
        const proof = plan.memberMove.statefulContract;
        assert.equal(proof.ownerReferenceFieldsPreserved, true);
        assert.equal(proof.stateUpdateOrderPreserved, true);
        const flow = proof.referenceFlow;
        assert.equal(flow.captureOrderPreserved, true);
        assert.equal(flow.assignmentsPreserved, true);
        assert.equal(flow.receiverIndependentOfMutableAndExternalReferences, true);
        assert.equal(flow.infersDynamicAliasOrNullability, false);
        assert.equal(flow.reviewedJavaSourceBindings, 1);
        assert.deepEqual(flow.mutableFields, operation.mutableFields);
        assert.deepEqual(flow.rebindings.map(binding => binding.origin.kind), operation.kinds);
        assert.equal(flow.callTimeCaptures.length, operation.captures);
        assert.equal(flow.callTimeCaptures.filter(capture => capture.kind === 'external-caller-parameter').length, operation.external);
        assert.ok(flow.callTimeCaptures.every(capture => !Object.hasOwn(capture, 'root')));
        assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
        await checkPlan(plan, true, true);
        buildStateV27(java);
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

    const fieldFile = file(field.source), parameterFile = file(parameter.source);
    const fieldText = original.get(fieldFile).toString('utf8');
    const parameterText = original.get(parameterFile).toString('utf8');
    const stale = await prepare(field);
    try {
      await edit(fieldFile, fieldText.replace('this.active = incoming;', 'this.active = this.backup;'), 'late-reference-source-rebind');
      await assert.rejects(api.java.refactoring.apply(stale.id), /changed|source|buffer/i);
      report.negative.push('stale-reference-rebind-refused');
    } finally {
      await restore();
    }

    const clientFile = file('StateController'), clientText = original.get(clientFile).toString('utf8');
    for (const [operation, changedFile, contents, diagnostic, name] of [
      [field, fieldFile, fieldText.replace('this.active = incoming;', 'this.active = incoming == null ? this.backup : incoming;'),
        /mutable reference assignments/i, 'computed-rebind-refused'],
      [parameter, parameterFile, parameterText.replace('new RefTarget(3), incoming, other', 'incoming, incoming, other'),
        /new non-null target/i, 'nullable-external-receiver-refused'],
      [field, clientFile, clientText.replace('RefTarget second = new RefTarget(20);',
        'RefTarget second = new RefTarget(20); owner.measureOwned(first, second, 1);'),
        /external, reflective or effectful selected-method clients/i, 'external-selected-method-client-refused']
    ]) {
      try {
        await edit(changedFile, contents, name);
        await assert.rejects(prepare(operation, false), diagnostic);
        report.negative.push(name);
      } finally {
        await restore();
      }
    }
    await assert.rejects(prepare({ ...field, receiver: 'active' }, false), /private final target field/i);
    report.negative.push('mutable-move-receiver-refused');
    checks.push('Native JDT moved both instance methods with the original mutable-field rebinding and exact caller captures. Eleven fresh Spring results, real JDBC isolation, Undo/Redo and five refusal cases passed.');
  } finally {
    await restore();
    report.retainedDocumentCount = retained.size;
    fs.writeFileSync(path.resolve(__dirname, '../test-output', prefix + '-native-java-move-state-v27-' + engine + '.json'),
      JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

module.exports = { runJavaMoveV27StateChecks };
