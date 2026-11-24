'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { javaFacts, analyzeDependencyGraph, parseJdeps } = require('../src/java/dependency-graph');
const { buildDescriptors, gradleDependencies, fileKey } = require('../src/java/dependency-builds');
const { observeBytecode } = require('../src/java/dependency-workspace');

const fixture = path.join(path.parse(process.cwd()).root, 'rocketbrain-dependency-fixture');
const row = (file, text) => ({ path: path.join(fixture, file), uri: pathToFileURL(path.join(fixture, file)).href, text });
const java = (file, text, project = 'spring', sourceSet = 'main') => ({
  ...row(file, text), projectId: project, projectLabel: project, sourceSet
});
const getLayer = (report, name) => report.layers.find(layer => layer.name === name);
const graphLabels = (layer, component) => {
  const nodes = new Map(layer.nodes.map(node => [node.id, node.label]));
  return component.members.map(id => nodes.get(id)).sort();
};

test('JPMS and Java source imports retain independent cycles and clickable declaration ranges', () => {
  const first = java('a/src/main/java/module-info.java', 'module foo.a {\n requires static transitive foo.b;\n uses foo.a.Hook;\n}', 'a');
  const second = java('b/src/main/java/module-info.java', 'open module foo.b {\n requires foo.a;\n}', 'b');
  const a = java('src/main/java/a/A.java', 'package a;\nimport static b.B.X;\n// import c.NotAReference;\nclass A{String s="import z.No;";}');
  const b = java('src/main/java/b/B.java', 'package b;\nimport a.A;\nclass B {}');
  const testA = java('src/test/java/a/ATest.java', 'package a; import b.B; class ATest {}', 'spring', 'test');
  const fact = javaFacts(first);
  assert.equal(fact.module.name, 'foo.a');
  assert.deepEqual(fact.module.requires[0].modifiers, ['static', 'transitive']);
  assert.deepEqual(javaFacts(a).imports.map(item => item.target), ['b.B.X']);
  const report = analyzeDependencyGraph({ files: [first, second, a, b, testA] });
  const jpms = getLayer(report, 'JPMS requires');
  const imports = getLayer(report, 'Declared package imports');
  assert.deepEqual(graphLabels(jpms, jpms.cycles[0]), ['foo.a', 'foo.b']);
  assert.deepEqual(jpms.cycles[0].witness.map(edge => edge.evidence.kind), ['requires static transitive', 'requires']);
  assert.deepEqual(graphLabels(imports, imports.cycles[0]), ['a', 'b']);
  assert.equal(imports.cycles[0].members.some(id => JSON.parse(id)[1] === 'test'), false);
  assert.equal(imports.cycles[0].witness[0].evidence.range.start.line, 1);
  assert.equal(imports.nodes.filter(item => item.label === 'a').length, 2);
  assert.equal(imports.edges.length, 3);
});

test('Maven and Gradle source-only descriptors report real scope, preserve independent cycles and omit computed routes', () => {
  const rootPom = row('maven/pom.xml', '<project xmlns="http://maven.apache.org/POM/4.0.0"><artifactId>root</artifactId><modules><module>a</module><module>b</module></modules></project>');
  const pom = (name, sibling) => row('maven/' + name + '/pom.xml',
    '<project xmlns="http://maven.apache.org/POM/4.0.0"><groupId>probe</groupId><artifactId>' + name + '</artifactId><version>1</version>\n'
    + '<dependencies><dependency><groupId>probe</groupId><artifactId>' + sibling + '</artifactId><version>1</version><scope>compile</scope></dependency></dependencies>'
    + '<profiles><profile><dependencies><dependency><artifactId>unchecked</artifactId></dependency></dependencies></profile></profiles></project>');
  const gradleRoot = row('gradle/settings.gradle.kts', 'rootProject.name = "fixture"\ninclude(":left", ":right")');
  const left = row('gradle/left/build.gradle.kts', 'dependencies {\n api(project(":right"))\n}');
  const right = row('gradle/right/build.gradle', 'dependencies {\n runtimeOnly project(path: \':left\')\n}');
  const computed = row('gradle/computed.gradle', 'dependencies {\nif (flag)\n  implementation project(\':right\')\n}');
  const model = buildDescriptors([rootPom, pom('a', 'b'), pom('b', 'a'), gradleRoot, left, right]);
  assert.equal(gradleDependencies(computed).dependencies.length, 0);
  assert.match(gradleDependencies(computed).limitation, /Computed Gradle/);
  assert.deepEqual(model.links.map(link => link.kind), ['Maven compile', 'Maven compile', 'Gradle api', 'Gradle runtimeOnly']);
  assert.ok(model.links.every(link => link.range.start.line === 1 && link.range.end.character > link.range.start.character));
  assert.equal(model.issues.filter(issue => /Profile-specific/.test(issue.message)).length, 2);
  const projects = model.descriptors.map(item => ({ ...item, id: item.root, label: path.basename(item.root) }));
  const buildEdges = model.links.map(({ fromRoot: from, toRoot: to, ...evidence }) => ({ from, to, evidence }));
  const result = analyzeDependencyGraph({ files: [], projects, buildEdges });
  assert.deepEqual(graphLabels(getLayer(result, 'Maven reactor modules'), getLayer(result, 'Maven reactor modules').cycles[0]), ['a', 'b']);
  assert.deepEqual(graphLabels(getLayer(result, 'Gradle project modules'), getLayer(result, 'Gradle project modules').cycles[0]), ['left', 'right']);
});

