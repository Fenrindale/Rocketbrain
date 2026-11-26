'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { TestingError, sha } = require('./provision');

const MAX_MODULE_ENTRIES = 80;
const MAX_FILES = 12000;
const MAX_BYTES = 256 * 1024 * 1024;
const MODULE_NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*$/;
const PINS = new Map([
  ['junit-jupiter-api-6.0.3.jar', ['org.junit.jupiter.api', 'd655d7e6f0c7ae07f10a2f3bbaaebb6d30e9b26204a068ad9e9b3950aa28792c']],
  ['junit-jupiter-engine-6.0.3.jar', ['org.junit.jupiter.engine', '1e2fab61ad27ea08fc7c70dd9677cf8c6d1ae5434d42dcfdd633b12c7e7c04d0']],
  ['junit-platform-commons-6.0.3.jar', ['org.junit.platform.commons', '39f262d09c3d52719fe0b77f080e90a3695e285d779a41b232e17963ae5da200']],
  ['junit-platform-engine-6.0.3.jar', ['org.junit.platform.engine', '491e9e4f745f161b8a8e4186a1a7c6a450ea12c70930c9aedae427215301d947']],
  ['junit-platform-launcher-6.0.3.jar', ['org.junit.platform.launcher', '315608372e4dc44bca0ccb3ae8a07ecc206b3367033fa05748a03ccd563f1301']],
  ['opentest4j-1.3.0.jar', ['org.opentest4j', '48e2df636cab6563ced64dcdff8abb2355627cb236ef0bf37598682ddf742f1b']],
  ['apiguardian-api-1.1.2.jar', ['org.apiguardian.api', 'b509448ac506d607319f182537f0b35d71007582ec741832a1f111e5b5b70b38']],
  ['junit-jupiter-params-6.0.3.jar', ['org.junit.jupiter.params', 'cf2947e2302b9f8c8a059259a277881c1cadae8fbc2514c16a925cfeb7beb2e5', true]],
  ['junit-jupiter-6.0.3.jar', ['org.junit.jupiter', '784b65815f479a0c99a9d3a573b142e2a525efb6025d97f751b19e72f90aeda3', true]]
]);
const FRAMEWORK_JAR = /^(?:junit(?:-|\.)|opentest4j-|apiguardian-api-|testng-)/i;
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = (code, message) => new TestingError(code, message);

function namedModule(name) {
  return typeof name === 'string' && name.length <= 160 && MODULE_NAME.test(name);
}

function validateModuleConfig(config) {
  if (!config.modulePath.length && config.testModule === undefined) return;
  if (config.framework !== 'junit') throw fail('UNSUPPORTED_MODULE_TEST_ENGINE', 'Named module tests use the reviewed Jupiter engine.');
  if (!config.modulePath.length || !namedModule(config.testModule) || config.classPath.length ||
      config.testClassPaths.length !== 1 || !config.sourceRoots.length ||
      !config.modulePath.some(entry => pathKey(entry) === pathKey(config.testClassPaths[0])) ||
      !fs.statSync(path.join(config.testClassPaths[0], 'module-info.class'), { throwIfNoEntry: false })?.isFile()) {
    throw fail('INVALID_MODULE_TEST', 'Provide one compiled named test output, its module path and saved Java sources.');
  }
  for (const root of [...config.testClassPaths, ...config.sourceRoots]) {
    const relative = path.relative(config.workspace, root);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw fail('INVALID_MODULE_TEST', 'Named test outputs and sources must stay inside the reviewed workspace.');
    }
  }
  if (config.jvmArgs.some(arg => !/^(?:-D[A-Za-z_][A-Za-z0-9_.-]*=[^\r\n]*|-X(?:ms|mx|ss)[0-9]+[kKmMgG]?|-ea|-da)$/u.test(arg) ||
      /^-D(?:java\.(?:system\.class\.loader|class\.path)|jdk\.module\.|jdk\.util\.jar\.)/u.test(arg))) {
    throw fail('INVALID_MODULE_TEST', 'Named tests accept ordinary properties, heap settings and assertions. Declare module reads and opens in module-info.java.');
  }
  const launcher = require('./launcher-sources.json');
  for (const name of ['Runner.java', 'NamedModuleTests.java']) {
    if (!config.runtime.sourceHashes?.some(item => item.name === name && item.sha256 === sha(launcher[name]))) {
      throw fail('MODULE_TEST_RUNTIME_REQUIRED', 'Prepare the current Rocketbrain Java testing runtime before launching named tests.');
    }
  }
}

