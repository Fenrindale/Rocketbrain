'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { analyzeSpringContracts } = require('../src/java/spring-contract-analysis');
const { analyzeSpringDelete } = require('../src/java/spring-delete-analysis');
const { SPRING_CONDITION_LIMITS } = require('../src/java/spring-condition-analysis');
const { rangeAt } = require('../src/spring/java');
const { assertConditionReview, FIXTURE_ROOT } = require('./java-spring-contract-v26-host');

const CONTEXT = 'org.springframework.context.annotation.';
const BOOT = 'org.springframework.boot.autoconfigure.condition.';
const ENVIRONMENT = 'org.springframework.core.env.Environment';
const PROFILES = 'org.springframework.core.env.Profiles';
const src = (name, body, imports = []) => ({ uri: 'file:///project/' + name + '.java',
  text: ['package demo;', ...imports.map(value => 'import ' + value + ';'), body].join('\n') });
const host = src('Host', 'class Host { private int unrelated() { return 42; } }');
const guard = src('Guard', '@Conditional(Filter.class) final class Guard {}', [CONTEXT + 'Conditional']);
const source = (body, { imports = [ENVIRONMENT, PROFILES], context = 'context' } = {}) =>
  src('Filter', 'public final class Filter implements Condition {'
    + '@Override public boolean matches(ConditionContext ' + context + ', AnnotatedTypeMetadata metadata) { ' + body + ' }}',
  [CONTEXT + 'Condition', CONTEXT + 'ConditionContext', 'org.springframework.core.type.AnnotatedTypeMetadata', ...imports]);
const annotation = (name, args) => src('Annotated', '@' + name + args + ' final class Annotated {}', [BOOT + name]);

function inspect(sources, selected = host, name = 'unrelated') {
  const at = selected.text.indexOf(name + '(');
  return analyzeSpringDelete({ sources, uri: selected.uri, candidate: { kind: 'method', name,
    start: selected.text.lastIndexOf('{', at) + 1, end: selected.text.indexOf('}', at) + 1,
    declarationRange: rangeAt(selected.text, at, at + name.length) } });
}
const flow = (body, options) => inspect([host, guard, source(body, options)]);

test('Source callback retains fallthrough, braced branches and every query without evaluating any outcome', () => {
  const markers = ['First', 'Second', 'Third', 'Fourth'].map(name => src(name, 'public @interface ' + name + ' {}'));
  const callback = source(
    'final Environment environment = context.getEnvironment();'
    + 'final boolean blue = environment.acceptsProfiles(Profiles.of("test-blue & (!prod | qa)", "fallback"));'
    + 'if (blue && metadata.isAnnotated("demo.First")) {'
    + '  final boolean selected = true == "blue".equals(environment.getProperty("demo.palette"));'
    + '  return selected ? metadata.isAnnotated("demo.Second") : metadata.isAnnotated("demo.Third");'
    + '} else if (metadata.isAnnotated("demo.Fourth")) {'
    + '  return environment.containsProperty("demo.fallback");'
    + '} return false;');
  const result = inspect([host, guard, callback, ...markers]);
  assert.equal(result.verdict, 'allowed');
  const contract = result.extensionContracts, [review] = contract.conditions;
  assert.deepEqual(review.callbackFlows, [{ owner: 'demo.Filter', booleanLocals: 2, environmentAliases: 1,
    branchStatements: 2, ternaryExpressions: 1, returns: 3 }]);
  assert.equal(review.evaluated, false);
  assert.equal(review.allOutcomesRetained, true);
  assert.equal(contract.executedProjectCode, false);
  assert.deepEqual(review.queries[0], { kind: 'environment-accepted-profiles', names: ['test-blue', 'prod', 'qa', 'fallback'] });
  const references = contract.references.filter(item => item.kind === 'spring.condition-metadata-reference').map(item => item.type);
  assert.deepEqual(references, ['demo.First', 'demo.Second', 'demo.Third', 'demo.Fourth']);
  assert.ok(inspect([host, guard, callback, ...markers], callback, 'matches').conflicts.some(item => item.kind === 'spring.condition-entrypoint'));
});

test('Quoted condition predicates and same-name bindings in mutually exclusive blocks preserve explicit scopes', () => {
  const result = flow('final boolean before = "yes".equals(context.getEnvironment().getProperty("demo.state"));'
    + 'if (before) { final boolean override = false; return override; }'
    + 'else { final boolean override = true; return override; }');
  assert.equal(result.verdict, 'allowed');
  assert.equal(result.extensionContracts.conditions[0].callbackFlows[0].booleanLocals, 3);
  assert.equal(flow('final org.springframework.core.env.Environment e = context.getEnvironment(); return e.containsProperty("key");').verdict, 'allowed');
});

