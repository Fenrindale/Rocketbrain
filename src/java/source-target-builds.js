'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { pomFacts, gradleSettings } = require('./dependency-builds');
const { fail, hash, inside } = require('./workbench-model');

const files = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const relativeModule = /^(?:[A-Za-z0-9_][\w.-]*\/)*[A-Za-z0-9_][\w.-]*$/u;
const relativeTo = (root, file) => path.relative(root, file).split(path.sep).join('/');

function descriptor(file, dirty) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { path: file, digest: null };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || path.relative(file, fs.realpathSync(file))) {
    throw fail('Use bounded physical Java build descriptors.');
  }
  if (dirty(file)) throw fail('Save the Java build descriptor before inspecting the source target.');
  const bytes = fs.readFileSync(file);
  if (bytes.length > 1024 * 1024) throw fail('A Java build descriptor grew beyond its inspection limit.');
  return { path: file, uri: pathToFileURL(file).href, digest: hash(bytes), text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}

function verifyNestedComponent(source, project) {
  for (let folder = path.dirname(source); path.relative(project, folder) !== '' && inside(project, folder); folder = path.dirname(folder)) {
    if ([...files, '.project'].some(name => fs.lstatSync(path.join(folder, name), { throwIfNoEntry: false }))) {
      throw fail('Import the nested Java component containing the selected source. Its parent cannot supply this target.');
    }
  }
}

function captureTargets(project, workspace, dirty) {
  const entries = []; let bytes = 0;
  for (let dir = project, depth = 0; depth < 24 && inside(workspace, dir); dir = path.dirname(dir), depth++) {
    const descriptors = files.map(name => {
      const item = descriptor(path.join(dir, name), dirty);
      bytes += Buffer.byteLength(item.text || '');
      if (bytes > 8 * 1024 * 1024) throw fail('The Java build descriptors exceed 8 MiB.');
      return item;
    });
    entries.push({ dir, descriptors,
      pom: descriptors[0].uri ? descriptors[0] : null,
      gradle: descriptors.slice(1, 3).filter(item => item.uri),
      settings: descriptors.slice(3).filter(item => item.uri) });
    if (!path.relative(workspace, dir)) return entries;
  }
  throw fail('The imported Java component is too deeply nested in the workspace.');
}

function mavenTarget(entries) {
  const module = pomFacts(entries[0].pom);
  const coordinates = module.gav.group && module.gav.artifact && module.gav.version
    ? [module.gav.group, module.gav.artifact, module.gav.version].join(':') : undefined;
  const chain = [];
  let child = entries[0].dir;
  for (const entry of entries.slice(1)) {
    if (!entry.pom) continue;
    const outer = pomFacts(entry.pom);
    const matches = outer.moduleDeclarations.filter(item => relativeModule.test(item.value) &&
      path.relative(child, path.resolve(entry.dir, item.value)) === '');
    if (matches.length !== 1 || outer.packaging !== 'pom' || outer.profiles) break;
    chain.push({ uri: entry.pom.uri, range: matches[0].range, kind: 'reactor-module', label: matches[0].value, directory: entry.dir });
    child = entry.dir;
  }
  const reactor = chain.at(-1);
  return { kind: 'maven', buildFile: { uri: module.file.uri, kind: 'component-descriptor' }, coordinates,
    ...(reactor && { reactorRoot: reactor.directory, reactorProject: relativeTo(reactor.directory, entries[0].dir) }), declarations: chain };
}

function gradleTarget(entries) {
  const project = entries[0].dir;
  const nearest = entries.findIndex(entry => entry.settings.length);
  const info = { kind: 'gradle', buildFile: { uri: entries[0].gradle[0].uri, kind: 'component-descriptor' }, declarations: [] };
  if (nearest < 0) return info;
  const context = entries[nearest], settings = context.settings[0];
  if (context.settings.length !== 1) return info;
  const layout = gradleSettings(settings, { composite: true });
  if (layout.limitation) return info;
  const match = [...layout.projects].filter(([, directory]) => !path.relative(project, directory));
  if (match.length !== 1) return info;
  const [projectPath] = match[0];
  info.buildRoot = context.dir;
  info.projectPath = projectPath;
  const declaration = layout.declarations.get(projectPath);
  if (declaration) info.declarations.push({ uri: settings.uri, range: declaration, kind: 'gradle-project', label: projectPath });
  const includes = [];
  for (const outer of entries.slice(nearest + 1)) {
    if (!outer.settings.length) continue;
    if (outer.settings.length !== 1) break;
    const outerSettings = outer.settings[0], model = gradleSettings(outerSettings, { composite: true });
    if (model.limitation) break;
    for (const item of model.includes.filter(item => !path.relative(context.dir, item.directory))) {
      // A same-path project and included build are ambiguous in the build tree.
      if (model.projects.has(':' + item.name)) return info;
      includes.push({ outer, file: outerSettings, item });
    }
  }
  if (includes.length !== 1) return info;
  const { outer, file, item } = includes[0];
  info.compositeRoot = outer.dir;
  info.includedBuild = item.name;
  info.buildTreePath = ':' + item.name + (projectPath === ':' ? '' : projectPath);
  info.declarations.push({ uri: file.uri, range: item.range, kind: 'included-gradle-build', label: item.name });
  return info;
}

function resolveBuildTarget(project, workspace, dirty) {
  const entries = captureTargets(project, workspace, dirty);
  const selected = entries[0];
  if (selected.gradle.length > 1 || selected.pom && selected.gradle.length) {
    throw fail('The imported component has competing Gradle or Maven build descriptors.');
  }
  const build = selected.pom ? mavenTarget(entries) : selected.gradle.length ? gradleTarget(entries) : { kind: 'java', declarations: [] };
  const fingerprint = hash(entries.flatMap(item => item.descriptors.map(file => [file.path, file.digest])));
  return { build, fingerprint };
}

module.exports = { resolveBuildTarget, verifyNestedComponent };
