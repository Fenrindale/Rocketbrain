'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { verifyRefactoringHttp } = require('../scripts/refactoring-spring');
const { stageFreshClasses } = require('./java-spring-contract-v25-host');

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/refactoring-v27-spring');
const PREFIX = 'fixture.conditionsv27.conditions.';
const ROUTE = '/refactoring/spring-conditions-v27';
const EXPECTED = Object.freeze({
  blueChoice: 'branch-blue', greenChoiceAbsent: true, fallbackChoice: 'branch-fallback',
  ternaryTrue: 'closed-choice', ternaryFalse: false, bothProperties: 'both-enabled',
  rejectedProperty: false, expectedFalse: 'explicit-false', defaultMissing: 'default-applied',
  flagOverride: 'alias-override', flagDenied: false, flagDefault: 'alias-default'
});
const ISOLATION = Object.freeze({ people: 2, departments: 1, rolledBackNames: 0 });
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function assertConditionReview(contract) {
  assert.equal(contract.complete, true);
  assert.deepEqual(contract.unknowns, []);
  assert.equal(contract.executedProjectCode, false);
  assert.ok(contract.conditions.every(condition => condition.allOutcomesRetained && !condition.evaluated));
  const composedSpans = contract.resolvedConditionSpans.filter(span => span.kind === 'composed-condition');
  assert.equal(composedSpans.length, 12);
  const composed = contract.conditions.filter(condition => condition.composition);
  const chains = composed.filter(condition => condition.annotation === PREFIX + 'DeepFlags');
  assert.ok(chains.length > 0);
  assert.ok(chains.every(condition => condition.composition.chain.join(',') === PREFIX + 'DeepFlags,' + PREFIX + 'LocalFlags'));
  assert.ok(chains.every(condition => condition.composition.aliases.length === 2));
  const names = new Set(chains.flatMap(condition => condition.queries.map(query => query.name)));
  assert.deepEqual([...names].sort(), ['disabled', 'enabled', 'missing'].map(name => 'rocketbrain.fixture.flags.' + name));
  assert.equal(composed.filter(condition => condition.annotation === PREFIX + 'BranchGate').length, 3);
  assert.equal(composed.find(condition => condition.annotation === PREFIX + 'FixedChoice' && condition.expression).expression.ternaryExpressions, 2);
  assert.ok(contract.references.some(item => item.kind === 'spring.condition-type-reference' && item.type === PREFIX + 'AliasClasspathMarker'));
  assert.ok(contract.references.some(item => item.kind === 'spring.condition-metadata-reference' && item.type === PREFIX + 'DormantMarker'));
  assert.ok(contract.references.some(item => item.kind === 'spring.condition-meta-reference' && item.type === PREFIX + 'LocalFlags'));
  assert.equal(contract.methodContracts.filter(item => item.kind === 'spring.condition-entrypoint').length, 1);
}

async function verifyRunningFixture(config) {
  async function read(route) {
    const response = await fetch(config.baseUrl + route, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, route);
    return response.json();
  }
  const outcomes = await read(ROUTE);
  const isolation = await read('/probe/testing-state');
  assert.deepEqual(outcomes, EXPECTED);
  assert.deepEqual(isolation, ISOLATION);
  return { outcomes, isolation };
}