for (const [description, body, options] of [
  ['a computed binding', 'final Environment e = factory(); return e.containsProperty("x");'],
  ['a mutable alias', 'Environment e = context.getEnvironment(); return e.containsProperty("x");'],
  ['a mutable local', 'final boolean b = true; b = false; return b;'],
  ['local from another block', 'if (true) { final boolean b = true; } return b;'],
  ['duplicate local in nested block', 'final boolean b = true; if (b) { final boolean b = true; return b; } return false;'],
  ['forward use', 'final boolean b = after; final boolean after = true; return b;'],
  ['parameter name collision', 'final boolean context = true; return context;'],
  ['branch without a continued return', 'if (true) { return true; }'],
  ['unbraced statement', 'if (true) return true; return false;'],
  ['a method call hidden behind a literal branch', 'if (true) { return true; } else { return factory(); }'],
  ['an unsafe ternary arm', 'return true ? true : System.getProperty("outside") != null;'],
  ['a fake Environment import', 'final Environment e = context.getEnvironment(); return e.containsProperty("x");', { imports: ['other.Environment'] }],
  ['a fake Profiles type', 'return context.getEnvironment().acceptsProfiles(Profiles.of("dev"));', { imports: ['other.Profiles'] }],
  ['a shadowed Profiles factory', 'return Profiles.getEnvironment().acceptsProfiles(Profiles.of("dev"));', { context: 'Profiles' }],
  ['a statically imported Profiles name', 'return context.getEnvironment().acceptsProfiles(Profiles.of("dev"));',
    { imports: [PROFILES, 'static other.Holder.Profiles'] }],
  ['computed Profiles.of inputs', 'return context.getEnvironment().acceptsProfiles(Profiles.of(name()));'],
  ['an arbitrary Profiles predicate', 'return context.getEnvironment().acceptsProfiles(profile -> true);'],
  ['a mixed profile expression', 'return context.getEnvironment().acceptsProfiles(Profiles.of("x & y | z"));'],
  ['separated equality tokens', 'return true = = true;']
]) test('Safe Delete refuses Condition flow with ' + description, () => {
  const result = flow(body, options);
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.extensionContracts.unknowns.some(item => item.kind === 'spring.dynamic-condition'));
  assert.equal(result.extensionContracts.conditions.length, 0);
});

test('Source Condition enforces aggregate budgets for locals and decisions', () => {
  const locals = Array.from({ length: SPRING_CONDITION_LIMITS.locals + 1 }, (_, index) => 'final boolean b' + index + ' = true;').join('');
  const branches = 'if (true) {}'.repeat(SPRING_CONDITION_LIMITS.branches + 1);
  const choices = Array.from({ length: SPRING_CONDITION_LIMITS.locals }, (_, index) => 'final boolean b' + index + ' = true ? true : false;').join('');
  assert.equal(flow(locals + 'return true;').verdict, 'unknown');
  assert.equal(flow(branches + 'return true;').verdict, 'unknown');
  assert.equal(flow(choices + 'return true ? true : false;').verdict, 'unknown');
});

test('Closed SpEL permits boolean ternaries with nested choices and keeps opaque expressions unknown', () => {
  const matches = value => inspect([host, annotation('ConditionalOnExpression', '(' + JSON.stringify(value) + ')')]);
  const result = matches("#{(2 == 2 && 'a' != 'b') ? (true ? true : false) : false}");
  assert.equal(result.verdict, 'allowed');
  assert.equal(result.extensionContracts.conditions[0].expression.ternaryExpressions, 2);
  assert.equal(result.extensionContracts.conditions[0].evaluated, false);
  for (const value of ['true ? true : @bean.enabled', 'true ? true : T(java.lang.Boolean).TRUE',
    'true ? false : ${external:false}', 'true ? true : 7', 'true ?: false', 'true ? false',
    'true ? true : (#unknown ? false : true)', 'true ? true : true /* ignored */']) assert.equal(matches(value).verdict, 'unknown');
});

test('Boot boolean properties retain literal defaults, flags, aliases and normalized keys', () => {
  const result = inspect([host, annotation('ConditionalOnBooleanProperty',
    '(prefix="demo.flags.",name={"enabled","audited"},havingValue=false,matchIfMissing=true)')]);
  assert.equal(result.verdict, 'allowed');
  assert.deepEqual(result.extensionContracts.conditions[0].queries, ['demo.flags.enabled', 'demo.flags.audited']
    .map(name => ({ kind: 'environment-boolean-property', name, expected: false, matchIfMissing: true })));
  const defaults = inspect([host, annotation('ConditionalOnBooleanProperty', '("demo.enabled")')]);
  assert.equal(defaults.verdict, 'allowed');
  assert.deepEqual(defaults.extensionContracts.conditions[0].queries, [
    { kind: 'environment-boolean-property', name: 'demo.enabled', expected: true, matchIfMissing: false }
  ]);
});

test('Boot boolean properties reject missing inputs, alias ambiguity, placeholders, duplicate keys and spoofed annotations', () => {
  for (const args of ['', '(name={})', '(value="flag",name="other")', '(value={"flag","flag"})',
    '(prefix="demo..",name="flag")', '(name="${dynamic}")', '(name="flag",havingValue=Flags.EXPECTED)',
    '(name="flag",matchIfMissing="true")']) {
    const result = inspect([host, annotation('ConditionalOnBooleanProperty', args)]);
    assert.equal(result.verdict, 'unknown', args);
  }
  const spoofed = src('Annotated', '@ConditionalOnBooleanProperty("flag") final class Annotated {}',
    [BOOT + '*', 'static alternate.Outer.ConditionalOnBooleanProperty']);
  assert.equal(inspect([host, spoofed]).verdict, 'unknown');
});

test('Actual v26 source fixture retains the dormant branch, properties and every reviewed condition', () => {
  function walk(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(folder, entry.name);
      return entry.isDirectory() ? walk(file) : entry.name.endsWith('.java') ? [file] : [];
    });
  }
  const sources = walk(path.join(FIXTURE_ROOT, 'src/main/java'))
    .map(file => ({ uri: pathToFileURL(file).href, text: fs.readFileSync(file, 'utf8') }));
  assertConditionReview(analyzeSpringContracts(sources));
  const controller = sources.find(item => item.uri.endsWith('/ConditionRoutesController.java'));
  assert.equal(inspect(sources, controller, 'obsoleteConditionV26Helper').verdict, 'allowed');
});
