'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');
const root = path.resolve(__dirname, '..');
const executable = process.env.ROCKETBRAIN_VSCODE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
if (!fs.existsSync(executable)) throw new Error('Set ROCKETBRAIN_VSCODE to an installed VS Code executable.');
const profile = process.env.ROCKETBRAIN_TEST_PROFILE ? path.resolve(process.env.ROCKETBRAIN_TEST_PROFILE) : path.join(root, '.vscode-test', 'core-user');
if (!profile.toLowerCase().startsWith((path.join(root, '.vscode-test') + path.sep).toLowerCase())) throw new Error('The isolated test profile must stay inside the project test directory.');
const extensions = path.join(root, '.vscode-test', 'core-extensions');
const nativeHost = process.env.ROCKETBRAIN_NATIVE_CHECKS || 'extension-host';
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nativeHost)) throw new Error('Select a native test host file by name.');
const extensionTestsPath = path.join(root, 'test', nativeHost + '.js');
if (!fs.existsSync(extensionTestsPath)) throw new Error('The selected native test host does not exist.');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.mkdirSync(extensions, { recursive: true });
const settings = { 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none' };
if (process.env.ROCKETBRAIN_JAVA_TEST_CONFIG) {
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  for (const key of ['serverPath', 'javaHome', 'projectJdks', 'gradleHome', 'gradleJavaHome', 'debugBundlePath']) if (java[key] !== undefined) settings[`rocketbrain.java.${key}`] = java[key];
}
if (process.env.ROCKETBRAIN_SPRING_TEST_CONFIG) {
  const spring = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_TEST_CONFIG, 'utf8'));
  for (const [key, value] of Object.entries(spring)) settings[`rocketbrain.spring.${key}`] = value;
}
if (process.env.ROCKETBRAIN_JPA_TEST_CONFIG) {
  const jpa = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JPA_TEST_CONFIG, 'utf8'));
  for (const [key, value] of Object.entries(jpa)) settings[`rocketbrain.jpa.${key}`] = value;
}
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
delete process.env.ELECTRON_RUN_AS_NODE;
runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: process.env.ROCKETBRAIN_TEST_EXTENSION_PATH || root,
  extensionTestsPath,
  reuseMachineInstall: false,
  launchArgs: [process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE || path.join(root, 'research', 'fixtures'), `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry'],
  extensionTestsEnv: { GRADLE_USER_HOME: path.join(root, 'test-output', 'java-gradle-user-home'), ROCKETBRAIN_TEST_OUTPUT: process.env.ROCKETBRAIN_TEST_OUTPUT||path.join(root, 'test-output', process.env.ROCKETBRAIN_TEST_EXTENSION_PATH ? 'packaged-host.json' : 'extension-host.json') },
}).catch(error => { console.error(error); process.exitCode = 1; });
