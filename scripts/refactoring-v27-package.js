'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { startRefactoringApp } = require('./refactoring-spring');

const root = path.resolve(__dirname, '..');
const moduleProject = path.join(root, 'test/fixtures/refactoring-v27-package');
const httpProject = path.join(root, 'test/fixtures/refactoring-v27-package-http');

function gradleBuild(java, project, tasks) {
  const gradle = process.env.ROCKETBRAIN_GRADLE_HOME || java.gradleHome;
  const launcher = path.join(gradle, 'lib/gradle-launcher-9.1.0.jar');
  const result = spawnSync(path.join(java.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), [
    '-Dorg.gradle.java.home=' + java.javaHome, '-cp', launcher, 'org.gradle.launcher.GradleMain',
    '--no-daemon', '--console=plain', '--max-workers=2', '--gradle-user-home', path.join(root, 'test-output/java-gradle-user-home'),
    ...tasks
  ], { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 240000 });
  if (result.error || result.status !== 0) throw Error('Owned named-module or Spring Gradle build failed.\n' +
    (result.error || '') + '\n' + result.stderr + '\n' + result.stdout);
}

function buildPackageV27(java) {
  gradleBuild(java, moduleProject, ['clean', 'classes']);
  const modulePath = path.join(moduleProject, 'build/classes/java/main');
  if (!fs.existsSync(path.join(modulePath, 'module-info.class'))) throw Error('Owned named-module compiler output is missing.');
  return { project: moduleProject, modulePath, cleanBuild: true };
}

async function main() {
  const separator = process.argv.indexOf('--');
  if (separator < 0 || !process.argv[separator + 1]) throw Error('Pass the owned child Node script after --.');
  const parent = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
  const built = buildPackageV27(java);
  gradleBuild(java, httpProject, ['classes', 'writeClasspath']);
  const config = { ...parent, projectPath: httpProject, moduleProjectPath: built.project };
  const app = await startRefactoringApp(config);
  try {
    config.baseUrl = app.baseUrl;
    const file = path.join(root, 'test-output', 'v0.27-package-runtime-' + randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, process.argv.slice(separator + 1), {
        cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, ROCKETBRAIN_MOVE_V27_PACKAGE_CONFIG: file }
      });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    await app.stop();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
module.exports = { buildPackageV27 };