async function runJavaSpringContractV27Checks(api, vscode, checks) {
  await api.java.start();
  if (!process.env.ROCKETBRAIN_SPRING_V27_CONFIG) throw Error('Use the owned v27 Spring condition fixture config.');
  const runtime = readJson(process.env.ROCKETBRAIN_SPRING_V27_CONFIG);
  const java = readJson(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG);
  const fixture = fs.realpathSync(runtime.projectPath);
  assert.equal(path.relative(fs.realpathSync(FIXTURE_ROOT), fixture), '');
  assert.ok(['mysql', 'mariadb'].includes(runtime.dbEngine));
  const source = path.join(fixture, 'src/main/java/fixture/conditionsv27');
  const controller = path.join(source, 'app/ConditionRoutesController.java');
  const original = fs.readFileSync(controller);
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.27';
  const output = path.resolve(__dirname, '../test-output', prefix + '-spring-contract-v27-native', randomUUID());
  fs.mkdirSync(output, { recursive: true });
  const report = { version: '0.27.0', engine: runtime.dbEngine, cases: [], allOutcomesRetained: true,
    executedProjectCodeDuringConditionReview: false };
  let late;

  async function open(file) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
      if (symbols?.length) return document;
      await pause(200);
    }
    throw Error('The owned v27 Spring condition declaration was not indexed.');
  }
  function position(document, marker) {
    const index = document.getText().indexOf(marker);
    assert.ok(index >= 0, 'Declaration marker ' + marker);
    return document.positionAt(index + 1);
  }
  const conflict = { code: 'ROCKETBRAIN_SAFE_DELETE_CONFLICT' };
  const helper = 'obsoleteConditionV27Helper()';

  async function inspectAfterImport(document, at) {
    const deadline = Date.now() + 120000;
    for (;;) {
      try {
        return await api.java.safeDelete.inspect(document, at);
      } catch (error) {
        const retryable = ['Import this Java project before moving its source files.',
          'Move supports observed non-generated Java source roots only.'].includes(error.message);
        if (!retryable || Date.now() > deadline) throw error;
        await pause(350);
      }
    }
  }

  try {
    const initial = await verifyRunningFixture(runtime);
    let document = await open(controller);
    const { springAnalysis: analysis } = await inspectAfterImport(document, position(document, helper));
    assert.equal(analysis.verdict, 'allowed', JSON.stringify(analysis.unknowns));
    assertConditionReview(analysis.extensionContracts);
    const plan = await api.java.safeDelete.prepare(document, position(document, helper));
    assert.equal((await api.java.safeDelete.apply(plan.id)).state, 'applied');
    assert.equal(document.getText().includes(helper), false);
    const staged = stageFreshClasses({ fixture, output, controller, text: document.getText(), java });
    const transformed = await verifyRefactoringHttp(runtime, { classpath: staged.classpath, expectations: { [ROUTE]: EXPECTED } });
    assert.deepEqual(transformed.isolation, ISOLATION);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original.toString('utf8'));
    if (document.isDirty) await document.save();
    report.cases.push({ name: 'native helper deletion and Undo preserve composed condition outcomes',
      initial, transformed, analysis, nativeApply: true, nativeUndo: true, freshSourceCount: staged.sourceCount,
      dormantBranchReferencesRetained: true, annotationProcessorsDisabled: true });

    for (const [file, marker, finding] of [
      ['conditions/BranchCondition.java', 'matches(', 'spring.condition-entrypoint'],
      ['conditions/BranchCondition.java', 'BranchCondition implements', 'spring.condition-callback-type'],
      ['conditions/AliasClasspathMarker.java', 'AliasClasspathMarker {', 'spring.condition-type-reference']
    ]) {
      const target = await open(path.join(source, file));
      const { springAnalysis } = await api.java.safeDelete.inspect(target, position(target, marker));
      assert.equal(springAnalysis.verdict, 'blocked', finding);
      assert.ok(springAnalysis.relatedReferences.some(item => item.kind === finding), finding);
      await assert.rejects(api.java.safeDelete.prepare(target, position(target, marker)), conflict);
      report.cases.push({ name: 'composed condition dependency protected ' + marker, refused: true, finding });
    }

    document = await open(controller);
    const guarded = await api.java.safeDelete.prepare(document, position(document, helper));
    const lateFile = path.join(source, 'conditions/V27LateUnknown.java');
    fs.writeFileSync(lateFile, [
      'package fixture.conditionsv27.conditions;',
      '@FlagGate("en" + "abled") final class V27LateUnknown {}'
    ].join('\n') + '\n', { flag: 'wx' });
    late = lateFile;
    await assert.rejects(api.java.safeDelete.apply(guarded.id), /file set changed|reference.*changed/);
    assert.equal(document.getText(), original.toString('utf8'));
    report.cases.push({ name: 'late composed condition invalidates the preview', refused: true, editorPreserved: true });
    const { springAnalysis: opaque } = await api.java.safeDelete.inspect(document, position(document, helper));
    assert.equal(opaque.verdict, 'unknown');
    assert.ok(opaque.unknowns.some(item => item.kind === 'spring.composed-condition-unresolved'));
    await assert.rejects(api.java.safeDelete.prepare(document, position(document, helper)), conflict);
    report.cases.push({ name: 'computed alias remains unknown', refused: true });
    fs.unlinkSync(late);
    late = undefined;

    report.final = await verifyRunningFixture(runtime);
    checks.push('Composed Spring conditions and alias chains retain registration outcomes and protect callback and type references.');
    fs.writeFileSync(path.resolve(__dirname, '../test-output', prefix + '-native-java-spring-contract-v27-' + runtime.dbEngine + '.json'),
      JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (late && fs.existsSync(late)) fs.unlinkSync(late);
    const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.scheme === 'file'
      && path.relative(doc.uri.fsPath, controller) === '');
    if (document && document.getText() !== original.toString('utf8')) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original.toString('utf8'));
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await document.save();
    }
    assert.deepEqual(fs.readFileSync(controller), original);
  }
  return report;
}

module.exports = { runJavaSpringContractV27Checks, assertConditionReview, FIXTURE_ROOT };
