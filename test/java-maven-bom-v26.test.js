'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mavenBuild, compileReachable, moveClientProof } = require('../src/java/move-builds');

const fixture = path.join(__dirname, 'fixtures/refactoring-v26-maven');
const app = 'rb26-app', core = 'rb26-core', consumer = 'rb26-consumer';
const company = 'rb26-company-parent', projectParent = 'rb26-project-parent';
const baseBom = 'rb26-base-bom', libraryBom = 'rb26-library-bom', conflictBom = 'rb26-conflict-bom';
const group = 'org.rocketbrain.fixture.v26';
const gav = artifact => '<groupId>' + group + '</groupId><artifactId>' + artifact + '</artifactId><version>1.0.0</version>';
const imported = artifact => '<dependency>' + gav(artifact) + '<type>pom</type><scope>import</scope></dependency>';

function modifiedFixture(change) {
 const base = path.join('test-output', 'v0.26-maven-contract');
 fs.mkdirSync(base, { recursive: true });
 const root = fs.mkdtempSync(path.join(base, 'case-'));
 for (const module of ['', app, core, consumer, company, projectParent, baseBom, libraryBom, conflictBom]) {
  const target = path.join(root, module, 'pom.xml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = fs.readFileSync(path.join(fixture, module, 'pom.xml'), 'utf8');
  fs.writeFileSync(target, change(module, original));
 }
 return root;
}

test('Maven reviews a three-link local parent chain and a nested BOM without treating metadata POMs as Java projects', () => {
 const build = mavenBuild(fixture);
 assert.equal(build.files.length, 9);
 assert.deepEqual([...build.roots.keys()], [core, app, consumer]);
 assert.equal(build.dynamicContracts.scenarioCount, 4);
 const appProof = build.modelContracts.find(record => record.module === app);
 assert.deepEqual(appProof.parentChain, [projectParent, 'rb26-reactor', company]);
 assert.deepEqual(appProof.bomImports.map(record => record.module), [baseBom, conflictBom]);
 assert.equal(appProof.bomImportDepth, 2);
 assert.deepEqual(appProof.inheritedDependencies, [group + ':' + core]);
 assert.ok(build.scenarios.every(scenario => scenario.edgeKinds.get(app).get(core) === 'compile'));
 assert.deepEqual(build.scenarios.map(scenario => scenario.edgeKinds.get(consumer).get(app)),
  ['compile', 'runtime', 'compile', 'compile']);
 const client = moveClientProof(build, app, core).reviewedClients.find(entry => entry.project === consumer);
 assert.deepEqual(client.destinationTestExposureByScenario, [true, true, true, true]);
});

test('first BOM wins among imports, while direct management and child import ordering take precedence', () => {
 const reversed = modifiedFixture((module, pom) => module === company ? pom
  .replace(imported(baseBom), imported(conflictBom))
  .replace(new RegExp(imported(conflictBom) + '(?=\\s*</dependencies>)'), imported(baseBom)) : pom);
 const model = mavenBuild(reversed);
 assert.equal(model.edgeKinds.get(app).get(core), 'provided');
 // Consumer management is declared directly and still wins over both imports.
 assert.equal(model.edgeKinds.get(consumer).get(core), 'compile');
 const child = modifiedFixture((module, pom) => module === app ? pom.replace('</project>',
  '<dependencyManagement><dependencies>' + imported(conflictBom) + '</dependencies></dependencyManagement></project>') : pom);
 assert.equal(mavenBuild(child).edgeKinds.get(app).get(core), 'provided');
 const scope = modifiedFixture((module, pom) => module === app ? pom.replace('</project>',
  '<dependencyManagement><dependencies><dependency>' + gav(core) + '<scope>test</scope></dependency></dependencies></dependencyManagement></project>') : pom);
 assert.equal(compileReachable(mavenBuild(scope), app, core), false);
});

test('unknown, wrong-version, type-mismatched, and recursive BOM imports fail closed', () => {
 for (const changed of [
  imported('external-bom'),
  imported(baseBom).replace('1.0.0', '2.0.0'),
  imported(core)
 ]) {
  const root = modifiedFixture((module, pom) => module === company ? pom.replace(imported(baseBom), changed) : pom);
  assert.throws(() => mavenBuild(root), /BOM outside the exact local reactor/);
 }
 const cycle = modifiedFixture((module, pom) => module === libraryBom ?
  pom.replace('</dependencies>', imported(baseBom) + '</dependencies>') : pom);
 assert.throws(() => mavenBuild(cycle), /Cyclic Maven BOM imports/);
});

test('local parent paths must resolve the exact sibling POM, and parent chains must be acyclic', () => {
 const external = modifiedFixture((module, pom) => module === app ? pom
  .replace('../rb26-project-parent/pom.xml', '../../rb26-project-parent/pom.xml') : pom);
 assert.throws(() => mavenBuild(external), /external Maven parent/);
 const mismatch = modifiedFixture((module, pom) => module === app ? pom
  .replace('../rb26-project-parent/pom.xml', '../rb26-company-parent/pom.xml') : pom);
 assert.throws(() => mavenBuild(mismatch), /external Maven parent/);
 const cycle = modifiedFixture((module, pom) => module === company ? pom.replace('<packaging>pom</packaging>',
  '<parent>' + gav(projectParent) + '<relativePath>../' + projectParent + '/pom.xml</relativePath></parent><packaging>pom</packaging>') : pom);
 assert.throws(() => mavenBuild(cycle), /Cyclic Maven parent/);
});
