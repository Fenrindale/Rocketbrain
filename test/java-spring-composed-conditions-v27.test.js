'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { analyzeSpringContracts } = require('../src/java/spring-contract-analysis');
const { analyzeSpringDelete } = require('../src/java/spring-delete-analysis');
const { rangeAt } = require('../src/spring/java');
const { assertConditionReview, FIXTURE_ROOT } = require('./java-spring-contract-v27-host');

const BOOT = 'org.springframework.boot.autoconfigure.condition.';
const ALIAS = 'org.springframework.core.annotation.AliasFor';
const DECORATORS = [
  'java.lang.annotation.Retention', 'java.lang.annotation.RetentionPolicy',
  'java.lang.annotation.Target', 'java.lang.annotation.ElementType'
];
const alias = (target, attribute, member) =>
  '@AliasFor(annotation=' + target + '.class, attribute="' + attribute + '") ' + member + ';';
const source = (name, body, imports = []) => ({ uri: 'file:///demo/' + name + '.java',
  text: ['package demo;', ...imports.map(value => 'import ' + value + ';'), body].join('\n') });
const annotation = (name, metadata, body = '', imports = []) => source(name,
  '@Retention(RetentionPolicy.RUNTIME) @Target({ElementType.TYPE, ElementType.METHOD}) '
  + metadata + ' public @interface ' + name + ' { ' + body + ' }', [...DECORATORS, ...imports, ...(body ? [ALIAS] : [])]);
const flags = (body = alias('ConditionalOnBooleanProperty', 'name', 'String[] flags() default {"fallback"}')) =>
  annotation('LocalFlags', '@ConditionalOnBooleanProperty(prefix="demo", name="base")', body, [BOOT + 'ConditionalOnBooleanProperty']);
const wrapper = (metadata = '@LocalFlags(flags="intermediate")') =>
  annotation('Nested', metadata, alias('LocalFlags', 'flags', 'String[] value() default {"defaulted"}'));
const host = metadata => source('Host', metadata + ' final class Host { private int work() { return 7; } }');

function inspect(target, sources, kind = 'method', name = 'work') {
  const at = target.text.indexOf(kind === 'method' ? name + '(' : name + ' {');
  assert.ok(at >= 0);
  return analyzeSpringDelete({ sources, uri: target.uri, candidate: { kind, name,
    start: kind === 'file' ? 0 : target.text.lastIndexOf('{', at) + 1, end: target.text.length,
    declarationRange: rangeAt(target.text, at, at + name.length) } });
}

test('literal chained aliases retain every written alternative and permit an unrelated helper on the reviewed owner', () => {
  const target = host('@Nested("chosen")');
  const result = inspect(target, [target, flags(), wrapper()]);
  assert.equal(result.verdict, 'allowed');
  const report = result.extensionContracts;
  const conditions = report.conditions.filter(item => item.uri === target.uri);
  assert.equal(conditions.length, 5);
  const names = conditions.flatMap(item => item.queries.map(query => query.name));
  assert.deepEqual(names.sort(), ['base', 'chosen', 'defaulted', 'fallback', 'intermediate'].map(value => 'demo.' + value));
  assert.ok(conditions.every(item => item.composition.chain.join(',') === 'demo.Nested,demo.LocalFlags'));
  assert.ok(conditions.every(item => item.composition.aliases.length === 2 && !item.evaluated && item.allOutcomesRetained));
});

test('fixed composed profiles and SpEL retain both leaves without executing or interpreting registration', () => {
  const target = host('@Marker');
  const marker = annotation('Marker', '@Profile("test") @ConditionalOnExpression("#{true ? true : false}")', '',
    ['org.springframework.context.annotation.Profile', BOOT + 'ConditionalOnExpression']);
  const result = inspect(target, [target, marker]);
  assert.equal(result.verdict, 'allowed');
  const projected = result.extensionContracts.conditions.filter(item => item.uri === target.uri);
  assert.deepEqual(projected.map(item => item.kind), ['profile-expression', 'closed-spel-expression']);
  assert.equal(result.extensionContracts.executedProjectCode, false);
});

