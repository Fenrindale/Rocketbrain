'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixtureModel, filesUnder, root } = require('./spring-fixture');
const { analyzeSpring, definitionsAt, profileExpression } = require('../src/spring/model');
const { parseJavaFile } = require('../src/spring/java');
const { parseProperties, parseYaml, configuration, resolveTemplate } = require('../src/spring/configuration');

function selected(model, name, owner = 'fixtures.valid.Consumer') { const injection = model.injections.find(item => item.owner === owner && item.name === name); assert.ok(injection, `Injection ${owner}.${name}`); return { injection, beans: (injection.resolution.selected || []).map(id => model.beans.find(bean => bean.id === id)) }; }

test('Spring model resolves source interface types, Qualifier, Primary and collection candidates', () => {
  const model = fixtureModel();
  assert.equal(selected(model, 'blue').beans[0]?.name, 'bluePort');
  assert.equal(selected(model, 'preferred').beans[0]?.name, 'redPort');
  assert.deepEqual(selected(model, 'all').beans.map(bean => bean.name).sort(), ['aliasPort', 'bluePort', 'redPort']);
  assert.equal(model.diagnostics.length, 0);
  assert.deepEqual(model.beans.find(bean => bean.name === 'aliasPort').aliases, ['aliasPort', 'aliasedPort']);
});

test('Spring profile expressions and class conditions propagate to Bean methods and constructor injection', () => {
  const prod = fixtureModel('prod'), dev = fixtureModel('dev');
  assert.equal(prod.beans.find(bean => bean.name === 'devPort').state, 'inactive');
  assert.equal(dev.beans.find(bean => bean.name === 'redPort').state, 'inactive');
  assert.equal(selected(dev, 'dependency', 'fixtures.valid.DevConsumer').beans[0]?.name, 'bluePort');
  assert.equal(selected(dev, 'preferred').injection.resolution.state, 'inactive');
  assert.equal(profileExpression('dev & (!prod | qa)', ['dev']).state, 'active');
  assert.equal(profileExpression('dev & prod | qa', ['dev']).state, 'unknown');
});

test('ConditionalOnProperty is evaluated but custom Conditions remain unknown without false missing diagnostics', () => {
  const prod = fixtureModel('prod'), dev = fixtureModel('dev');
  assert.equal(prod.beans.find(bean => bean.name === 'feature').state, 'active');
  assert.equal(dev.beans.find(bean => bean.name === 'feature').state, 'inactive');
  assert.equal(prod.beans.find(bean => bean.name === 'unknownThing').state, 'unknown');
  assert.equal(selected(prod, 'optionalUnknown').injection.resolution.state, 'unknown');
  assert.equal(prod.diagnostics.some(item => item.code === 'spring.bean.missing'), false);
});

test('@Value resolves nested placeholders, defaults and profile configuration; definitions point across files', () => {
  const model = fixtureModel(); const value = selected(model, 'greeting').injection;
  assert.equal(value.resolution.value, 'Hello Production');
  assert.ok(value.resolution.definitions.some(item => item.key === 'app.person' && item.uri.endsWith('application-prod.properties')));
  assert.ok(definitionsAt(model, value.uri, value.valueRange.start).some(item => item.uri.endsWith('application.properties')));
  const bean = selected(model, 'blue').injection;
  assert.ok(definitionsAt(model, bean.uri, bean.range.start).some(item => item.uri.endsWith('/BluePort.java')));
  assert.equal(resolveTemplate('${missing:${fallback:yes}}', new Map()).value, 'yes');
  assert.equal(resolveTemplate('#{T(java.lang.Math).random()}', new Map()).state, 'unknown');
  assert.equal(resolveTemplate('${a}', new Map([['a', { value: '${b}' }], ['b', { value: '${a}' }]])).state, 'unknown');
  const binding = model.bindings.find(item => item.owner === 'fixtures.valid.Settings' && item.name === 'person');
  assert.equal(binding.resolution.value, 'Production');
  assert.ok(definitionsAt(model, binding.uri, binding.range.start).some(item => item.uri.endsWith('application-prod.properties')));
});

test('ambiguous Beans produce contextual diagnostics; missing only asserted in explicitly closed model', () => {
  const java = filesUnder(path.join(root, 'src'), /\.java$/);
  const ambiguous = analyzeSpring(java.filter(file => !file.uri.endsWith('/MissingConsumer.java')), [], { basePackages: ['fixtures.invalid'], closedWorld: true });
  assert.ok(ambiguous.diagnostics.some(item => item.code === 'spring.bean.ambiguous'));
  const missingFiles = java.filter(file => file.uri.endsWith('/MissingConsumer.java'));
  const open = analyzeSpring(missingFiles, [], {}), closed = analyzeSpring(missingFiles, [], { closedWorld: true });
  assert.equal(open.injections[0].resolution.state, 'unknown');
  assert.equal(open.diagnostics.length, 0);
  assert.equal(closed.injections[0].resolution.state, 'missing');
});

