'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildFingerprint, local, workspacePath, fail, LIMITS } = require('./workbench-model');
const { independentJavaExecutable } = require('./debug-runtime');
const { captureClasspath, hash, readExact } = require('./groovy-project-classpath');

const natureKey = 'org.eclipse.jdt.ls.core.natureIds';
const providers = new Map([
  ['org.eclipse.m2e.core.maven2Nature', 'maven'],
  ['org.eclipse.buildship.core.gradleprojectnature', 'gradle']
]);

function projectPath(value, roots) {
  const candidate = local(value);
  if (/^(?:\\\\|\/\/)/u.test(candidate)) throw fail('Choose a local imported Groovy console project.');
  const folder = workspacePath(candidate, roots);
  if (path.relative(candidate, folder)) throw fail('Use an unlinked imported Groovy console project.');
  return folder;
}

async function listGroovyProjects(request, roots, check) {
  const observed = await request('java.project.getAll', []);
  check();
  if (!Array.isArray(observed) || observed.length > LIMITS.projects) {
    throw fail('Review projects in a workspace with at most 30 imported Java components.');
  }
  const result = [];
  for (const value of observed) {
    let root;
    try { root = projectPath(value, roots); } catch { continue; }
    if (result.some(item => !path.relative(item.root, root))) continue;
    const files = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
    const names = [];
    for (const basename of files) {
      const entry = path.join(root, basename);
      try {
        const stat = await fs.lstat(entry);
        if (stat.isFile() && !stat.isSymbolicLink()) names.push(basename);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    check();
    if (names.length !== 1) continue;
    result.push({ uri: pathToFileURL(root).href, root, name: path.basename(root),
      tool: names[0] === 'pom.xml' ? 'maven' : 'gradle' });
  }
  return result;
}

async function runtimeKey(options) {
  const binary = independentJavaExecutable(path.join(options.javaHome || '', 'bin',
    process.platform === 'win32' ? 'java.exe' : 'java'));
  const files = [binary, path.join(path.dirname(path.dirname(binary)), 'release')];
  const evidence = [];
  for (const file of files) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('Use a physical independent Java runtime for Groovy.');
    const bytes = await readExact(file, stat.size);
    if (file.endsWith(path.sep + 'release') && Number(/^JAVA_VERSION="(\d+)/mu.exec(bytes.toString('utf8'))?.[1] || 0) < 25) {
      throw fail('Use an independent JDK 25 or later for the Groovy project console.');
    }
    evidence.push([file, hash(bytes)]);
  }
  return hash(JSON.stringify({ evidence, javaHome: options.javaHome, gradleHome: options.gradleHome, groovyJar: options.groovyJar }));
}

async function observeGroovyClasspath({ request, roots, selected, scope, groovyHash, check }) {
  if (scope !== 'runtime' && scope !== 'test') throw fail('Choose the runtime or test project classpath.');
  const desired = projectPath(selected, roots);
  const observed = (await listGroovyProjects(request, roots, check)).find(project => !path.relative(project.root, desired));
  if (!observed) throw fail('Choose the exact currently imported Maven or Gradle project.');
  const before = buildFingerprint(observed.root);
  const settings = await request('java.project.getSettings', [observed.uri, [natureKey]]);
  check();
  const natures = settings?.[natureKey];
  const kinds = Array.isArray(natures) ? [...new Set(natures.map(value => providers.get(value)).filter(Boolean))] : [];
  if (kinds.length !== 1 || kinds[0] !== observed.tool) {
    throw fail('JDT must report the selected Maven or Gradle project provider.');
  }
  const packet = await request('java.project.getClasspaths', [observed.uri, { scope }]);
  check();
  if (!packet?.projectRoot || path.relative(projectPath(packet.projectRoot, roots), observed.root)) {
    throw fail('JDT returned the classpath for a different Java component.');
  }
  if (!Array.isArray(packet.modulepaths) || packet.modulepaths.length !== 0) {
    throw fail('Choose a project with an ordinary Java classpath for this Groovy console.');
  }
  const classpath = await captureClasspath(packet.classpaths, roots, groovyHash, check);
  const after = buildFingerprint(observed.root);
  if (before !== after) throw fail('The selected build changed during Groovy review.');
  return { project: observed, scope, classpath, key: hash(JSON.stringify({ observed, scope, build: before, classpath: classpath.digest })) };
}

module.exports = { listGroovyProjects, observeGroovyClasspath, runtimeKey };
