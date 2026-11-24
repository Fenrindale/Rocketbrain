'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { mavenBuild, compileReachable, moveClientProof } = require('../src/java/move-builds');

const group = 'org.rocketbrain.fixture.v26.profile-context';
const coordinates = artifact => '<groupId>' + group + '</groupId><artifactId>' + artifact + '</artifactId>';
const version = '<version>1</version>';
const dep = (artifact, details = '') => '<dependency>' + coordinates(artifact) + details + '</dependency>';
const scoped = (artifact, scope) => dep(artifact, version + '<scope>' + scope + '</scope>');
const dependencies = (...entries) => '<dependencies>' + entries.join('') + '</dependencies>';
const managed = (...entries) => '<dependencyManagement>' + dependencies(...entries) + '</dependencyManagement>';
const pom = (artifact, model) => '<project><modelVersion>4.0.0</modelVersion>' + coordinates(artifact) + version + model + '</project>';

function profileContextFixture() {
 const output = path.join('test-output', 'v0.26-maven-bom-profile-context');
 fs.mkdirSync(output, { recursive: true });
 const reactor = fs.mkdtempSync(path.join(output, 'case-'));
 const parent = '<parent>' + coordinates('shared-meta') + version +
  '<relativePath>../shared-meta/pom.xml</relativePath></parent>';
 const bom = dep('shared-meta', version + '<type>pom</type><scope>import</scope>');
 const profile = '<profiles><profile><id>flip</id><activation><property><name>flip</name></property></activation>' +
  managed(scoped('relay-left', 'provided'), scoped('relay-right', 'compile')) + '</profile></profiles>';
 const models = new Map([
  ['source', dependencies(scoped('target', 'provided'))],
  ['target', ''],
  ['relay-left', dependencies(scoped('target', 'compile'))],
  ['relay-right', dependencies(scoped('target', 'compile'))],
  ['left', parent + dependencies(dep('relay-left'))],
  ['right', managed(bom) + dependencies(dep('relay-right'))],
  ['consumer', dependencies(scoped('source', 'compile'), scoped('left', 'compile'), scoped('right', 'compile'))],
  ['shared-meta', '<packaging>pom</packaging>' + managed(scoped('relay-left', 'compile'), scoped('relay-right', 'provided')) + profile]
 ]);
 const modules = [...models.keys()].map(artifact => '<module>' + artifact + '</module>');
 fs.writeFileSync(path.join(reactor, 'pom.xml'),
  pom('reactor', '<packaging>pom</packaging><modules>' + modules.join('') + '</modules>'));
 for (const [artifact, model] of models) {
  const folder = path.join(reactor, artifact);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'pom.xml'), pom(artifact, model));
 }
 return reactor;
}

test('Maven Move guards mixed parent and BOM profile activation contexts', () => {
 const build = mavenBuild(profileContextFixture());
 const scopes = scenario => [scenario.edgeKinds.get('left').get('relay-left'), scenario.edgeKinds.get('right').get('relay-right')];
 const baseline = build.scenarios.find(scenario => scopes(scenario).join(',') === 'compile,provided');
 const bothActive = build.scenarios.find(scenario => scopes(scenario).join(',') === 'provided,compile');
 // Maven 3.9.11 passes explicit -P to parent inheritance but does not copy it
 // to its fallback BOM import request, so neither relay need expose the target.
 const mixed = build.scenarios.find(scenario => scopes(scenario).join(',') === 'provided,provided');
 assert.ok(baseline && bothActive && mixed);
 assert.equal(compileReachable(baseline, 'consumer', 'target'), true);
 assert.equal(compileReachable(bothActive, 'consumer', 'target'), true);
 assert.equal(compileReachable(mixed, 'consumer', 'source'), true);
 assert.equal(compileReachable(mixed, 'consumer', 'target'), false);
 assert.throws(() => moveClientProof(build, 'source', 'target'), /hide the destination from reviewed compile client consumer/i);
});
