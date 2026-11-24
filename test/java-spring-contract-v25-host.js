'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyRefactoringHttp } = require('../scripts/refactoring-spring');

const EXPECTED = Object.freeze({
  conditionalBlue: 'condition-blue', conditionalGreen: false,
  profilePresent: 'profile-blue', profileAbsent: false,
  expressionPresent: 'closed-spel', expressionAbsent: false,
  classPresent: 'class-present', classMissing: false, namedBean: 'seed-present'
});
const ISOLATION = Object.freeze({ people: 2, departments: 1, rolledBackNames: 0 });
const ROUTE = '/refactoring/spring-conditions-v25';
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/refactoring-v25-spring');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function assertConditionReview(contract) {
  assert.deepEqual(contract.unknowns, []);
  assert.equal(contract.executedProjectCode, false);
  assert.equal(contract.conditions.length, 9);
  assert.ok(contract.conditions.every(condition => !condition.evaluated && condition.allOutcomesRetained));
  const byKind = names => contract.conditions.filter(condition => names.includes(condition.kind));
  const source = byKind(['source-condition']);
  assert.equal(source.length, 2);
  assert.ok(source.every(condition => condition.callbackOwners[0] === 'fixture.conditionsv25.conditions.ColorRouteCondition'));
  assert.deepEqual(source[0].queries.map(query => query.kind), [
    'environment-profiles', 'environment-string-equality', 'source-annotation-presence', 'environment-property-presence'
  ]);
  assert.deepEqual(source[0].queries[0].names, ['rocket-blue', 'rocket-prod', 'rocket-qa', 'rocket-fallback']);
  for (const [kind, count] of [['profile-expression', 2], ['closed-spel-expression', 2],
    ['literal-class-condition', 2], ['literal-bean-condition', 1]]) assert.equal(byKind([kind]).length, count);
  assert.ok(contract.references.some(reference => reference.kind === 'spring.condition-metadata-reference' && reference.name === 'RouteMarked'));
  assert.ok(contract.references.some(reference => reference.kind === 'spring.condition-bean-reference' && reference.name === 'fixtureConditionSeed'));
  assert.equal(contract.methodContracts.filter(reference => reference.kind === 'spring.condition-entrypoint').length, 1);
}

