'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const M = require('./workbench-model');
const { pomFacts, gradleSettings } = require('./dependency-builds');
const { buildSpec } = require('./workbench-tasks');
const { verifyGradleObservation } = require('./gradle-source-model');
const { declaredExecutions, reactorParent } = require('./maven-source-execution');

const segment = /^[A-Za-z0-9_][\w.-]*$/u;
const configFiles = ['settings.gradle', 'settings.gradle.kts'];
const scriptFiles = ['build.gradle', 'build.gradle.kts'];
const localPath = (value, roots, directory = true) => {
  const physical = M.workspacePath(value, roots, { directory });
  if (path.relative(value, physical)) throw M.fail('Use physical unlinked build paths for the reviewed Java target.');
  return physical;
};

function capture(dirty) {
  const captured = new Map();
  let bytes = 0;
  function read(file, limit = M.LIMITS.fileBytes, tooling = false) {
    if (captured.has(file)) return captured.get(file);
    if (captured.size >= 240) throw M.fail('The reviewed source build exceeds its file limit.');
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) { captured.set(file, null); return null; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || path.relative(file, fs.realpathSync(file))) {
      throw M.fail('Use bounded physical Java build and runtime files.');
    }
    if (!tooling && dirty(file)) throw M.fail('Save the changed Java build input before reviewing execution.');
    const data = fs.readFileSync(file);
    if (data.length > limit || !tooling && (bytes += data.length) > 8 * 1024 * 1024) {
      throw M.fail('The Java build inputs exceed their review limits.');
    }
    const item = { path: file, uri: pathToFileURL(file).href, digest: M.hash(data),
      ...(!tooling && { text: new TextDecoder('utf-8', { fatal: true }).decode(data) }) };
    captured.set(file, item);
    return item;
  }
  return { read, fingerprint: () => M.hash([...captured].map(([file, item]) => [file, item?.digest ?? null])) };
}

function mavenReactor(target, root, read) {
  const expected = target.declaredBuild.reactorProject;
  if (typeof expected !== 'string' || expected.length > 240 || !expected.split('/').every(value => segment.test(value)) ||
      path.relative(path.resolve(root, expected), target.projectRoot)) {
    throw M.fail('Use a reviewed literal relative Maven reactor module selector.');
  }
  const config = read(path.join(root, '.mvn', 'maven.config'));
  if (config?.text.split(/\r?\n/u).map(line => line.trim()).some(line => line && !line.startsWith('#') &&
      !['--offline', '-o'].includes(line))) {
    throw M.fail('Maven configuration options that can alter the reviewed reactor command require separate execution.');
  }
  for (const name of ['extensions.xml', 'jvm.config']) {
    if (read(path.join(root, '.mvn', name))) throw M.fail('Maven project extensions or JVM options require separate execution.');
  }

  const modules = new Map();
  function visit(directory) {
    const physical = localPath(directory, [root]);
    if (modules.has(physical) || modules.size >= M.LIMITS.projects) {
      throw M.fail('Review only a bounded Maven reactor with distinct modules.');
    }
    const file = read(path.join(physical, 'pom.xml'));
    if (!file || /<(?:[\w.-]+:)?extensions(?:\s|>)/iu.test(file.text)) {
      throw M.fail('Maven module POMs and their extension boundary must be available for review.');
    }
    const model = pomFacts(file);
    if (model.profiles || model.modules.some(value => !value.split('/').every(part => segment.test(part)))) {
      throw M.fail('Profile-dependent or computed Maven reactor modules require separate execution.');
    }
    modules.set(physical, model);
    for (const relative of model.modules) visit(path.join(physical, relative));
  }
  visit(root);
  if (!modules.has(target.projectRoot)) throw M.fail('The selected Java component is outside the reviewed Maven reactor.');
  return { selector: expected, modules };
}

