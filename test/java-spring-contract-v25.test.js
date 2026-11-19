'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { analyzeSpringContracts, inspectSpringMethodContract } = require('../src/java/spring-contract-analysis');
const { analyzeSpringDelete } = require('../src/java/spring-delete-analysis');
const { rangeAt } = require('../src/spring/java');
const { parseProfileExpression, PROFILE_EXPRESSION_LIMITS } = require('../src/spring/profile-expression');
const { assertConditionReview, FIXTURE_ROOT } = require('./java-spring-contract-v25-host');

const context = 'org.springframework.context.annotation.';
const boot = 'org.springframework.boot.autoconfigure.condition.';
const src = (name, body, imports = []) => ({ uri: 'file:///project/' + name + '.java',
  text: ['package demo;', ...imports.map(value => 'import ' + value + ';'), body].join('\n') });
const host = src('Host', 'class Host { private int unrelated() { return 42; } }');
const type = src('Referenced', 'final class Referenced {}');
const marker = src('Marker', 'public @interface Marker {}');
const conditionImports = [context + 'Condition', context + 'ConditionContext', 'org.springframework.core.type.AnnotatedTypeMetadata'];
const sourceCondition = body => src('Filter', 'public final class Filter implements Condition {'
  + '@Override public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {'
  + body + '}}', conditionImports);
const guard = (shortName, args, owner = 'Guard') => src(owner, '@' + shortName + args + ' final class ' + owner + ' {}',
  [(shortName.startsWith('ConditionalOn') ? boot : context) + shortName]);
const guarded = guard('Conditional', '(Filter.class)');
const conditionInput = body => [sourceCondition(body), guarded, host, marker];

function inspect(sources, selected = host, name = 'unrelated', kind = 'method') {
  const at = selected.text.indexOf(name + (kind === 'method' ? '(' : ''));
  const start = kind === 'method' ? selected.text.lastIndexOf('{', at) + 1 : 0;
  const end = kind === 'method' ? selected.text.indexOf('}', at) + 1 : selected.text.length;
  return analyzeSpringDelete({ sources, uri: selected.uri, candidate: { kind, name, start, end,
    declarationRange: rangeAt(selected.text, at, at + name.length) } });
}

test('Exact Condition matches preserves profile, environment and metadata references for every outcome', () => {
  const input = conditionInput('return (context.getEnvironment().matchesProfiles("blue & (!prod | qa)", "green")'
    + ' && "blue".equals(context.getEnvironment().getProperty("spring.route"))'
    + ' && metadata.isAnnotated("demo.Marker")) || context.getEnvironment().containsProperty("spring.override");');
  const result = inspect(input);
  assert.equal(result.verdict, 'allowed');
  const report = result.extensionContracts;
  assert.equal(report.executedProjectCode, false);
  assert.equal(report.conditions.length, 1);
  const [condition] = report.conditions;
  assert.equal(condition.evaluated, false);
  assert.equal(condition.allOutcomesRetained, true);
  assert.deepEqual(condition.callbackOwners, ['demo.Filter']);
  assert.deepEqual(condition.queries, [
    { kind: 'environment-profiles', names: ['blue', 'prod', 'qa', 'green'] },
    { kind: 'environment-string-equality', name: 'spring.route' },
    { kind: 'source-annotation-presence', type: 'demo.Marker' },
    { kind: 'environment-property-presence', name: 'spring.override' }
  ]);
  assert.ok(report.references.some(item => item.type === 'demo.Marker' && item.kind === 'spring.condition-metadata-reference'));
  const callbackFile = input[0];
  assert.equal(inspect(input, callbackFile, 'Filter', 'file').verdict, 'blocked');
  assert.ok(inspect(input, callbackFile, 'matches').conflicts.some(item => item.kind === 'spring.condition-entrypoint'));
  assert.equal(inspectSpringMethodContract(report, { uri: callbackFile.uri, owner: 'demo.Filter', name: 'matches' }).allowed, false);
});

test('Multiple Condition class literals retain each callback and reject repeated types', () => {
  const first = sourceCondition('return true;');
  const second = { ...first, uri: 'file:///project/Second.java', text: first.text.replace('class Filter', 'class Second') };
  const report = analyzeSpringContracts([first, second, guard('Conditional', '({Filter.class, Second.class,})')]);
  assert.deepEqual(report.unknowns, []);
  assert.deepEqual(report.conditions[0].callbackOwners, ['demo.Filter', 'demo.Second']);
  assert.equal(report.methodContracts.length, 2);
  assert.ok(analyzeSpringContracts([first, guard('Conditional', '({Filter.class, Filter.class})')]).unknowns.length);
});