test('Java syntax parsing ignores fake annotations in strings/comments/text blocks and uses imported annotation identity', () => {
  const source = 'package demo; import org.springframework.stereotype.Component; /* @Component class Fake {} */ @Component class Real { String text = "@Autowired Port fake;"; String doc = """\n@Bean Port fake() {}\n"""; }';
  const file = parseJavaFile({ uri: 'file:///Real.java', text: source });
  assert.deepEqual(file.types.map(type => type.name), ['Real']);
  assert.equal(analyzeSpring([{ uri: file.uri, text: source }]).beans.length, 1);
  const impostor = 'package demo; import other.Component; @Component class NotSpring {}';
  assert.equal(analyzeSpring([{ uri: 'file:///No.java', text: impostor }]).beans.length, 0);
});

test('configuration supports escaped .properties and YAML scalars and arrays', () => {
  const parsed = parseProperties({ uri: 'file:///application.properties', text: 'escaped\\.key=hello\\nworld\ncontinued=first\\\n  second\n' });
  assert.equal(parsed.entries[0].value, 'hello\nworld'); assert.equal(parsed.entries[1].value, 'firstsecond');
  const yaml = parseYaml({ uri: 'file:///application.yml', text: 'app:\n  title: "Rocketbrain"\n  enabled: false\n  complex: [one, two]\n' });
  assert.deepEqual(yaml.entries.map(item => item.key), ['app.title', 'app.enabled','app.complex[0]','app.complex[1]']); assert.deepEqual(yaml.issues,[]);
  const config = configuration([{ uri: 'file:///application.properties', text: 'app.value=base\n' }, { uri: 'file:///application-dev.properties', text: 'app.value=dev\n' }], { activeProfiles: ['dev'], properties: { 'app.value': 'override' } });
  assert.equal(config.entries.get('app.value').value, 'override');
});

test('opaque conditions, meta annotations and incomplete configuration do not become false missing findings', () => {
  const files = [
    { uri: 'file:///Port.java', text: 'package demo; public interface Port {}' },
    { uri: 'file:///Impl.java', text: 'package demo; import org.springframework.stereotype.Component; import custom.Dynamic; @Component @Dynamic class Impl implements Port {}' },
    { uri: 'file:///Client.java', text: 'package demo; import org.springframework.stereotype.Component; import org.springframework.beans.factory.annotation.Autowired; @Component class Client { @Autowired Port port; }' }
  ];
  const custom = analyzeSpring(files, [], { closedWorld: true });
  assert.equal(custom.beans.find(bean => bean.name === 'impl').state, 'unknown');
  assert.equal(custom.injections[0].resolution.state, 'unknown');
  assert.equal(custom.diagnostics.length, 0); assert.equal(custom.closedWorld, false);
  const conditional = [{ uri: 'file:///Feature.java', text: 'package demo; import org.springframework.stereotype.Component; import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty; @Component @ConditionalOnProperty(name="flag") class Feature {}' }];
  const partial = analyzeSpring(conditional, [{ uri: 'file:///application.yml', text: 'flag: true\nspring.config.import: optional:file:unobserved.yml\n' }], { closedWorld: true });
  assert.equal(partial.beans[0].state, 'unknown'); assert.equal(partial.closedWorld, false);
});

test('separate application configuration contexts do not silently decide values or property conditions', () => {
  const contexts = [{ uri: 'file:///project-a/application.properties', text: 'flag=true\napp.name=alpha\n' }, { uri: 'file:///project-b/application.properties', text: 'flag=false\napp.name=beta\n' }];
  const config = configuration(contexts, {});
  assert.equal(resolveTemplate('${app.name}', config.entries).state, 'unknown');
  const source = [{ uri: 'file:///Feature.java', text: 'package demo; import org.springframework.stereotype.Component; import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty; @Component @ConditionalOnProperty(name="flag") class Feature {}' }];
  const model = analyzeSpring(source, contexts, { closedWorld: true });
  assert.equal(model.beans[0].state, 'unknown'); assert.equal(model.closedWorld, false);
  const bounded = analyzeSpring(source, contexts.slice(0, 1), { closedWorld: true });
  assert.equal(bounded.beans[0].state, 'active');
});

test('unsupported Java outside selected Spring packages does not poison a bounded local model', () => {
  const selected = { uri: 'file:///Client.java', text: 'package selected; import org.springframework.stereotype.Component; import org.springframework.beans.factory.annotation.Autowired; @Component class Client { @Autowired Missing dependency; }' };
  const unrelated = { uri: 'file:///Other.java', text: 'package outside; public record Other(String name) {}' };
  const model = analyzeSpring([selected, unrelated], [], { basePackages: ['selected'], closedWorld: true });
  assert.equal(model.closedWorld, true); assert.ok(model.diagnostics.some(item => item.code === 'spring.bean.missing'));
  assert.equal(model.issues.some(item => item.uri === unrelated.uri), false);
});