test('compiled edges represent known local classes and exclude unresolved and ambiguous targets', () => {
  const files = [
    java('src/main/java/a/A.java', 'package a; public class A {}'),
    java('src/main/java/b/B.java', 'package b; public class B {}')
  ];
  const output = 'main -> not found\r\n   a.A$Inner -> b.B main\r\n   b.B -> a.A main\r\n   b.B -> external.X not found\r\n';
  const references = parseJdeps(output).map(item => ({ ...item, projectId: 'spring', sourceSet: 'main' }));
  const report = analyzeDependencyGraph({ files, bytecode: references });
  const bytes = getLayer(report, 'Compiled package references');
  assert.deepEqual(graphLabels(bytes, bytes.cycles[0]), ['a', 'b']);
  assert.equal(bytes.edges[0].evidence[0].symbol, 'a.A$Inner → b.B');
  assert.deepEqual(getLayer(report, 'Declared package imports').edges, []);
  const duplicate = java('other/src/main/java/b/B.java', 'package b; public class B {}', 'other');
  const uncertain = analyzeDependencyGraph({ files: [...files, duplicate], bytecode: references });
  assert.equal(getLayer(uncertain, 'Compiled package references').cycles.length, 0);
  assert.equal(uncertain.unavailableCompiledReferences, 2);
});

test('independent JDK observes a genuine fully qualified package cycle from compiled classes',
  { skip: !process.env.ROCKETBRAIN_JAVA_TEST_CONFIG && 'Independent Java test runtime is not configured.' }, async t => {
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
    const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-jdeps-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const output = path.join(temporary, 'build', 'classes', 'java', 'main');
    await fs.mkdir(output, { recursive: true });
    const projectId = fileKey(temporary);
    const inputs = [
      ['Left.java', 'package first; public class Left { public second.Right peer; }'],
      ['Right.java', 'package second; public class Right { public first.Left peer; }']
    ];
    await Promise.all(inputs.map(([name, source]) => fs.writeFile(path.join(temporary, name), source)));
    const javac = path.join(runtime.javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
    await execFile(javac, ['-encoding', 'UTF-8', '-d', output, ...inputs.map(([name]) => path.join(temporary, name))],
      { cwd: temporary, windowsHide: true, timeout: 20000 });
    const { outputs, bytecode } = await observeBytecode([{ id: projectId, root: temporary }], runtime.javaHome);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].sourceSet, 'main');
    const files = inputs.map(([name, source]) => java(name, source, projectId));
    const report = analyzeDependencyGraph({ files, bytecode });
    const compiled = getLayer(report, 'Compiled package references');
    assert.deepEqual(graphLabels(compiled, compiled.cycles[0]), ['first', 'second']);
    assert.equal(compiled.cycles[0].witness.length, 2);
  });

test('independent JDK resolves package dependencies across two observed local JPMS outputs',
  { skip: !process.env.ROCKETBRAIN_JAVA_TEST_CONFIG && 'Independent Java test runtime is not configured.' }, async t => {
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
    const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-named-jdeps-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const javac = path.join(runtime.javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
    const inputs = [
      { name: 'beta', descriptor: 'module fixture.beta { exports beta; }', type: 'Beta', text: 'package beta; public class Beta {}' },
      { name: 'alpha', descriptor: 'module fixture.alpha { requires fixture.beta; }', type: 'Alpha',
        text: 'package alpha; public class Alpha { public beta.Beta use; }' }
    ];
    const projects = [], files = [];
    let modulePath;
    for (const input of inputs) {
      const root = path.join(temporary, input.name), output = path.join(root, 'target', 'classes');
      const id = fileKey(root);
      await fs.mkdir(output, { recursive: true });
      const sourceNames = [['module-info.java', input.descriptor], [input.type + '.java', input.text]];
      for (const [file, text] of sourceNames) {
        await fs.writeFile(path.join(root, file), text);
        files.push(java(path.join(input.name, file), text, id));
      }
      await execFile(javac, ['-encoding', 'UTF-8', '-d', output, ...(modulePath ? ['--module-path', modulePath] : []),
        ...sourceNames.map(([file]) => path.join(root, file))], { cwd: root, windowsHide: true, timeout: 20000 });
      projects.push({ id, root });
      modulePath = output;
    }
    const observed = await observeBytecode(projects, runtime.javaHome);
    assert.equal(observed.outputs.length, 2, JSON.stringify(observed.issues));
    assert.ok(observed.outputs.every(output => output.named));
    const report = analyzeDependencyGraph({ files, bytecode: observed.bytecode });
    const compiled = getLayer(report, 'Compiled package references');
    assert.equal(compiled.edges[0]?.evidence[0]?.symbol, 'alpha.Alpha → beta.Beta');
    assert.equal(getLayer(report, 'JPMS requires').edges[0]?.evidence[0]?.symbol, 'fixture.beta');
  });