test('string-only class and Bean inputs from composed name aliases remain protected', () => {
  const clazz = source('Selected', 'public class Selected {}');
  const bean = source('Factory', 'public class Factory { private String selectedBean() { return "bean"; } }');
  const gate = annotation('ClassGate', '@ConditionalOnClass(name="external.Base")',
    alias('ConditionalOnClass', 'name', 'String[] value()'), [BOOT + 'ConditionalOnClass']);
  const beanGate = annotation('BeanGate', '@ConditionalOnBean(name="baseBean")',
    alias('ConditionalOnBean', 'name', 'String[] value()'), [BOOT + 'ConditionalOnBean']);
  const guarded = source('Guarded', 'class Guarded { @ClassGate("demo.Selected") @BeanGate("selectedBean") void prepare() {} }');
  const sources = [clazz, bean, gate, beanGate, guarded];
  const typeResult = inspect(clazz, sources, 'file', 'Selected');
  assert.equal(typeResult.verdict, 'blocked');
  assert.ok(typeResult.relatedReferences.some(item => item.kind === 'spring.condition-type-reference' && item.uri === guarded.uri));
  const beanResult = inspect(bean, sources, 'method', 'selectedBean');
  assert.equal(beanResult.verdict, 'blocked');
  assert.ok(beanResult.relatedReferences.some(item => item.kind === 'spring.condition-bean-reference' && item.uri === guarded.uri));
});

const unsafe = [
  ['computed use', '@Nested("cho" + "sen")', flags(), wrapper()],
  ['computed default', '@Nested', flags(alias('ConditionalOnBooleanProperty', 'name', 'String[] flags() default {"fall" + "back"}')), wrapper()],
  ['unknown use attribute', '@Nested(other="chosen")', flags(), wrapper()],
  ['invalid comparison type', '@Nested("chosen")', flags(alias('ConditionalOnBooleanProperty', 'name', 'String flags() default "fallback"')), wrapper()],
  ['unresolved intermediate', '@Nested', flags(), wrapper('@LocalFlags(flags=Constants.FLAGS)')],
  ['fake alias identity', '@Nested', flags(), { ...wrapper(), text: wrapper().text.replace(ALIAS, 'fake.AliasFor') }],
  ['non-runtime retention', '@Nested', flags(), { ...wrapper(), text: wrapper().text.replace('RetentionPolicy.RUNTIME', 'RetentionPolicy.CLASS') }],
  ['mixed opaque metadata', '@Nested', flags(), wrapper('@LocalFlags @external.Other')],
  ['overlapping Boolean property aliases', '@Nested', flags(
    alias('ConditionalOnBooleanProperty', 'name', 'String[] flags() default {"fallback"}')
    + alias('ConditionalOnBooleanProperty', 'value', 'String[] alternative() default {"fallback"}')), wrapper()],
  ['non-immediate meta attribute', '@Nested', flags(), annotation('Nested', '@LocalFlags',
    alias('ConditionalOnBooleanProperty', 'name', 'String[] value() default {"fallback"}'), [BOOT + 'ConditionalOnBooleanProperty'])],
  ['absent required source value', '@Nested', flags(alias('ConditionalOnBooleanProperty', 'name', 'String[] flags()')), wrapper('@LocalFlags')]
];
for (const [name, metadata, lower, upper] of unsafe) {
  test('Safe Delete refuses a composed condition with ' + name, () => {
    const target = host(metadata);
    const result = inspect(target, [target, lower, upper]);
    assert.equal(result.verdict, 'unknown');
    assert.ok(result.unknowns.some(item => item.kind === 'spring.composed-condition-unresolved'));
  });
}

