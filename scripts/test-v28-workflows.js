'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const group = process.env.ROCKETBRAIN_V28_GROUP;
const project = group === 'state' ? 'refactoring-v28-state' : group === 'workbench' ? 'spring-boot-app' : null;
if (!project) throw Error('Select the state or workbench v0.28 fixture.');
const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
const profile = path.join(root, '.vscode-test', 'workflows-v28-' + group + '-' + randomUUID());
const extensions = path.join(root, '.vscode-test', 'core-extensions');
const settings = {
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
  'workbench.startupEditor': 'none', 'workbench.editor.enablePreview': false
};
for (const key of ['serverPath', 'javaHome', 'projectJdks', 'gradleHome', 'gradleJavaHome', 'debugBundlePath']) {
  if (runtime[key] !== undefined) settings['rocketbrain.java.' + key] = runtime[key];
}
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.mkdirSync(extensions, { recursive: true });
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
delete process.env.ELECTRON_RUN_AS_NODE;
runTests({
  vscodeExecutablePath: process.env.ROCKETBRAIN_VSCODE || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: process.env.ROCKETBRAIN_TEST_EXTENSION_PATH || root,
  extensionTestsPath: path.join(root, 'test', 'workflows-v28-host.js'),
  reuseMachineInstall: false,
  launchArgs: [
    path.join(root, 'test', 'fixtures', project), '--user-data-dir=' + profile, '--extensions-dir=' + extensions,
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-updates', '--disable-telemetry'
  ],
  extensionTestsEnv: { GRADLE_USER_HOME: path.join(root, 'test-output/java-gradle-user-home') }
}).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
