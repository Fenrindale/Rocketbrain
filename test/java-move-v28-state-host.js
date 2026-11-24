'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { buildStateV28 } = require('../scripts/refactoring-v28-state');
const { startRefactoringApp } = require('../scripts/refactoring-spring');
const { waitPackageOutputs } = require('./java-package-move-v23-host');

const expected = {
  trueBranch: 561, sameReference: 671, falseBranch: 800, retainedElse: 910,
  nullBranch: 900, retainedNull: 1000, incoming: 7, people: 2
};
const database = { people: 2, departments: 1, rolledBackNames: 0 };

async function readRuntime(baseUrl) {
  async function read(route) {
    const response = await fetch(baseUrl + route, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    return response.json();
  }
  const branchValues = await read('/probe/branch-move');
  const databaseState = await read('/probe/testing-state');
  assert.deepEqual(branchValues, expected);
  assert.deepEqual(databaseState, database);
  return { branchValues, databaseState };
}

async function runJavaBranchMove(api, vscode) {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MOVE_STATE_V28_CONFIG, 'utf8'));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const root = config.stateRoot;
  const sourceRoot = path.join(root, 'src/main/java/fixture/statev28');
  const document = name => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(sourceRoot, name + '.java')));
  const [owner, target] = await Promise.all([document('BranchOwner'), document('RefTarget')]);
  const originals = new Map([owner, target].map(doc => [doc, doc.getText()]));
  const openOwner = () => vscode.window.showTextDocument(owner, { preview: false });
  await vscode.window.showTextDocument(target, { preview: false });
  await openOwner();
  async function edit(doc, contents) {
    const edits = new vscode.WorkspaceEdit();
    edits.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), contents);
    assert.equal(await vscode.workspace.applyEdit(edits), true);
    assert.equal(await doc.save(), true);
  }
  async function history(command) {
    await openOwner();
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand(command);
    await delay(100);
  }
  async function checkPlan(plan, applied, save = false) {
    for (const entry of plan.documents) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
      assert.equal(doc.getText(), applied ? entry.after : entry.before);
      if (save && doc.isDirty) assert.equal(await doc.save(), true);
    }
  }
  async function prepare() {
    const selected = owner.getText().indexOf('measure(');
    assert.ok(selected > 0);
    const range = new vscode.Range(owner.positionAt(selected), owner.positionAt(selected + 'measure'.length));
    return api.java.memberMove.prepareInstance(owner, range, target, { targetParameter: 'receiver' });
  }
  const before = await readRuntime(config.baseUrl);
  const readiness = [];
  await waitPackageOutputs({ api, vscode, root, record: readiness, timeoutMs: 90000 });
  try {
    const plan = await prepare();
    const { referenceFlow: flow } = plan.memberMove.statefulContract;
    assert.equal(flow.branchGuardsPreserved, true);
    assert.equal(flow.captureOrderPreserved, true);
    assert.equal(flow.assignmentsPreserved, true);
    assert.equal(flow.infersDynamicAliasOrNullability, false);
    assert.deepEqual(flow.rebindings.map(item => [item.caller, item.when.parameter, item.when.value]), [
      ['choose', 'useIncoming', true], ['choose', 'useIncoming', false], ['reset', 'keep', false]
    ]);
    assert.equal(plan.documents.length, 2);
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    await checkPlan(plan, true, true);
    buildStateV28(java);
    const spring = await startRefactoringApp(config);
    let after;
    try {
      after = await readRuntime(spring.baseUrl);
    } finally {
      await spring.stop();
    }
    await history('undo');
    await checkPlan(plan, false);
    await history('redo');
    await checkPlan(plan, true);
    await history('undo');
    await checkPlan(plan, false, true);
    await edit(owner, owner.getText().replace('if (useIncoming)', 'if (useIncoming && incoming != null)'));
    await assert.rejects(prepare(), /plain boolean caller parameter/);
    return { before, after, sourceDocuments: plan.documents.length, flow, nativeUndoRedo: true, computedGuardRefused: true };
  } finally {
    for (const [doc, original] of originals) {
      if (doc.getText() !== original) await edit(doc, original);
      else if (doc.isDirty) assert.equal(await doc.save(), true);
      assert.equal(fs.readFileSync(doc.uri.fsPath, 'utf8'), original);
    }
  }
}

module.exports = { runJavaBranchMove };
