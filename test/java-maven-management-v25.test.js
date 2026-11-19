'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mavenBuild, moveClientProof, compileReachable } = require('../src/java/move-builds');

const fixture = path.join(__dirname, 'fixtures/refactoring-v25-maven');
const group = 'org.rocketbrain.fixture.v25';
const core = 'rb25-core', app = 'rb25-app', consumer = 'rb25-consumer';
const moduleNames = [core, app, consumer];
const artifact = name => '<artifactId>' + name + '</artifactId>';

function modifiedFixture(change) {
 const base = path.join('test-output', 'v0.25-maven-contract');
 fs.mkdirSync(base, { recursive: true });
 const root = fs.mkdtempSync(path.join(base, 'case-'));
 for (const module of ['', ...moduleNames]) {
  const output = path.join(root, module, 'pom.xml');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const original = fs.readFileSync(path.join(fixture, module, 'pom.xml'), 'utf8');
  fs.writeFileSync(output, change(module, original));
 }
 return root;
}

test('Maven inherits local raw dependencies and fills missing version and scope from effective management', () => {
 const build = mavenBuild(fixture);
 assert.equal(build.dynamicContracts.scenarioCount, 4);
 assert.deepEqual(build.scenarios.map(s => s.edgeKinds.get(consumer).get(app)),
  ['compile', 'runtime', 'compile', 'compile']);
 assert.deepEqual(build.modelContracts.find(model => model.module === app), {
  module: app, localParent: true, inheritedDependencies: [group + ':' + core],
  managedFields: [{ identity: group + ':' + core, fields: ['version', 'scope'] }]
 });
 assert.deepEqual(build.graph.get(core), []);
 assert.equal(build.edgeKinds.get(app).has(app), false);
 const client = moveClientProof(build, app, core).reviewedClients.find(entry => entry.project === consumer);
 assert.deepEqual(client.sourceExposureByScenario, [true, false, true, true]);
 assert.deepEqual(client.destinationExposureByScenario, [true, true, true, true]);
 assert.deepEqual(client.sourceTestExposureByScenario, [true, true, true, true]);
 assert.deepEqual(client.destinationTestExposureByScenario, [true, true, true, true]);
});

test('child management applies to an inherited dependency and can block a compile client', () => {
 const root = modifiedFixture((module, pom) => module === consumer ?
  pom.replace(artifact(core) + '<version>1.0.0</version><scope>compile</scope>',
   artifact(core) + '<version>1.0.0</version><scope>runtime</scope>') : pom);
 const build = mavenBuild(root);
 assert.equal(build.edgeKinds.get(consumer).get(core), 'runtime');
 assert.equal(build.edgeKinds.get(app).get(core), 'compile');
 assert.throws(() => moveClientProof(build, app, core), /hide the destination from reviewed compile client rb25-consumer/);
});

test('a parent property profile changes inherited management and is included in the finite contract', () => {
 const profile = '<profiles><profile><id>parent-runtime</id><activation><property><name>parent-runtime</name></property></activation>'
  + '<dependencyManagement><dependencies><dependency><groupId>' + group + '</groupId>' + artifact(core)
  + '<version>1.0.0</version><scope>runtime</scope></dependency></dependencies></dependencyManagement></profile></profiles>';
 const root = modifiedFixture((module, pom) => module ? pom : pom.replace('</project>', profile + '</project>'));
 const build = mavenBuild(root);
 assert.equal(build.dynamicContracts.scenarioCount, 8);
 assert.deepEqual(build.dynamicContracts.profiles[0], {
  module: null, id: 'parent-runtime', property: 'parent-runtime', value: undefined
 });
 assert.deepEqual(build.scenarios.map(s => s.edgeKinds.get(app).get(core)),
  ['compile', 'runtime', 'compile', 'runtime', 'compile', 'runtime', 'compile', 'runtime']);
 assert.ok(build.scenarios.every(s => s.edgeKinds.get(consumer).get(core) === 'compile'));
});

test('missing dependency versions require a matching management entry in every scenario', () => {
 const omitted = '<dependency><groupId>' + group + '</groupId>' + artifact(app) + '<version>1.0.0</version><scope>compile</scope></dependency>';
 const root = modifiedFixture((module, pom) => module ? pom : pom.replace(omitted, ''));
 assert.throws(() => mavenBuild(root), /requires a literal version or a matching reviewed management declaration/);
});

test('Maven Move refuses a test-only consumer when an inactive scenario removes its destination', () => {
 const profile = '<profiles><profile><id>core-provided</id><activation><property><name>core-provided</name></property></activation>'
  + '<dependencyManagement><dependencies><dependency><groupId>' + group + '</groupId>' + artifact(core)
  + '<version>1.0.0</version><scope>provided</scope></dependency></dependencies></dependencyManagement></profile></profiles>';
 const root = modifiedFixture((module, pom) => {
  if (module === app) return pom.replace('</project>', profile + '</project>');
  if (module !== consumer) return pom;
  return pom.replace(/<parent>[\s\S]*?<\/parent>/, '<groupId>' + group + '</groupId><version>1.0.0</version>')
   .replace(/<profiles>[\s\S]*?<\/profiles>/, '')
   .replace(artifact(core) + '<version>1.0.0</version><scope>compile</scope>',
    artifact(app) + '<version>1.0.0</version><scope>test</scope>');
 });
 const build = mavenBuild(root);
 assert.equal(compileReachable(build, app, core), true);
 assert.equal(build.scenarios[0].edgeKinds.get(consumer).get(app), 'test');
 assert.equal(build.scenarios[1].edgeKinds.get(app).get(core), 'provided');
 assert.throws(() => moveClientProof(build, app, core), /Maven test client rb25-consumer/);
});

test('imports, mediated transitive scope changes and inherited self-dependencies fail closed', () => {
 const imports = modifiedFixture((module, pom) => module ? pom : pom.replace('<scope>compile</scope>',
  '<type>pom</type><scope>import</scope>'));
 assert.throws(() => mavenBuild(imports), /unreviewed Maven configuration/);
 const mediated = modifiedFixture((module, pom) => module === consumer ? pom
  .replace(/<parent>[\s\S]*?<\/parent>/, '<groupId>' + group + '</groupId><version>1.0.0</version>')
  .replace(artifact(app) + '</dependency>', artifact(app) + '<version>1.0.0</version></dependency>')
  .replace(artifact(core) + '<version>1.0.0</version><scope>compile</scope>',
   artifact(core) + '<version>1.0.0</version><scope>runtime</scope>') : pom);
 assert.throws(() => mavenBuild(mediated), /transitive dependencyManagement changes a reviewed reactor path/);
 const self = modifiedFixture((module, pom) => module === core ? pom
  .replace('<groupId>' + group + '</groupId>',
   '<parent><groupId>' + group + '</groupId>' + artifact('rb25-reactor') + '<version>1.0.0</version></parent>') : pom);
 assert.throws(() => mavenBuild(self), /depend on itself/);
});