for (const [description, body] of [
  ['system property', 'return System.getProperty("outside") != null;'],
  ['BeanFactory access', 'return context.getBeanFactory().containsBean("important");'],
  ['computed property name', 'return context.getEnvironment().containsProperty(variable);'],
  ['property value-side invocation', 'return context.getEnvironment().getProperty("spring.route").equals("blue");'],
  ['arbitrary equals', 'return someValue.equals(context.getEnvironment().getProperty("spring.route"));'],
  ['overloaded property read', 'return "blue".equals(context.getEnvironment().getProperty("spring.route", "blue"));'],
  ['external metadata type', 'return metadata.isAnnotated("other.Marker");'],
  ['metadata overload', 'return metadata.isAnnotated("demo.Marker", true);'],
  ['dynamic profile', 'return context.getEnvironment().matchesProfiles(variable);'],
  ['mixed profile operators', 'return context.getEnvironment().matchesProfiles("a & b | c");'],
  ['extra statement', 'final boolean yes = true; return yes;'],
  ['loop', 'for (;;) { return true; }'],
  ['separated logical operator', 'return true & & false;']
]) test('Safe Delete refuses opaque Condition callback ' + description, () => {
  const report = inspect(conditionInput(body));
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.extensionContracts.conditions.length, 0);
  assert.ok(report.unknowns.some(item => item.kind === 'spring.dynamic-condition'));
});

test('Condition subtype, initialization, spoofed APIs and unknown source callbacks remain unresolved', () => {
  const original = sourceCondition('return true;');
  const variants = [
    original.text.replace('final class', 'class'),
    original.text.replace('implements Condition', 'extends Parent implements Condition'),
    original.text.replace('{@Override', '{private int state = 1; @Override'),
    original.text.replace('{@Override', '{public Filter() {} @Override'),
    original.text.replace('import ' + conditionImports[0], 'import fake.Condition'),
    original.text.replace('import ' + conditionImports[1], 'import fake.ConditionContext'),
    original.text.replace('import ' + conditionImports[2], 'import fake.AnnotatedTypeMetadata'),
    original.text.replace('public boolean', 'public synchronized boolean'),
    original.text.replace('metadata) {', 'metadata) throws Exception {')
  ];
  for (const text of variants) assert.equal(inspect([host, guarded, { ...original, text }]).verdict, 'unknown', text);
  assert.equal(inspect([host, guarded]).verdict, 'unknown');
  const conflicting = src('Override', 'public @interface Override {}');
  assert.equal(inspect([host, guarded, original, conflicting]).verdict, 'unknown');
});

test('Only exact reviewed Spring condition annotation argument spans suppress the generic unknown findings', () => {
  const expression = guard('ConditionalOnExpression', '("#{!(true && false) && (2 == 2 || \'x\' != \'x\')}")');
  assert.equal(inspect([host, expression]).verdict, 'allowed');
  const reflection = src('Reflection', 'class Reflection { Object reflect(String t) throws Exception { return Class.forName(t); } }');
  assert.equal(inspect([host, expression, reflection]).verdict, 'unknown');
  const otherSpel = src('OtherSpel', 'class OtherSpel { @Value("#{T(java.lang.Class).forName(config)}") Object value; }',
    ['org.springframework.beans.factory.annotation.Value']);
  assert.ok(inspect([host, expression, otherSpel]).unknowns.some(item => item.kind === 'spring.dynamic-spel'));
  const spoofed = { ...expression, text: expression.text.replace(boot, 'fake.condition.') };
  assert.equal(inspect([host, spoofed]).verdict, 'unknown');
});

for (const body of ['"@bean.enabled"', '"T(java.lang.String).valueOf(1) == \'1\'"', '"\${spring.flag:true}"',
  '"\'\${spring.mode:blue}\' == \'blue\'"', '"true /* bytes hidden by Java lexer */"', '"1 == \'1\'"',
  '"(true"', '"true ? false : true"', '"!3 == 3"', '"true" + " || false"', 'Expressions.CONDITION', 'value="true", value="false"']) {
  test('Unclosed, dynamic or nonliteral SpEL stays unknown for ' + body, () => {
    const report = inspect([host, guard('ConditionalOnExpression', '(' + body + ')')]);
    assert.equal(report.verdict, 'unknown');
    assert.ok(report.unknowns.some(item => item.kind === 'spring.dynamic-condition'));
  });
}