function executionChoices(target, root, reactor) {
  const { modules } = reactor;
  const owner = modules.get(target.projectRoot);
  if (owner.packaging === 'pom' || owner.modules.length) {
    throw M.fail('Choose a Java source in a leaf Maven reactor module for execution.');
  }
  // Maven may merge parent execution configuration. Only reviewed physical reactor ancestors are accepted.
  for (let current = owner, parent = reactorParent(current.file); parent; parent = reactorParent(current.file)) {
    if (!/^(?:\.\.\/)+pom\.xml$/u.test(parent.relative)) {
      throw M.fail('Declared Maven execution review requires conventional local reactor parents.');
    }
    const folder = path.dirname(path.resolve(current.root, parent.relative));
    if (!folder || folder === current.root || !M.inside(root, folder)) {
      throw M.fail('Declared Maven execution review requires conventional local reactor parents.');
    }
    const ancestor = modules.get(folder);
    if (!ancestor || ancestor.gav.group !== parent.group || ancestor.gav.artifact !== parent.artifact ||
        ancestor.gav.version !== parent.version) {
      throw M.fail('The Maven parent does not match a reviewed physical reactor module.');
    }
    current = ancestor;
  }
  return declaredExecutions(owner.file);
}

function listMavenSourceExecutions(target, folders, dirty) {
  const selected = route(target);
  if (selected?.tool !== 'maven') throw M.fail('Select a Java source in an imported Maven reactor module.');
  const root = localPath(selected.root, M.workspaceRoots(folders));
  const { read } = capture(dirty);
  return executionChoices(target, root, mavenReactor(target, root, read));
}

function reviewedMaven(target, root, read, executionChoice) {
  const reactor = mavenReactor(target, root, read);
  const tail = ['--file', path.join(root, 'pom.xml'), '--projects', reactor.selector];
  if (executionChoice !== undefined) {
    const execution = executionChoices(target, root, reactor).find(choice => choice.id === executionChoice);
    if (!execution) throw M.fail('The exact Maven execution changed or is unavailable. Refresh the declared goals.');
    return { task: execution.task, selector: reactor.selector, tail: [...tail, '--offline'], execution };
  }
  const task = target.scope === 'test' ? 'test-compile' : 'compile';
  return { task, selector: reactor.selector, tail: [...tail, '--also-make'] };
}

function reviewedGradle(target, root, read) {
  const verified = new Map(), builds = new Set();
  function visit(directory, prefix = '') {
    const physical = localPath(directory, [root]);
    if (builds.has(physical) || builds.size >= 16) throw M.fail('Review only a bounded Gradle build tree with distinct included builds.');
    builds.add(physical);
    const inputs = configFiles.map(name => read(path.join(physical, name))).filter(Boolean);
    if (inputs.length !== 1) throw M.fail('Use one exact settings file for each reviewed Gradle build.');
    const layout = gradleSettings(inputs[0], { composite: true });
    if (layout.limitation) throw M.fail('Computed Gradle project or included-build membership requires separate execution.');
    for (const [project, folder] of layout.projects) {
      const name = prefix + (project === ':' ? '' : project) || ':';
      if (verified.has(name) || verified.size >= M.LIMITS.projects) {
        throw M.fail('Review only a bounded Gradle build tree with distinct project paths.');
      }
      const component = localPath(folder, [root]);
      verified.set(name, component);
      if (scriptFiles.map(file => read(path.join(component, file))).filter(Boolean).length > 1) {
        throw M.fail('A reviewed Gradle project has competing build scripts.');
      }
      read(path.join(component, 'gradle.properties'));
    }
    read(path.join(physical, 'gradle', 'libs.versions.toml'));
    for (const included of layout.includes) visit(included.directory, prefix + ':' + included.name);
  }
  visit(root);
  const selector = target.declaredBuild.buildTreePath || target.declaredBuild.projectPath;
  if (!verified.has(selector) || path.relative(verified.get(selector), target.projectRoot)) {
    throw M.fail('The selected Java component does not match the reviewed Gradle project path.');
  }
  const suffix = target.scope === 'test' ? 'testClasses' : 'classes';
  return { task: (selector === ':' ? '' : selector) + ':' + suffix, selector, tail: [] };
}

