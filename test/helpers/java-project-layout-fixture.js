'use strict';

const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');

async function write(root, name, text) {
  const file = path.join(root, ...name.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { flag: 'wx' });
}

const pom = source => `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>${source}</project>\n`;
const uri = file => pathToFileURL(file).href;

async function createProjectLayout(parent) {
  const directory = await fs.mkdtemp(path.join(parent, 'rb-project-layout-'));
  const id = randomBytes(5).toString('hex');
  const marker = path.join(directory, 'owner.json');
  await fs.writeFile(marker, JSON.stringify({ kind: 'RocketbrainProjectLayoutFixture-v1', id }), { flag: 'wx' });
  const maven = path.join(directory, 'maven'), gradle = path.join(directory, 'gradle');
  const mavenLib = path.join(maven, 'layout-core'), mavenApp = path.join(maven, 'layout-service');
  const gradleApp = path.join(gradle, 'layout-gradle-app'), gradleLib = path.join(gradle, 'layout-gradle-lib');
  const group = `rb.layout.${id}`;
  const coordinate = `<groupId>${group}</groupId><artifactId>layout-parent</artifactId><version>1</version>`;
  await write(maven, 'pom.xml', pom(`${coordinate}<packaging>pom</packaging><modules><module>layout-core</module><module>layout-service</module></modules>` +
    '<properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>' +
    '<build><pluginManagement><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.14.1</version></plugin></plugins></pluginManagement></build>'));
  await write(mavenLib, 'pom.xml', pom(`<parent>${coordinate}</parent><artifactId>layout-core</artifactId>`));
  await write(mavenApp, 'pom.xml', pom(`<parent>${coordinate}</parent><artifactId>layout-service</artifactId>` +
    `<dependencies><dependency><groupId>${group}</groupId><artifactId>layout-core</artifactId><version>1</version></dependency></dependencies>`));
  await write(mavenLib, 'src/main/java/fixture/layout/MavenLibrary.java', 'package fixture.layout; public class MavenLibrary { public static int value() { return 7; } }\n');
  await write(mavenApp, 'src/main/java/fixture/layout/MavenService.java', 'package fixture.layout; public class MavenService { public static int value() { return MavenLibrary.value(); } }\n');
  await write(mavenApp, 'src/test/java/fixture/layout/MavenServiceProbe.java', 'package fixture.layout; public class MavenServiceProbe { int value = MavenService.value(); }\n');

  await write(gradle, 'settings.gradle', "rootProject.name='layout-gradle'\ninclude('layout-gradle-app')\nincludeBuild('layout-gradle-lib')\n");
  await write(gradle, 'build.gradle', "plugins { id 'eclipse' }\n");
  await write(gradleLib, 'settings.gradle', "rootProject.name='layout-gradle-lib'\n");
  await write(gradleLib, 'build.gradle', `plugins { id 'java-library'; id 'eclipse' }\ngroup='${group}'\nversion='1'\n`);
  await write(gradleApp, 'build.gradle', "plugins { id 'java'; id 'eclipse' }\n" +
    `dependencies { implementation '${group}:layout-gradle-lib:1' }\n` +
    "sourceSets.main.java.srcDir('build/generated/sources/layout/java/main')\n");
  await write(gradleLib, 'src/main/java/fixture/layout/GradleLibrary.java', 'package fixture.layout; public class GradleLibrary { public static int value() { return 11; } }\n');
  await write(gradleApp, 'src/main/java/fixture/layout/GradleService.java', 'package fixture.layout; public class GradleService { public static int value() { return GeneratedLayout.value() + GradleLibrary.value(); } }\n');
  await write(gradleApp, 'src/test/java/fixture/layout/GradleServiceProbe.java', 'package fixture.layout; public class GradleServiceProbe { int value = GradleService.value(); }\n');
  await write(gradleApp, 'build/generated/sources/layout/java/main/fixture/layout/GeneratedLayout.java', 'package fixture.layout; public class GeneratedLayout { public static int value() { return 3; } }\n');
  return { directory, id, marker, maven, gradle, mavenLib, mavenApp, gradleLib, gradleApp,
    configUris: [path.join(maven, 'pom.xml'), path.join(gradle, 'settings.gradle')].map(uri),
    projectUris: [mavenLib, mavenApp, gradleLib, gradleApp].map(uri) };
}

async function compileProjectLayout(fixture, tools) {
  const specs = [buildSpec({ tool: 'maven', name: 'Maven reactor', root: fixture.maven }, tools, ['--offline', 'test-compile']),
    buildSpec({ tool: 'gradle', name: 'Gradle composite', root: fixture.gradle }, tools, ['--offline', ':layout-gradle-app:testClasses'])];
  for (const spec of specs) {
    const result = await execute(spec.command, spec.args, { cwd: spec.cwd, env: { ...spec.env,
      GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.resolve(__dirname, '../../test-output/java-gradle-user-home') }, timeoutMs: 175000 });
    if (result.code !== 0) throw Error(`${spec.label} failed: ${result.output}`);
  }
  const expected = [
    [fixture.mavenLib, 'target/classes/fixture/layout/MavenLibrary.class'],
    [fixture.mavenApp, 'target/classes/fixture/layout/MavenService.class'],
    [fixture.mavenApp, 'target/test-classes/fixture/layout/MavenServiceProbe.class'],
    [fixture.gradleLib, 'build/classes/java/main/fixture/layout/GradleLibrary.class'],
    [fixture.gradleApp, 'build/classes/java/main/fixture/layout/GeneratedLayout.class'],
    [fixture.gradleApp, 'build/classes/java/test/fixture/layout/GradleServiceProbe.class']
  ];
  for (const [base, name] of expected) {
    const bytes = await fs.readFile(path.join(base, name));
    if (bytes.readUInt32BE() !== 0xcafebabe) throw Error('The expected build output is not a Java classfile.');
  }
  return expected.length;
}

async function removeProjectLayout(fixture, parent) {
  const marker = JSON.parse(await fs.readFile(fixture.marker, 'utf8'));
  const folder = await fs.realpath(fixture.directory);
  if (marker.kind !== 'RocketbrainProjectLayoutFixture-v1' || marker.id !== fixture.id ||
      path.dirname(folder) !== await fs.realpath(parent)) throw Error('The disposable project layout fixture identity changed.');
  await fs.rm(folder, { recursive: true });
}

function checkLayout(layout, fixture) {
  const model = name => layout.projects.find(project => path.relative(project.root, fixture[name]) === '');
  const maven = model('mavenApp'), mavenLib = model('mavenLib'), gradle = model('gradleApp'), gradleLib = model('gradleLib');
  assert.ok(maven && mavenLib && gradle && gradleLib, JSON.stringify(layout.projects.map(project => project.name)));
  for (const project of [maven, gradle]) {
    const scopes = new Set(project.sourceRoots.map(item => item.scope));
    assert.ok(scopes.has('test') && scopes.has('main'));
    assert.ok(project.outputRoots.some(output => output.scopes.includes('test')), `${project.name} did not label a test build output`);
  }
  const generated = gradle.sourceRoots.find(item => item.generated && item.packages.some(pkg => pkg.files.some(file => file.name === 'GeneratedLayout.java')));
  assert.ok(generated);
  const mavenEdge = maven.libraries.find(item => item.projectDependency?.id === mavenLib.id);
  const gradleEdge = gradle.libraries.find(item => item.projectDependency?.id === gradleLib.id);
  return { maven, gradle, mavenEdge, gradleEdge, generated };
}

module.exports = { createProjectLayout, compileProjectLayout, removeProjectLayout, checkLayout };
