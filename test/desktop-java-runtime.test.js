'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { desktopJavaHome, discoverDesktopJdk, inspectDesktopRuntime } = require('../src/java/desktop-runtime');
const { JDT_VERSION } = require('../src/java/runtime');

const executable = name => name + (process.platform === 'win32' ? '.exe' : '');

function jdk(home, { version = '25.0.5', vendor = 'Eclipse Adoptium', tools = true } = {}) {
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'release'), `JAVA_VERSION="${version}"\nIMPLEMENTOR="${vendor}"\n`);
  for (const name of tools ? ['java', 'javac', 'jar'] : ['java']) fs.writeFileSync(path.join(home, 'bin', executable(name)), 'fixture');
  return fs.realpathSync(home);
}

function fixture(testContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-desktop-jdk-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('desktop setup accepts a full independent JDK and falls back past obsolete and embedded runtimes', t => {
  const root = fixture(t);
  const old = jdk(path.join(root, 'old'), { version: '21.0.1' });
  const embedded = jdk(path.join(root, 'embedded'), { vendor: 'JetBrains' });
  const jre = jdk(path.join(root, 'jre'), { tools: false });
  const compatible = jdk(path.join(root, 'compatible'));
  assert.throws(() => desktopJavaHome(old), /JDK 25/);
  assert.throws(() => desktopJavaHome(embedded), /independent general-purpose JDK/);
  assert.throws(() => desktopJavaHome(jre), /full JDK/);
  const env = { JDK_HOME: embedded, JAVA_HOME: old, PATH: [path.join(jre, 'bin'), path.join(compatible, 'bin')].join(path.delimiter) };
  assert.deepEqual(discoverDesktopJdk(path.join(root, 'managed'), { env, home: root }), { path: compatible, version: '25.0.5' });
});

test('desktop setup uses validated profile-managed assets while keeping explicit settings authoritative', t => {
  const root = fixture(t);
  const target = path.join(root, 'java-engine');
  const automatic = jdk(path.join(root, 'detected'));
  const explicit = jdk(path.join(root, 'chosen'));
  const server = path.join(target, `jdtls-${JDT_VERSION}`);
  const configuration = process.platform === 'win32' ? 'config_win' :
    (process.platform === 'darwin' ? 'config_mac' : 'config_linux') + (process.arch === 'arm64' ? '_arm' : '');
  fs.mkdirSync(path.join(server, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(server, configuration), { recursive: true });
  fs.writeFileSync(path.join(server, 'plugins', 'org.eclipse.equinox.launcher_fixture.jar'), 'fixture');
  fs.writeFileSync(path.join(server, configuration, 'config.ini'), 'fixture');
  const config = new Map();
  const inspect = () => inspectDesktopRuntime(config, target, () => desktopJavaHome(automatic));
  assert.equal(inspect().jdk.path, automatic);
  assert.equal(inspect().serverPath, fs.realpathSync(server));
  assert.deepEqual(inspect().problems, []);
  config.set('javaHome', explicit);
  assert.equal(inspect().jdk.path, explicit);
  config.set('serverPath', path.join(target, 'missing'));
  assert.equal(inspect().serverPath, undefined);
  assert.match(inspect().problems[0], /Java language engine/);
  config.set('javaHome', path.join(target, 'missing'));
  assert.equal(inspect().jdk, undefined);
  assert.match(inspect().problems[0], /JDK/);
});
