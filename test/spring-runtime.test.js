'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { spawnSync } = require('node:child_process');
const { fixtureModel, filesUnder, root } = require('./spring-fixture');
const { analyzeSpring } = require('../src/spring/model');

const artifacts = [
  ...['spring-context', 'spring-aop', 'spring-beans', 'spring-core', 'spring-expression'].map(name => ['org.springframework', name, '7.0.10']),
  ['org.springframework.boot', 'spring-boot', '4.1.2'], ['org.springframework.boot', 'spring-boot-autoconfigure', '4.1.2'],
  ['commons-logging', 'commons-logging', '1.3.5'], ['org.jspecify', 'jspecify', '1.0.1'],
  ['io.micrometer', 'micrometer-observation', '1.16.8'], ['io.micrometer', 'micrometer-commons', '1.16.8']
];
async function checkedJar(coordinates, directory) {
  const [group, name, version] = coordinates, base = `https://repo.maven.apache.org/maven2/${group.replaceAll('.', '/')}/${name}/${version}/${name}-${version}`;
  let expected, algorithm, checksumUrl;
  for (const candidate of ['sha256', 'sha512', 'sha1']) {
    const url = base + '.jar.' + candidate, response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (response.ok) { algorithm = candidate; checksumUrl = url; expected = (await response.text()).trim().split(/\s+/)[0].toLowerCase(); break; }
  }
  if (!expected) throw new Error(`No publisher checksum for ${base}`);
  assert.match(expected, /^[a-f0-9]+$/); assert.equal(expected.length, { sha256: 64, sha512: 128, sha1: 40 }[algorithm]);
  const file = path.join(directory, `${name}-${version}.jar`);
  let bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!bytes || crypto.createHash(algorithm).update(bytes).digest('hex') !== expected) {
    const response = await fetch(base + '.jar', { signal: AbortSignal.timeout(60000) }); if (!response.ok) throw new Error(`Download failed: ${base}`);
    bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length < 20 * 1024 * 1024);
    assert.equal(crypto.createHash(algorithm).update(bytes).digest('hex'), expected); fs.writeFileSync(file, bytes);
  }
  return { group, name, version, url: base + '.jar', pomUrl: base + '.pom', checksumUrl, verificationAlgorithm: algorithm, publisherDigest: expected, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, file };
}

test('independent Spring model agrees with actual Spring container for supported profiles, qualifiers, values and errors', { skip: process.env.ROCKETBRAIN_SPRING_RUNTIME !== '1', timeout: 180000 }, async () => {
  let javaHome = process.env.ROCKETBRAIN_SPRING_JAVA_HOME;
  if (!javaHome && process.env.ROCKETBRAIN_JAVA_TEST_CONFIG) { const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8')); javaHome = config.javaHome || config.settings?.['rocketbrain.java.javaHome']; }
  assert.ok(javaHome && path.isAbsolute(javaHome), 'Supply an explicit independent JDK for the actual Spring fixture.');
  const output = path.resolve(__dirname, '../test-output/spring-runtime'), lib = path.join(output, 'lib'), classes = path.join(output, 'classes');
  fs.mkdirSync(lib, { recursive: true }); fs.mkdirSync(classes, { recursive: true });
  const dependencies = await Promise.all(artifacts.map(item => checkedJar(item, lib)));
  const classpath = dependencies.map(item => item.file).join(path.delimiter), sources = filesUnder(path.join(root, 'src'), /\.java$/);
  const executable = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const compile = spawnSync(executable('javac'), ['-encoding', 'UTF-8', '-parameters', '-cp', classpath, '-d', classes, ...sources.map(file => fileURLToPath(file.uri))], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const cases = [];
  for (const profile of ['prod', 'dev', 'ambiguous', 'missing']) {
    const run = spawnSync(executable('java'), ['-cp', [classes, classpath].join(path.delimiter), 'fixtures.valid.SpringProbe', profile, path.join(root, 'config')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const line = run.stdout.split(/\r?\n/).find(value => value.startsWith('ROCKETBRAIN_SPRING_RESULT=')); assert.ok(line, run.stdout + run.stderr);
    const actual = JSON.parse(line.slice('ROCKETBRAIN_SPRING_RESULT='.length));
    if (profile === 'prod' || profile === 'dev') {
      const model = fixtureModel(profile);
      const owner = profile === 'prod' ? 'fixtures.valid.Consumer' : 'fixtures.valid.DevConsumer';
      const beanInjection = model.injections.find(item => item.owner === owner && item.name === (profile === 'prod' ? 'blue' : 'dependency'));
      assert.equal(model.beans.find(bean => bean.id === beanInjection.resolution.selected[0]).name, actual.blue + 'Port');
      assert.equal(model.injections.find(item => item.owner === owner && item.name === 'greeting').resolution.value, actual.greeting);
      assert.equal(model.bindings.find(item => item.owner === 'fixtures.valid.Settings' && item.name === 'person').resolution.value, actual.settingsPerson);
      assert.equal(model.beans.find(bean => bean.name === 'feature').state === 'active', actual.feature);
      assert.equal(model.beans.find(bean => bean.name === 'unknownThing').state, 'unknown'); assert.equal(actual.unknownThing, false);
      if (profile === 'prod') {
        const preferred = model.injections.find(item => item.owner === owner && item.name === 'preferred');
        assert.equal(model.beans.find(bean => bean.id === preferred.resolution.selected[0]).name, actual.preferred + 'Port');
        const all = model.injections.find(item => item.owner === owner && item.name === 'all');
        assert.deepEqual(all.resolution.selected.map(id => model.beans.find(bean => bean.id === id).name).sort(), actual.ports);
      }
      cases.push({ actual, modelBeans: model.beans.map(bean => ({ name: bean.name, state: bean.state })), comparison: 'supported local model agrees; custom Condition intentionally unknown' });
    } else {
      const subset = sources.filter(file => profile === 'ambiguous' ? /\/(?:BadConfig|AmbiguousConsumer)\.java$/.test(file.uri) : file.uri.endsWith('/MissingConsumer.java'));
      const model = analyzeSpring(subset, [], { closedWorld: true, basePackages: ['fixtures.invalid'] });
      assert.equal(actual.error, profile === 'ambiguous' ? 'NoUniqueBeanDefinitionException' : 'NoSuchBeanDefinitionException');
      assert.ok(model.diagnostics.some(item => item.code === `spring.bean.${profile === 'ambiguous' ? 'ambiguous' : 'missing'}`)); cases.push({ actual, modelDiagnostics: model.diagnostics });
    }
  }
  const report = { asOf: new Date().toISOString(), springFramework: '7.0.10', springBoot: '4.1.2', javaHome, compiledWithParameters: true, realContainer: true, dependencies, cases, limitations: ['Explicitly registered fixture classes, not arbitrary application component scanning.', 'Custom Conditions are never executed by the static model.', 'Runtime dependencies are test-only downloads, not bundled product dependencies.'] };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
});