function route(target) {
  const build = target.declaredBuild;
  if (target.sourceRole !== 'main' && target.sourceRole !== 'test' || target.generated) return;
  if (target.provider === 'maven' && build.kind === 'maven' && build.reactorRoot && build.reactorProject) {
    return { tool: 'maven', root: build.reactorRoot };
  }
  if (target.provider === 'gradle' && build.kind === 'gradle' && build.projectPath && build.buildRoot) {
    return { tool: 'gradle', root: build.compositeRoot || build.buildRoot };
  }
}

function prepareSourceExecution(target, folders, tools, dirty, observedGradle, executionChoice) {
  const selected = observedGradle ? { tool: 'gradle', root: observedGradle.compositeRoot } : route(target);
  if (!selected) throw M.fail('Select an observed main or test source in a supported literal Maven reactor or Gradle build tree.');
  if (executionChoice !== undefined && (selected.tool !== 'maven' || typeof executionChoice !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(executionChoice))) {
    throw M.fail('Choose a current Maven execution from this Java source target.');
  }
  const root = localPath(selected.root, M.workspaceRoots(folders));
  const { read, fingerprint } = capture(dirty);
  let details;
  if (observedGradle) {
    verifyGradleObservation(target, observedGradle, folders, tools, dirty);
    const selector = observedGradle.selected.treePath;
    const suffix = target.scope === 'test' ? 'testClasses' : 'classes';
    details = { task: selector + ':' + suffix, selector, tail: ['--offline', '--no-configuration-cache',
      '-Dorg.gradle.java.installations.auto-download=false'] };
  } else {
    details = selected.tool === 'maven' ? reviewedMaven(target, root, read, executionChoice) : reviewedGradle(target, root, read);
  }
  const project = { tool: selected.tool, root, uri: pathToFileURL(root).href, name: path.basename(root) };
  const spec = buildSpec(project, tools, [details.task], { declaredMavenExecution: Boolean(details.execution) });
  spec.args.push(...details.tail);
  spec.reviewedSourceTarget = true;
  for (const key of Object.keys(spec.env)) {
    if (/^(?:MAVEN_ARGS|MAVEN_OPTS|MAVEN_BASEDIR|MAVEN_PROJECTBASEDIR|JAVA_OPTS|GRADLE_OPTS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH)$/iu.test(key)) {
      delete spec.env[key];
    }
  }
  function toolFile(file) {
    if (!read(file, 64 * 1024 * 1024, true)) throw M.fail('The reviewed Java launcher inputs are unavailable.');
  }
  toolFile(spec.command);
  toolFile(path.join(path.dirname(path.dirname(spec.command)), 'release'));
  toolFile(spec.args[spec.args.indexOf('-cp') + 1]);
  const classworlds = spec.args.find(arg => arg.startsWith('-Dclassworlds.conf='));
  if (classworlds) toolFile(classworlds.slice('-Dclassworlds.conf='.length));
  if (details.execution) {
    const home = spec.args.find(arg => arg.startsWith('-Dmaven.home=')).slice('-Dmaven.home='.length);
    const lib = path.join(home, 'lib');
    const core = fs.readdirSync(lib).filter(name => /^maven-core-3\.9\.\d+\.jar$/u.test(name));
    if (core.length !== 1) throw M.fail('Configure one independent Apache Maven 3.9 distribution for declared execution.');
    toolFile(path.join(lib, core[0]));
  }
  const projectId = M.id('project', target.projectRoot);
  const review = { sourceUri: target.sourceUri, projectRoot: target.projectRoot, tool: selected.tool, scope: target.scope,
    cwd: spec.cwd, command: spec.command, args: spec.args, task: details.task, selector: details.selector,
    ...(observedGradle && { gradleModel: { buildRoot: observedGradle.selected.buildRoot,
      settingsFile: observedGradle.selected.settingsFile, buildCount: observedGradle.buildCount,
      projectCount: observedGradle.projectCount, buildInputs: observedGradle.key, membershipSha256: observedGradle.membershipSha256 } }),
    ...(details.execution && { mavenExecution: details.execution }),
    reactorDependenciesIncluded: selected.tool === 'maven' && !details.execution };
  return { spec, projectId, review, key: M.hash({ review, env: spec.env, files: fingerprint() }) };
}

module.exports = { prepareSourceExecution, route, listMavenSourceExecutions };
