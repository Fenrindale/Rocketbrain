'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { captureRestartInputs } = require('../src/java/micronaut-restart');
const { removeFixture } = require('./helpers/micronaut-debug-fixture');

async function fixture(t, tool = 'maven') {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'rb-micronaut-debug-'));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(() => removeFixture(root, parent, identity));
  await fs.cp(path.join(__dirname, 'fixtures/java', tool==='gradle'?'micronaut-gradle':'micronaut'), root, { recursive: true });
  return { root, uri: pathToFileURL(root).href, tool };
}

test('Micronaut restart binds conventional source, binary resources and physical repository config', async t => {
  const project = await fixture(t);
  const { root } = project;
  const target = path.join(root, 'target');
  await fs.mkdir(target);
  const first = captureRestartInputs(project);
  await fs.writeFile(path.join(target, 'old-snapshot.jar'), 'stale artifact excluded');
  assert.equal(captureRestartInputs(project).digest, first.digest);
  assert.ok(first.files.every(file => file.content === undefined));

  const asset = path.join(root, 'src/main/resources/widget.dat');
  const binary = Buffer.from([0, 1, 255, 254, 127]);
  await fs.writeFile(asset, binary);
  const next = captureRestartInputs(project, undefined, true);
  assert.notEqual(next.digest, first.digest);
  assert.deepEqual(next.files.find(file => file.name.endsWith('/widget.dat'))?.content, binary);
  assert.equal(next.files.some(file => file.name.startsWith('src/test/')), true);

  const maven = path.join(root, '.mvn');
  await fs.mkdir(maven);
  await fs.writeFile(path.join(maven, 'maven.config'), '-Dmaven.repo.local=' + target + '\n');
  assert.throws(() => captureRestartInputs(project), /outside the build root/u);
  await fs.writeFile(path.join(maven, 'maven.config'), '--file /unreviewed.xml\n');
  assert.throws(() => captureRestartInputs(project), /one absolute local repository option/u);
  await fs.writeFile(path.join(maven, 'jvm.config'), '-Xms32m\n');
  assert.throws(() => captureRestartInputs(project), /fixed Maven arguments/u);
});

test('Micronaut Gradle restart snapshots version catalogs and ignores original output',async t=>{
  const project=await fixture(t,'gradle');
  const first=captureRestartInputs(project);
  assert.equal(first.tool,'gradle');
  assert.ok(first.files.some(file=>file.name==='settings.gradle'));
  const build=path.join(project.root,'build');
  await fs.mkdir(build);
  await fs.writeFile(path.join(build,'old.jar'),'pre-existing Gradle output');
  assert.equal(captureRestartInputs(project).digest,first.digest);
  const support=path.join(project.root,'gradle');
  await fs.mkdir(support);
  await fs.writeFile(path.join(support,'libs.versions.toml'),'[versions]\njava = "25"\n');
  const next=captureRestartInputs(project);
  assert.notEqual(next.digest,first.digest);
  assert.ok(next.files.some(file=>file.name==='gradle/libs.versions.toml'));
  const settings=path.join(project.root,'settings.gradle');
  await fs.appendFile(settings,'\nincludeBuild("../external")\n');
  assert.throws(()=>captureRestartInputs(project),/standalone Micronaut Gradle/u);
});

test('Micronaut restart rejects multi-module layouts, external resources and alternate parent paths', async t => {
  const project = await fixture(t);
  const file = path.join(project.root, 'pom.xml');
  const original = await fs.readFile(file, 'utf8');
  for (const invalid of [
    original.replace('</project>', '<modules><module>child</module></modules></project>'),
    original.replace('<relativePath/>', '<relativePath>../pom.xml</relativePath>'),
    original.replace('<build>', '<build><resources><resource><directory>../assets</directory></resource></resources>'),
    original.replace('<build>', '<build><sourceDirectory>../java</sourceDirectory>')
  ]) {
    await fs.writeFile(file, invalid);
    assert.throws(() => captureRestartInputs(project), /standard single-module/u);
  }
  await fs.writeFile(file, original.replace('<build>', '<build><resources><resource>' +
    '<directory>src/main/resources</directory></resource></resources>'));
  assert.ok(captureRestartInputs(project).files.length > 1);
  const cancellation = new AbortController();
  cancellation.abort();
  assert.throws(() => captureRestartInputs(project, cancellation.signal), /cancelled/u);
});
