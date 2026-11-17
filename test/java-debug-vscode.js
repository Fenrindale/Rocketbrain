'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  if (!process.env.ROCKETBRAIN_JAVA_TEST_CONFIG) throw new Error('Set ROCKETBRAIN_JAVA_TEST_CONFIG to the provisioned independent Java runtime JSON.');
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const spring = Boolean(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const folder = path.join(root, spring ? 'test-output/java-debug-vscode-spring' : 'test-output/java-debug-vscode'), extension = path.join(folder, 'extension'), profile = path.join(folder, 'user'), extensions = path.join(folder, 'extensions');
  for (const dir of [extension, path.join(profile, 'User'), extensions]) fs.mkdirSync(dir, { recursive: true });
  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'rocketbrain-java-debug-test', publisher: 'rocketbrain-local', version: '0.0.1', engines: { vscode: '^1.100.0' }, main: './index.js', activationEvents: ['*'], contributes: { debuggers: current.contributes.debuggers.filter(item => item.type === 'rocketbrain-java'), configuration: current.contributes.configuration } }, null, 2));
  fs.writeFileSync(path.join(extension, 'index.js'), `'use strict';\nconst vscode = require('vscode');\nconst { registerJavaFeatures } = require(${JSON.stringify(path.join(root, 'src/java/index.js'))});\nlet java;\nexports.activate = context => { java = registerJavaFeatures(context, vscode); context.subscriptions.push(java); return { java }; };\nexports.deactivate = async () => { await java?.dispose(); };\n`);
  const settings = { ...runtime.settings, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none' };
  if (spring) {
    settings['rocketbrain.java.gradleHome'] = process.env.ROCKETBRAIN_GRADLE_HOME || path.join(root, 'research/implementation/runtimes/gradle-9.1.0/extracted/gradle-9.1.0');
    settings['rocketbrain.java.gradleJavaHome'] = runtime.javaHome;
  }
  fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
  delete process.env.ELECTRON_RUN_AS_NODE;
  const workspace = process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE || path.join(root, spring ? 'test/fixtures' : 'test/fixtures/java');
  const evidenceFile = spring ? 'test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.4')+'-java-debug-spring-'+(process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE||'live')+'.json' : process.env.ROCKETBRAIN_JAVA_ADVANCED_DEBUG_TEST ? 'test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.4')+'-java-debug-host.json' : 'test-output/java-debug-host.json';
  await runTests({ vscodeExecutablePath: process.env.ROCKETBRAIN_VSCODE || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), extensionDevelopmentPath: extension, extensionTestsPath: path.join(root, 'test/java-debug-host-runner.js'), reuseMachineInstall: false, launchArgs: [workspace, `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry'], extensionTestsEnv: { ROCKETBRAIN_DEBUG_HOST_OUTPUT: path.join(root, evidenceFile) } });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
