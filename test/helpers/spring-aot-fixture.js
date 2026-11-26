'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');

const registrationFile = 'build/generated/aotSources/fixture/AotProbe__BeanFactoryRegistrations.java';
const sourceFixture = path.join(__dirname, '../fixtures/java/spring-aot-beans');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function createAotFixture({ parent, javaConfig, gradleCache }) {
  const realParent = await fs.realpath(parent);
  const runtime = await read(javaConfig);
  const lib = path.join(runtime.gradleHome, 'lib');
  const launcher = (await fs.readdir(lib)).filter(name => /^gradle-launcher-[\d.]+\.jar$/u.test(name));
  assert.equal(launcher.length, 1);
  const java = path.join(runtime.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const project = await fs.mkdtemp(path.join(realParent, 'rb-aot-beans-'));
  const identity = await fs.lstat(project, { bigint: true });
  const artifact = path.join(project, registrationFile);
  const jar = path.join(project, 'build/libs/rocketbrain-spring-aot-beans-1.0.0.jar');

  async function dispose() {
    const real = await fs.realpath(project), current = await fs.lstat(real, { bigint: true });
    assert.equal(path.relative(project, real), '');
    assert.equal(path.relative(realParent, path.dirname(real)), '');
    assert.match(path.basename(real), /^rb-aot-beans-/u);
    assert.deepEqual([current.dev, current.ino], [identity.dev, identity.ino]);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }

  try {
    await fs.cp(sourceFixture, project, { recursive: true });
  } catch (error) {
    await dispose();
    throw error;
  }

  async function build(feature) {
    const result = await execute(java, ['-Dorg.gradle.java.home=' + runtime.javaHome, '-cp', path.join(lib, launcher[0]),
      'org.gradle.launcher.GradleMain', '--no-daemon', '--offline', '--gradle-user-home', gradleCache, 'bootJar'],
    { cwd: project, env: { ...process.env, JAVA_HOME: runtime.javaHome, ROCKETBRAIN_AOT_FEATURE: feature }, timeoutMs: 140000 });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /> Task :processAot/u);
  }

  async function run(engine, config, feature) {
    assert.equal(config.host, '127.0.0.1');
    const driver = engine === 'mysql' ? 'mysql' : 'mariadb';
    const url = 'jdbc:' + driver + '://127.0.0.1:' + config.port + '/' + config.database +
      (engine === 'mysql' ? '?sslMode=DISABLED&allowPublicKeyRetrieval=true' : '?sslMode=disable');
    const result = await execute(java, ['-Dspring.aot.enabled=true', '-jar', jar], {
      cwd: project, timeoutMs: 40000, env: { ...process.env, ROCKETBRAIN_AOT_FEATURE: feature,
        ROCKETBRAIN_AOT_DB_URL: url, ROCKETBRAIN_AOT_DB_USER: config.user, ROCKETBRAIN_AOT_DB_PASSWORD: config.password }
    });
    const proof = /^rocketbrain-aot-proof:([^\r\n]+)\|42\|fixed\|(true|false)\s*$/mu.exec(result.output);
    assert.equal(result.code, 0, 'The owned Spring AOT jar did not exit successfully.');
    assert.ok(proof, 'The owned Spring AOT jar did not return the expected JDBC and bean result.');
    assert.match(proof[1], engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*-MariaDB/u);
    return { engine, version: proof[1], value: 42, alias: 'fixed', activeProbe: proof[2] === 'true' };
  }

  return { project, artifact, build, run, dispose };
}

module.exports = { createAotFixture, read };