test('non-merged Profile alias overrides, cycles and depth overflow remain unresolved', () => {
  const profile = annotation('Marker', '@Profile("test")',
    alias('Profile', 'value', 'String[] value() default {"other"}'), ['org.springframework.context.annotation.Profile']);
  const target = host('@Marker');
  assert.equal(inspect(target, [target, profile]).verdict, 'unknown');
  const a = annotation('A', '@B @Profile("test")', '', ['org.springframework.context.annotation.Profile']);
  const b = annotation('B', '@A');
  const end = source('Endpoint', 'class Endpoint { @A void entry() {} }');
  const plain = host('');
  assert.equal(inspect(plain, [plain, a, b, end]).verdict, 'unknown');
  const chain = Array.from({ length: 5 }, (_, index) => annotation('Chain' + index,
    index === 4 ? '@Profile("test")' : '@Chain' + (index + 1), '',
    index === 4 ? ['org.springframework.context.annotation.Profile'] : []));
  assert.equal(inspect(plain, [plain, ...chain, source('Entry', '@Chain0 class Entry {}')]).verdict, 'unknown');
});

test('reviewed composition cannot suppress an unrelated unknown dynamic lookup or executable SpEL', () => {
  const target = host('@Nested("chosen")');
  const invalid = source('Opaque', 'class Opaque { String callback() { return "#{T(org.example.Dynamic).doWork()}"; } }');
  const result = inspect(target, [target, invalid, flags(), wrapper()]);
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.unknowns.some(item => item.kind === 'spring.dynamic-spel' && item.uri === invalid.uri));
});

test('wildcard imports of a known composed condition fail closed even on an unrelated owner method', () => {
  const target = host('');
  const edge = source('Other', 'class Other { @Nested("chos" + "en") void prepare() {} }', ['demo.*']);
  const foreign = { ...edge, text: edge.text.replace('package demo;', 'package elsewhere;') };
  const result = inspect(target, [target, foreign, flags(), wrapper()]);
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.unknowns.some(item => item.kind === 'spring.composed-condition-unresolved' && item.uri === foreign.uri));
});

test('repeated leaves on separate meta-annotation paths remain unresolved', () => {
  const target = host('@Combined');
  const profile = 'org.springframework.context.annotation.Profile';
  const first = annotation('First', '@Profile("test")', '', [profile]);
  const second = annotation('Second', '@Profile("prod")', '', [profile]);
  const combined = annotation('Combined', '@First @Second');
  const result = inspect(target, [target, first, second, combined]);
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.unknowns.some(item => item.kind === 'spring.composed-condition-unresolved' && item.uri === target.uri));
});

test('nested condition declarations and computed alias consumers cannot bypass Safe Delete', () => {
  const target = source('Selected', 'public class Selected {}');
  const nested = source('Outer',
    'class Outer { @Retention(RetentionPolicy.RUNTIME) @ConditionalOnClass(name="external.Base") public @interface Gate { '
    + alias('ConditionalOnClass', 'name', 'String[] value() default {"external.Default"}') + ' }}',
    [...DECORATORS, ALIAS, BOOT + 'ConditionalOnClass']);
  const use = source('Guarded', 'class Guarded { @Outer.Gate("demo.Sel" + "ected") void prepare() {} }');
  const result = inspect(target, [target, nested, use], 'file', 'Selected');
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.unknowns.some(item => item.kind === 'spring.composed-condition-unresolved' && item.uri === nested.uri));
});

test('nested declarations using top-level composed metadata stay unknown while unrelated markers are left alone', () => {
  const target = host('');
  const nested = source('Outer', 'class Outer { @Nested("enabled") @interface Gate {} }');
  const result = inspect(target, [target, nested, flags(), wrapper()]);
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.unknowns.some(item => item.kind === 'spring.composed-condition-unresolved' && item.uri === nested.uri));
  const marker = source('Outer', 'class Outer { @Retention(RetentionPolicy.RUNTIME) @interface Marker {} }', DECORATORS);
  assert.equal(inspect(target, [target, marker]).verdict, 'allowed');
});

test('actual v27 source fixture reviews all composed uses and preserves dormant and aliased dependencies', () => {
  const root = path.join(FIXTURE_ROOT, 'src/main/java');
  const sources = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile() && item.name.endsWith('.java'))
    .map(item => {
      const file = path.join(item.parentPath, item.name);
      return { uri: pathToFileURL(file).href, text: fs.readFileSync(file, 'utf8') };
    });
  assertConditionReview(analyzeSpringContracts(sources));
});
