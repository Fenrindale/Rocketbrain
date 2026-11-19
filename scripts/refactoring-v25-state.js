'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { startRefactoringApp } = require('./refactoring-spring');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'test/fixtures/refactoring-v25-state');
const classpathFile = path.join(project, 'build/runtime-classpath.txt');

function buildStateV25(java) {
  const gradle = process.env.ROCKETBRAIN_GRADLE_HOME || java.gradleHome ||
    path.join(root, 'research/implementation/runtimes/gradle-9.1.0/extracted/gradle-9.1.0');
  const executable = path.join(java.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const result = spawnSync(executable, [
    '-Dorg.gradle.java.home=' + java.javaHome, '-cp', path.join(gradle, 'lib/gradle-launcher-9.1.0.jar'),
    'org.gradle.launcher.GradleMain', '--no-daemon', '--console=plain', '--max-workers=2',
    '--gradle-user-home', path.join(root, 'test-output/java-gradle-user-home'), 'classes', 'writeClasspath'
  ], { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 240000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(result.stderr + '\n' + result.stdout);
  return { project, classpathFile };
}

async function main() {
  const separator = process.argv.indexOf('--');
  if (separator < 0) throw Error('Pass the integration test script after --.');
  const parent = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  buildStateV25(java);
  const config = { ...parent, projectPath: project, refactoringProjectPath: project, stateRoot: project,
    mainClass: 'fixture.statev25.StateApplication', refactoringClassPathFile: classpathFile };
  const app = await startRefactoringApp(config);
  try {
    config.baseUrl = app.baseUrl;
    const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.25';
    const file = path.join(root, 'test-output', prefix + '-move-state-v25-runtime-' + crypto.randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, process.argv.slice(separator + 1), { cwd: root, windowsHide: true,
        stdio: 'inherit', env: { ...process.env, ROCKETBRAIN_MOVE_STATE_V25_CONFIG: file } });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    await app.stop();
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { buildStateV25 };
