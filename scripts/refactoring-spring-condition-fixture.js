'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { startRefactoringApp } = require('./refactoring-spring');

const root = path.resolve(__dirname, '..');
function fixturePath(version) {
  if (version !== 25 && version !== 26) throw Error('Use an owned Spring condition fixture.');
  return path.join(root, 'test/fixtures/refactoring-v' + version + '-spring');
}

function buildConditionFixture(java, version) {
  const project = fixturePath(version);
  const gradle = process.env.ROCKETBRAIN_GRADLE_HOME || java.gradleHome
    || path.join(root, 'research/implementation/runtimes/gradle-9.1.0/extracted/gradle-9.1.0');
  const launchers = fs.readdirSync(path.join(gradle, 'lib')).filter(name => /^gradle-launcher-[0-9][\w.-]*\.jar$/.test(name));
  if (launchers.length !== 1) throw Error('Use one reviewed Gradle launcher for the Spring condition fixture.');
  const executable = path.join(java.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const args = ['-Dorg.gradle.java.home=' + java.javaHome, '-cp', path.join(gradle, 'lib', launchers[0]),
    'org.gradle.launcher.GradleMain', '--no-daemon', '--console=plain', '--max-workers=2',
    '--gradle-user-home', path.join(root, 'test-output/java-gradle-user-home'), 'classes', 'writeClasspath'];
  const result = spawnSync(executable, args, { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 240000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(result.stderr + '\n' + result.stdout);
  return { project, classpathFile: path.join(project, 'build/runtime-classpath.txt') };
}

async function runConditionFixture(version) {
  const separator = process.argv.indexOf('--');
  if (separator < 0 || separator === process.argv.length - 1) throw Error('Pass the owned child Node script after --.');
  const parent = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  const { project, classpathFile } = buildConditionFixture(java, version);
  const config = { ...parent, projectPath: project, refactoringProjectPath: project,
    refactoringClassPathFile: classpathFile, mainClass: 'fixture.conditionsv' + version + '.app.ConditionsApplication' };
  const app = await startRefactoringApp(config);
  try {
    config.baseUrl = app.baseUrl;
    const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || ('v0.' + version);
    const file = path.join(root, 'test-output', prefix + '-spring-v' + version + '-runtime-' + crypto.randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, process.argv.slice(separator + 1), {
        cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, ['ROCKETBRAIN_SPRING_V' + version + '_CONFIG']: file }
      });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    await app.stop();
  }
}

module.exports = { buildConditionFixture, runConditionFixture };