async function verifyRunningFixture(config) {
  const read = async route => {
    const response = await fetch(config.baseUrl + route, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const outcomes = await read(ROUTE);
  const isolation = await read('/probe/testing-state');
  assert.deepEqual(outcomes, EXPECTED);
  assert.deepEqual(isolation, ISOLATION);
  return { outcomes, isolation };
}

function stageFreshClasses({ fixture, output, controller, text, java }) {
  const stage = fs.mkdtempSync(path.join(output, 'after-delete-'));
  const classes = path.join(stage, 'classes'), originalSources = path.join(fixture, 'src/main/java');
  fs.mkdirSync(classes);
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.java') ? [file] : [];
  });
  const copied = walk(originalSources).map(file => {
    const destination = path.join(stage, 'src', path.relative(originalSources, file));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file === controller ? text : fs.readFileSync(file));
    return destination;
  });
  const fixtureClasses = path.join(fixture, 'build/classes').toLowerCase() + path.sep;
  const dependencies = fs.readFileSync(path.join(fixture, 'build/runtime-classpath.txt'), 'utf8').trim().split(path.delimiter)
    .filter(file => !file.toLowerCase().startsWith(fixtureClasses));
  const args = ['-proc:none', '-encoding', 'UTF-8', '-classpath', dependencies.join(path.delimiter), '-d', classes, ...copied];
  const argfile = path.join(stage, 'javac.args');
  fs.writeFileSync(argfile, args.map(value => JSON.stringify(value)).join('\n'));
  const result = spawnSync(path.join(java.javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'),
    ['@' + argfile], { windowsHide: true, encoding: 'utf8', timeout: 45000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  return { classpath: [classes, ...dependencies].join(path.delimiter), sourceCount: copied.length };
}

async function runJavaSpringContractV25Checks(api, vscode, checks) {
  await api.java.start();
  if (!process.env.ROCKETBRAIN_SPRING_V25_CONFIG) throw Error('Use the owned Spring condition v25 fixture config.');
  const runtime = readJson(process.env.ROCKETBRAIN_SPRING_V25_CONFIG);
  const java = readJson(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG);
  const fixture = fs.realpathSync(runtime.projectPath);
  assert.equal(path.relative(fs.realpathSync(FIXTURE_ROOT), fixture), '');
  const actualStat = fs.statSync(fixture, { bigint: true }), expectedStat = fs.statSync(FIXTURE_ROOT, { bigint: true });
  assert.equal(actualStat.dev, expectedStat.dev);
  assert.equal(actualStat.ino, expectedStat.ino);
  assert.ok(['mysql', 'mariadb'].includes(runtime.dbEngine));
  const source = path.join(fixture, 'src/main/java/fixture/conditionsv25');
  const controller = path.join(source, 'app/ConditionRoutesController.java');
  const original = fs.readFileSync(controller);
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.25';
  const reportBase = path.resolve(__dirname, '../test-output', prefix + '-spring-contract-v25-native');
  const output = path.join(reportBase, crypto.randomUUID());
  fs.mkdirSync(output, { recursive: true });
  const report = { version: '0.25.0', engine: runtime.dbEngine, cases: [],
    allOutcomesRetained: true, executedProjectCodeDuringConditionReview: false };
  let late;

  async function open(file) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
      if (symbols?.length) return document;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error('The owned Spring condition declaration was not indexed.');
  }
  const at = (document, marker) => {
    const start = document.getText().indexOf(marker);
    assert.ok(start >= 0, 'Declaration marker ' + marker);
    return document.positionAt(start + 1);
  };
  const conflict = error => error.code === 'ROCKETBRAIN_SAFE_DELETE_CONFLICT';
  const helper = 'obsoleteConditionV25Helper()';

  try {
    const initial = await verifyRunningFixture(runtime);
    let document = await open(controller);
    const { springAnalysis: analysis } = await api.java.safeDelete.inspect(document, at(document, helper));
    assert.equal(analysis.verdict, 'allowed', JSON.stringify(analysis.unknowns));
    assertConditionReview(analysis.extensionContracts);
    const plan = await api.java.safeDelete.prepare(document, at(document, helper));
    assert.equal((await api.java.safeDelete.apply(plan.id)).state, 'applied');
    assert.equal(document.getText().includes(helper), false);
    const staged = stageFreshClasses({ fixture, output, controller, text: document.getText(), java });
    const transformed = await verifyRefactoringHttp(runtime, { classpath: staged.classpath, expectations: { [ROUTE]: EXPECTED } });
    assert.deepEqual(transformed.isolation, ISOLATION);
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original.toString('utf8'));
    if (document.isDirty) await document.save();
    report.cases.push({ name: 'native private helper deletion and Undo preserve all condition routes', initial, transformed, analysis,
      nativeApply: true, nativeUndo: true, freshSourceCount: staged.sourceCount, annotationProcessorsDisabled: true });

    for (const [file, marker, finding] of [
      ['conditions/ColorRouteCondition.java', 'matches(', 'spring.condition-entrypoint'],
      ['conditions/ColorRouteCondition.java', 'ColorRouteCondition implements', 'spring.condition-callback-type'],
      ['conditions/ClasspathMarker.java', 'ClasspathMarker {', 'spring.condition-type-reference'],
      ['configuration/SeedRoutes.java', 'registrationSeed(', 'spring.condition-bean-reference']
    ]) {
      const target = await open(path.join(source, file));
      const inspection = await api.java.safeDelete.inspect(target, at(target, marker));
      assert.equal(inspection.springAnalysis.verdict, 'blocked', finding);
      assert.ok(inspection.springAnalysis.relatedReferences.some(item => item.kind === finding), finding);
      await assert.rejects(api.java.safeDelete.prepare(target, at(target, marker)), conflict);
      report.cases.push({ name: 'potential condition dependency protected ' + marker, refused: true, finding });
    }

    document = await open(controller);
    const guarded = await api.java.safeDelete.prepare(document, at(document, helper));
    const lateFile = path.join(source, 'conditions/V25LateUnknown.java');
    fs.writeFileSync(lateFile, [
      'package fixture.conditionsv25.conditions;',
      'import org.springframework.context.annotation.Conditional;',
      'import org.springframework.context.annotation.Condition;',
      'import org.springframework.context.annotation.ConditionContext;',
      'import org.springframework.core.type.AnnotatedTypeMetadata;',
      '@Conditional(V25LateUnknown.class) final class V25LateUnknown implements Condition {',
      ' public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {',
      '  return System.getProperty("outside.fixture") != null;',
      ' }',
      '}'
    ].join('\n') + '\n', { flag: 'wx' });
    late = lateFile;
    await assert.rejects(api.java.safeDelete.apply(guarded.id), /file set changed|reference.*changed/);
    assert.equal(document.getText(), original.toString('utf8'));
    report.cases.push({ name: 'condition reference source added after preview', refused: true, editorPreserved: true });
    const unknown = await api.java.safeDelete.inspect(document, at(document, helper));
    assert.equal(unknown.springAnalysis.verdict, 'unknown');
    assert.ok(unknown.springAnalysis.unknowns.some(item => item.kind === 'spring.dynamic-condition'));
    await assert.rejects(api.java.safeDelete.prepare(document, at(document, helper)), conflict);
    report.cases.push({ name: 'arbitrary Condition callback remains unknown', refused: true });
    fs.unlinkSync(late);
    late = undefined;
    report.final = await verifyRunningFixture(runtime);
    report.scope = 'Nine reviewed Spring condition usages retained across both outcomes. True and false routes, callback and input protection, saved Undo and fresh Javac plus real Spring/DB isolation were checked. Runtime validation executes separately from condition analysis.';
    checks.push('Spring profile, closed SpEL, local Condition, and explicit class/Bean conditions preserve every outcome; native helper apply/Undo, separate fresh compilation and real Spring/DB outcomes pass.');
    fs.writeFileSync(path.resolve(__dirname, '../test-output', prefix + '-native-java-spring-contract-v25-' + runtime.dbEngine + '.json'),
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

module.exports = { runJavaSpringContractV25Checks, assertConditionReview, stageFreshClasses, FIXTURE_ROOT };
