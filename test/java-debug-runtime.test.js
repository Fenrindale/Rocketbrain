'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLaunch } = require('../src/java/runtime');

test('Java engine upgrades isolate both OSGi and project metadata while preserving existing workspace evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-runtime-cache-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const javaHome = path.join(root, 'jdk'), serverPath = path.join(root, 'server'), storagePath = path.join(root, 'storage');
  const configName = process.platform === 'win32' ? 'config_win' : (process.platform === 'darwin' ? 'config_mac' : 'config_linux') + (process.arch === 'arm64' ? '_arm' : '');
  for (const directory of [path.join(javaHome, 'bin'), path.join(serverPath, 'plugins'), path.join(serverPath, configName), path.join(storagePath, 'workspace')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(javaHome, 'release'), 'JAVA_VERSION="25.0.5"\nIMPLEMENTOR="Eclipse Adoptium"\n');
  fs.writeFileSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), 'test only');
  fs.writeFileSync(path.join(serverPath, configName, 'config.ini'), 'osgi.bundles=test-1');
  const launcher = path.join(serverPath, 'plugins', 'org.eclipse.equinox.launcher_test.jar'); fs.writeFileSync(launcher, 'launcher-1');
  const legacy = path.join(storagePath, 'workspace', 'preserved-index'); fs.writeFileSync(legacy, 'old or interrupted state');
  const options = { javaHome, serverPath, storagePath }, first = resolveLaunch(options), repeated = resolveLaunch(options);
  assert.equal(first.data, repeated.data); assert.equal(first.configuration, repeated.configuration);
  assert.notEqual(first.data, path.dirname(legacy)); assert.equal(path.basename(first.data), path.basename(first.configuration));
  fs.writeFileSync(path.join(first.data, 'preserved-current-index'), 'first engine state');
  fs.writeFileSync(launcher, 'launcher-2'); const upgraded = resolveLaunch(options);
  assert.notEqual(upgraded.data, first.data); assert.notEqual(upgraded.configuration, first.configuration);
  const imported = resolveLaunch({ ...options, cacheContext: { gradleHome: '/new-independent-gradle' } }); assert.notEqual(imported.data, upgraded.data);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'old or interrupted state'); assert.equal(fs.readFileSync(path.join(first.data, 'preserved-current-index'), 'utf8'), 'first engine state');
});

test('Java debug launch avoids the Windows command line limit with the selected JDK', t => {
  const { launchCommandMode } = require('../src/java/debug-runtime');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-java-launch-'));
  t.after(() => {
    assert.equal(path.dirname(home), os.tmpdir());
    assert.match(path.basename(home), /^rocketbrain-java-launch-/u);
    fs.rmSync(path.join(home, 'release'), { force: true });
    fs.rmdirSync(home);
  });
  const javaExec = path.join(home, 'bin', 'java.exe');
  const release = path.join(home, 'release');
  fs.writeFileSync(release, 'JAVA_VERSION="25.0.5"\n');
  const classPaths = Array.from({ length: 300 }, (_, index) =>
    'C:\\fixture\\Spring project\\dependencies\\' + 'artifact'.repeat(10) + index + '.jar');
  const config = { javaExec, console: 'internalConsole', classPaths };
  assert.equal(launchCommandMode({ ...config, classPaths: classPaths.slice(0, 3) }, 'win32'), 'none');
  assert.equal(launchCommandMode(config, 'win32'), 'argfile');
  assert.equal(launchCommandMode(config, 'linux'), 'none');
  assert.equal(launchCommandMode({ ...config, shortenCommandLine: 'none' }, 'win32'), 'none');
  assert.equal(launchCommandMode({ ...config, classPaths: [], modulePaths: classPaths }, 'win32'), 'argfile');
  assert.throws(() => launchCommandMode({ ...config, shortenCommandLine: 'invalid' }, 'win32'), /shortenCommandLine/);
  fs.writeFileSync(release, 'JAVA_VERSION="1.8.0_442"\n');
  assert.equal(launchCommandMode({ ...config, classPaths: classPaths.slice(0, 65) }, 'win32'), 'none');
  assert.equal(launchCommandMode({ ...config, classPaths: classPaths.slice(0, 65), console: 'integratedTerminal' }, 'win32'), 'jarmanifest');
});