async function readCatalog(config) {
  let bytes = 0, files = 0, visits = 0;
  async function entry(file, relative) {
    const record = await fsp.lstat(file);
    if (!record.isFile() || record.isSymbolicLink() || ++files > MAX_FILES || (bytes += record.size) > MAX_BYTES) {
      throw fail('MODULE_INPUT_LIMIT', 'The named test path exceeds its physical file bounds.');
    }
    const read = await fsp.readFile(file);
    if (read.length !== record.size) throw fail('STALE_MODULE_TEST', 'A named test input changed. Discover the tests again.');
    return { relative, sha256: sha(read), bytes: read.length };
  }
  async function walk(root, directory, source, result, depth = 0) {
    if (depth > 32) throw fail('MODULE_INPUT_LIMIT', 'The named test directory is too deeply nested.');
    for (const name of (await fsp.readdir(directory)).sort()) {
      if (++visits > MAX_FILES * 2) throw fail('MODULE_INPUT_LIMIT', 'The named test path has too many entries.');
      const file = path.join(directory, name);
      const stat = await fsp.lstat(file);
      if (stat.isSymbolicLink()) throw fail('MODULE_INPUT_LIMIT', 'Named test files cannot use nested links.');
      if (stat.isDirectory()) await walk(root, file, source, result, depth + 1);
      else if (!source || name.endsWith('.java')) result.push(await entry(file, path.relative(root, file)));
    }
  }
  const moduleEntries = [];
  const junit = new Set();
  for (const origin of config.modulePath) {
    const stat = await fsp.lstat(origin);
    if (stat.isDirectory()) {
      const members = [];
      await walk(origin, origin, false, members);
      if (!members.some(item => item.relative === 'module-info.class')) {
        throw fail('INVALID_MODULE_TEST', 'Each named output directory needs a compiled module-info.class.');
      }
      moduleEntries.push({ origin, members, directory: true });
      continue;
    }
    const name = path.basename(origin);
    if (!/^[A-Za-z0-9_.-]{1,150}\.jar$/u.test(name)) throw fail('INVALID_MODULE_TEST', 'Use individual modular JARs or compiled module directories.');
    const artifact = await entry(origin, name), pin = PINS.get(name);
    if (FRAMEWORK_JAR.test(name) && (!pin || pin[1] !== artifact.sha256 || junit.has(pin[0]))) {
      throw fail('UNSUPPORTED_MODULE_TEST_ENGINE', 'Use the pinned modular Jupiter 6.0.3 artifacts on the named test path.');
    }
    if (pin) junit.add(pin[0]);
    moduleEntries.push({ origin, members: [artifact], directory: false,
      ...(pin ? { module: pin[0], optional: pin[2] === true || pin[0] === 'org.apiguardian.api' } : {}) });
  }
  if ([...PINS.values()].some(([module, , optional]) => !optional && !junit.has(module))) {
    throw fail('UNSUPPORTED_MODULE_TEST_ENGINE', 'The named test module path is missing pinned Jupiter 6.0.3 runtime JARs.');
  }
  const sources = [];
  for (const root of config.sourceRoots) {
    const members = [];
    await walk(root, root, true, members);
    sources.push({ root, members });
  }
  const fingerprint = sha(JSON.stringify({ name: config.testModule, jdk: config.releaseHash, launcher: config.runtime.launcherSha256,
    testOutput: config.testClassPaths[0], modules: moduleEntries, sources }));
  return { fingerprint, moduleEntries };
}

async function prepareModulePath(config, expected) {
  const catalog = await readCatalog(config);
  if (expected !== undefined && catalog.fingerprint !== expected) {
    throw fail('STALE_MODULE_TEST', 'Named test sources or compiled inputs changed. Build the module and refresh test discovery.');
  }
  const root = await fsp.realpath(os.tmpdir());
  const directory = await fsp.mkdtemp(path.join(root, 'rb-module-tests-'));
  const owned = await fsp.lstat(directory, { bigint: true });
  const dispose = async () => {
    const resolved = await fsp.realpath(directory), identity = await fsp.lstat(resolved, { bigint: true });
    if (pathKey(resolved) !== pathKey(directory) || pathKey(path.dirname(resolved)) !== pathKey(root) ||
        !path.basename(resolved).startsWith('rb-module-tests-') || owned.ino !== identity.ino || owned.dev !== identity.dev) {
      throw fail('INVALID_CLEANUP', 'The temporary named-test directory changed ownership.');
    }
    await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  };
  try {
    const stages = [];
    const settings = { testModule: config.testModule, moduleEntries: catalog.moduleEntries.length };
    for (const [index, item] of catalog.moduleEntries.entries()) {
      const bucket = path.join(directory, String(index));
      await fsp.mkdir(bucket);
      for (const member of item.members) {
        const origin = item.directory ? path.join(item.origin, member.relative) : item.origin;
        const target = path.join(bucket, member.relative);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(origin, target, fs.constants.COPYFILE_EXCL);
        if (sha(await fsp.readFile(target)) !== member.sha256) {
          throw fail('STALE_MODULE_TEST', 'A named test artifact changed while staging. Discover the tests again.');
        }
      }
      const staged = item.directory ? bucket : path.join(bucket, item.members[0].relative);
      stages.push(staged);
      settings['module.' + index + '.uri'] = pathToFileURL(staged).href;
      if (item.module) settings['module.' + index + '.expected'] = item.module;
      if (item.optional) settings['module.' + index + '.optional'] = true;
      if (pathKey(item.origin) === pathKey(config.testClassPaths[0])) settings.testModuleOutput = pathToFileURL(staged).href;
    }
    const modulePath = stages.join(path.delimiter);
    if (modulePath.length > 16000 || stages.some(entry => entry.includes(path.delimiter))) {
      throw fail('MODULE_INPUT_LIMIT', 'Use a bounded local staging path without module path delimiters.');
    }
    const validate = async () => {
      const current = await readCatalog(config);
      if (current.fingerprint !== catalog.fingerprint) {
        throw fail('STALE_MODULE_TEST', 'Named test sources or compiled inputs changed. Build the module and refresh test discovery.');
      }
    };
    await validate();
    return { settings, fingerprint: catalog.fingerprint, validate, dispose,
      arguments: ['--module-path', modulePath, '--add-modules', config.testModule + ',org.junit.jupiter.engine,org.junit.platform.launcher'] };
  } catch (error) {
    await dispose();
    throw error;
  }
}

module.exports = { MAX_MODULE_ENTRIES, namedModule, modularJUnitJar: file => PINS.has(path.basename(file)),
  validateModuleConfig, prepareModulePath };