test('Literal Profile expression grammar shares bounds with model matching and retains all literal alternatives', () => {
  const result = inspect([host, guard('Profile', '({"blue & (!prod | qa)", "green",})')]);
  assert.equal(result.verdict, 'allowed');
  assert.deepEqual(result.extensionContracts.conditions[0].queries[0].names, ['blue', 'prod', 'qa', 'green']);
  for (const expression of ['()', 'a && b', 'a b', 'a & b | c', 'a |', '\${profiles}', '!'.repeat(PROFILE_EXPRESSION_LIMITS.depth + 2) + 'a']) {
    assert.throws(() => parseProfileExpression(expression));
    assert.equal(inspect([host, guard('Profile', '(' + JSON.stringify(expression) + ')')]).verdict, 'unknown');
  }
});

test('Literal Boot class/type and name conditions protect source dependencies and explicit Bean aliases', () => {
  const active = guard('ConditionalOnClass', '(value=Referenced.class, name={"external.OptionalApi"})', 'Present');
  const absent = guard('ConditionalOnMissingClass', '("demo.Referenced")', 'Absent');
  const candidate = guard('ConditionalOnSingleCandidate', '(type="demo.Referenced")', 'Candidate');
  const seed = src('Seed', '@Configuration final class Seed { @Bean(name={"keptAlias", "secondaryAlias"}) String sourceFactory() { return "kept"; } }',
    [context + 'Configuration', context + 'Bean']);
  const bean = guard('ConditionalOnMissingBean', '(value=Referenced.class,name={"secondaryAlias"})', 'BeanGuard');
  const input = [host, type, active, absent, candidate, seed, bean];
  const verdict = inspect(input);
  assert.equal(verdict.verdict, 'allowed');
  assert.equal(verdict.extensionContracts.conditions.length, 4);
  assert.equal(inspect(input, type, 'Referenced', 'file').conflicts.filter(item => item.kind === 'spring.condition-type-reference').length, 4);
  assert.ok(inspect(input, seed, 'sourceFactory').conflicts.some(item => item.kind === 'spring.condition-bean-reference'));
});

test('Unsupported class and Bean predicate attributes or candidate inference stay unknown', () => {
  const extra = [
    guard('ConditionalOnBean', '(name="named", search=SearchStrategy.CURRENT)'),
    guard('ConditionalOnMissingBean', ''),
    guard('ConditionalOnBean', '(annotation=External.class)'),
    guard('ConditionalOnClass', '(name=Values.CLASS)'),
    guard('ConditionalOnClass', '(Alias.Member.class)'),
    guard('ConditionalOnMissingClass', '(name="demo.Referenced")'),
    guard('ConditionalOnSingleCandidate', '(value=Referenced.class,type="demo.Other")'),
    guard('ConditionalOnSingleCandidate', '(type={"demo.Referenced"})')
  ];
  // An imported enclosing type must not be confused with a qualified class name.
  extra[4].text = extra[4].text.replace('@Conditional', 'import external.Alias;\n@Conditional');
  for (const item of extra) assert.equal(inspect([host, type, item]).verdict, 'unknown', item.text);
});

test('Source condition analysis enforces finite boolean argument and nesting budgets', () => {
  const calls = Array.from({ length: 17 }, () => '"profile"').join(',');
  const input = conditionInput('return context.getEnvironment().matchesProfiles(' + calls + ');');
  assert.equal(inspect(input).verdict, 'unknown');
  assert.equal(inspect(conditionInput('return ' + '!'.repeat(18) + 'true;')).verdict, 'unknown');
  assert.equal(inspect(conditionInput('return ' + Array.from({ length: 160 }, () => 'true').join('&&') + ';')).verdict, 'unknown');
});

test('Repeated reviewed callback references cannot exceed the aggregate condition report budget', () => {
  const expression = Array.from({ length: 32 }, (_, index) => 'p' + index).join(' | ');
  const callback = sourceCondition('return context.getEnvironment().matchesProfiles("' + expression + '");');
  const consumers = Array.from({ length: 80 }, (_, index) => guard('Conditional', '(Filter.class)', 'Guard' + index));
  const report = inspect([host, callback, ...consumers]);
  assert.equal(report.verdict, 'unknown');
  assert.equal(report.extensionContracts.complete, false);
  assert.ok(report.unknowns.some(item => item.kind === 'spring.condition-budget'));
  assert.ok(report.extensionContracts.conditions.length < consumers.length);
});

test('Actual v25 Spring source fixture reviews all nine condition usages and permits only the unrelated private helper', () => {
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.java') ? [file] : [];
  });
  const sources = walk(path.join(FIXTURE_ROOT, 'src/main/java')).map(file => ({ uri: pathToFileURL(file).href, text: fs.readFileSync(file, 'utf8') }));
  assertConditionReview(analyzeSpringContracts(sources));
  const controller = sources.find(item => item.uri.endsWith('/ConditionRoutesController.java'));
  assert.equal(inspect(sources, controller, 'obsoleteConditionV25Helper').verdict, 'allowed');
});
