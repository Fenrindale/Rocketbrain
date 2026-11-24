'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { verifyRefactoringHttp } = require('../scripts/refactoring-spring');
const { stageFreshClasses } = require('./java-spring-contract-v25-host');

const EXPECTED = Object.freeze({
  blueChoice: 'branch-blue', greenChoiceAbsent: true, fallbackChoice: 'branch-fallback',
  ternaryTrue: 'closed-choice', ternaryFalse: false, bothProperties: 'both-enabled',
  rejectedProperty: false, expectedFalse: 'explicit-false', defaultMissing: 'default-applied'
});
const ISOLATION = Object.freeze({ people: 2, departments: 1, rolledBackNames: 0 });
const ROUTE = '/refactoring/spring-conditions-v26';
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/refactoring-v26-spring');
const CALLBACK = 'fixture.conditionsv26.conditions.BranchCondition';
const DORMANT = 'fixture.conditionsv26.conditions.DormantMarker';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function assertConditionReview(contract) {
  assert.deepEqual(contract.unknowns, []);
  assert.equal(contract.executedProjectCode, false);
  const { conditions } = contract;
  assert.equal(conditions.length, 10);
  assert.ok(conditions.every(condition => !condition.evaluated && condition.allOutcomesRetained));
  const callbacks = conditions.filter(item => item.kind === 'source-condition');
  assert.equal(callbacks.length, 3);
  for (const item of callbacks) {
    assert.deepEqual(item.callbackFlows, [{ owner: CALLBACK, booleanLocals: 2, environmentAliases: 1,
      branchStatements: 2, ternaryExpressions: 1, returns: 3 }]);
    assert.deepEqual(item.queries[0], {
      kind: 'environment-accepted-profiles', names: ['rocket-blue', 'rocket-prod', 'rocket-qa', 'rocket-fallback']
    });
  }
  assert.ok(contract.references.some(item => item.kind === 'spring.condition-metadata-reference' && item.type === DORMANT));
  const expressions = conditions.filter(item => item.kind === 'closed-spel-expression');
  assert.deepEqual(expressions.map(item => item.expression.ternaryExpressions), [2, 2]);
  const properties = conditions.filter(item => item.kind === 'literal-boolean-property-condition').flatMap(item => item.queries);
  assert.deepEqual(properties.map(({ name, expected, matchIfMissing }) => [name, expected, matchIfMissing]), [
    ['rocketbrain.fixture.flags.enabled', true, false], ['rocketbrain.fixture.flags.audited', true, false],
    ['rocketbrain.fixture.flags.disabled', true, false], ['rocketbrain.fixture.flags.disabled', false, false],
    ['rocketbrain.fixture.flags.missing', true, true]
  ]);
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

async function runJavaSpringContractV26Checks(api, vscode, checks) {
  await api.java.start();
  if (!process.env.ROCKETBRAIN_SPRING_V26_CONFIG) throw Error('Use the owned v26 Spring condition fixture config.');
  const runtime = readJson(process.env.ROCKETBRAIN_SPRING_V26_CONFIG);
  const java = readJson(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG);
  const fixture = fs.realpathSync(runtime.projectPath);
  assert.equal(path.relative(fs.realpathSync(FIXTURE_ROOT), fixture), '');
  const actual = fs.statSync(fixture, { bigint: true }), expected = fs.statSync(FIXTURE_ROOT, { bigint: true });
  assert.deepEqual([actual.dev, actual.ino], [expected.dev, expected.ino]);
  assert.ok(['mysql', 'mariadb'].includes(runtime.dbEngine));
  const source = path.join(fixture, 'src/main/java/fixture/conditionsv26');
  const controller = path.join(source, 'app/ConditionRoutesController.java');
  const original = fs.readFileSync(controller);
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.26';
  const output = path.resolve(__dirname, '../test-output', prefix + '-spring-contract-v26-native', crypto.randomUUID());
  fs.mkdirSync(output, { recursive: true });
  const report = { version: '0.26.0', engine: runtime.dbEngine, cases: [], allOutcomesRetained: true,
    executedProjectCodeDuringConditionReview: false };
  let late;

  async function open(file) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: false });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
      if (symbols?.length) return document;
      await pause(200);
    }
    throw Error('The owned v26 Spring condition declaration was not indexed.');
  }
  const at = (document, marker) => {
    const index = document.getText().indexOf(marker);
    assert.ok(index >= 0, 'Declaration marker ' + marker);
    return document.positionAt(index + 1);
  };
  const conflict = error => error.code === 'ROCKETBRAIN_SAFE_DELETE_CONFLICT';
  const helper = 'obsoleteConditionV26Helper()';

  async function inspectAfterImport(document, position) {
    const deadline = Date.now() + 120000;
    for (;;) {
      try {
        return await api.java.safeDelete.inspect(document, position);
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
    const { springAnalysis: analysis } = await inspectAfterImport(document, at(document, helper));
    assert.equal(analysis.verdict, 'allowed', JSON.stringify(analysis.unknowns));
    assertConditionReview(analysis.extensionContracts);
    const plan = await api.java.safeDelete.prepare(document, at(document, helper));
    assert.equal((await api.java.safeDelete.apply(plan.id)).state, 'applied');
    assert.equal(document.getText().includes(helper), false);
    const staged = stageFreshClasses({ fixture, output, controller, text: document.getText(), java });
    const transformed = await verifyRefactoringHttp(runtime, { classpath: staged.classpath, expectations: { [ROUTE]: EXPECTED } });
    assert.deepEqual(transformed.isolation, ISOLATION);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original.toString('utf8'));
    if (document.isDirty) await document.save();
    report.cases.push({ name: 'native helper deletion and Undo preserve all new Spring outcomes',
      initial, transformed, analysis, nativeApply: true, nativeUndo: true, freshSourceCount: staged.sourceCount,
      dormantBranchReferencesRetained: true, annotationProcessorsDisabled: true });

    for (const [file, marker, finding] of [
      ['conditions/BranchCondition.java', 'matches(', 'spring.condition-entrypoint'],
      ['conditions/BranchCondition.java', 'BranchCondition implements', 'spring.condition-callback-type'],
      ['conditions/ClasspathMarker.java', 'ClasspathMarker {', 'spring.condition-type-reference']
    ]) {
      const target = await open(path.join(source, file));
      const { springAnalysis } = await api.java.safeDelete.inspect(target, at(target, marker));
      assert.equal(springAnalysis.verdict, 'blocked', finding);
      assert.ok(springAnalysis.relatedReferences.some(item => item.kind === finding), finding);
      await assert.rejects(api.java.safeDelete.prepare(target, at(target, marker)), conflict);
      report.cases.push({ name: 'potential condition dependency protected ' + marker, refused: true, finding });
    }

    document = await open(controller);
    const guarded = await api.java.safeDelete.prepare(document, at(document, helper));
    const lateFile = path.join(source, 'conditions/V26LateUnknown.java');
    fs.writeFileSync(lateFile, [
      'package fixture.conditionsv26.conditions;',
      'import org.springframework.context.annotation.Conditional;',
      'import org.springframework.context.annotation.Condition;',
      'import org.springframework.context.annotation.ConditionContext;',
      'import org.springframework.core.type.AnnotatedTypeMetadata;',
      '@Conditional(V26LateUnknown.class) final class V26LateUnknown implements Condition {',
      ' public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {',
      '  if (true) { return true; }',
      '  return System.getProperty("outside.fixture") != null;',
      ' }',
      '}'
    ].join('\n') + '\n', { flag: 'wx' });
    late = lateFile;
    await assert.rejects(api.java.safeDelete.apply(guarded.id), /file set changed|reference.*changed/);
    assert.equal(document.getText(), original.toString('utf8'));
    report.cases.push({ name: 'late unreviewed condition invalidates the preview', refused: true, editorPreserved: true });
    const { springAnalysis: opaque } = await api.java.safeDelete.inspect(document, at(document, helper));
    assert.equal(opaque.verdict, 'unknown');
    assert.ok(opaque.unknowns.some(item => item.kind === 'spring.dynamic-condition'));
    await assert.rejects(api.java.safeDelete.prepare(document, at(document, helper)), conflict);
    report.cases.push({ name: 'runtime-dependent branch remains unknown despite a constant first path', refused: true });
    fs.unlinkSync(late);
    late = undefined;
    report.final = await verifyRunningFixture(runtime);
    report.scope = 'Ten source conditions retained both outcomes. Actual Spring registered the expected routes before and after native helper deletion, fresh Javac compilation, and Undo.';
    checks.push('Branching Spring Condition callbacks, closed SpEL choices, and explicit boolean properties preserve outcomes and dependency guards.');
    fs.writeFileSync(path.resolve(__dirname, '../test-output', prefix + '-native-java-spring-contract-v26-' + runtime.dbEngine + '.json'),
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

module.exports = { runJavaSpringContractV26Checks, assertConditionReview, FIXTURE_ROOT };
