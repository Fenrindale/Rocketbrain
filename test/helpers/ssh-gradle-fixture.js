'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { sourceText, testSource, mountOwnedSpringUrl } = require('./ssh-maven-fixture');

const virtualBuild = '/gradle with space/build.gradle';
const settings = "rootProject.name = 'reviewed-gradle'\n";
const build = [
  "plugins { id 'java' }",
  "group = 'fixture.rocketbrain'",
  "version = '1.0'",
  "repositories { mavenCentral() }",
  "dependencies { testImplementation 'junit:junit:4.13.2' }",
  "java { toolchain { languageVersion = JavaLanguageVersion.of(25) } }",
  "test { useJUnit() }", ''
].join('\n');

const pins = {
  'junit/junit/4.13.2/junit-4.13.2.jar': '8e495b634469d64fb8acfa3495a065cbacc8a0fff55ce1e31007be4c16dc57d3',
  'junit/junit/4.13.2/junit-4.13.2.pom': '569b6977ee4603c965c1c46c3058fa6e969291b0160eb6964dd092cd89eadd94',
  'org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar': '66fdef91e9739348df7a096aa384a5685f4e875584cce89386a7a47251c4d8e9',
  'org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.pom': 'fde386a7905173a1b103de6ab820727584b50d0e32282e2797787c20a64ffa93',
  'org/hamcrest/hamcrest-parent/1.3/hamcrest-parent-1.3.pom': '6d535f94efb663bdb682c9f27a50335394688009642ba7a9677504bc1be4129b'
};
async function loadFixtureArtifact(relative, cache) {
  if (cache) return fs.readFile(path.join(cache, relative));
  const reply = await fetch('https://repo.maven.apache.org/maven2/' + relative,
    { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(reply.status, 200);
  const chunks = [];
  let size = 0;
  for await (const part of reply.body) {
    size += part.length;
    assert.ok(size <= 1024 * 1024);
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function stageGradle(fixture, configuration, cache) {
  const module = path.join(fixture.profile.root, 'gradle with space');
  const mainDir = path.join(module, 'src/main/java/fixture'), testDir = path.join(module, 'src/test/java/fixture');
  await fs.mkdir(mainDir, { recursive: true });
  await fs.mkdir(testDir, { recursive: true });
  const sourceFile = path.join(mainDir, 'Counter.java'), testFile = path.join(testDir, 'CounterTest.java');
  const buildFile = path.join(module, 'build.gradle'), settingsFile = path.join(module, 'settings.gradle');
  await fs.writeFile(buildFile, build);
  await fs.writeFile(settingsFile, settings);
  await fs.writeFile(sourceFile, sourceText);
  await fs.writeFile(testFile, testSource);
  const database = await mountOwnedSpringUrl(module, configuration);
  const repository = path.join(path.dirname(fixture.profile.root), 'reviewed-offline-mirror');
  for (const [relative, pin] of Object.entries(pins)) {
    const contents = await loadFixtureArtifact(relative, cache);
    assert.equal(createHash('sha256').update(contents).digest('hex'), pin);
    const endpoint = path.join(repository, relative);
    await fs.mkdir(path.dirname(endpoint), { recursive: true });
    await fs.writeFile(endpoint, contents, { flag: 'wx' });
  }
  return { virtualBuild, module, repository, buildFile, settingsFile, sourceFile, testFile, database };
}

module.exports = { stageGradle, settings, build, virtualBuild };
