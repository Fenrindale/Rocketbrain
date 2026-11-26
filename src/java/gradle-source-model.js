'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { buildSpec } = require('./workbench-tasks');
const M = require('./workbench-model');
const { readGradleSourceModel } = require('./gradle-source-model-probe');

const settingsFiles = ['settings.gradle', 'settings.gradle.kts'];
const buildFiles = ['build.gradle', 'build.gradle.kts'];
const ignore = new Set(['.git', '.gradle', '.idea', '.metadata', '.settings', '.vscode', 'build', 'node_modules',
  'out', 'src', 'target']);
const unsupported = new Set(['buildSrc', 'build-logic', 'gradle-daemon-jvm.properties']);
const taskPath = /^:(?:[A-Za-z0-9_][\w.-]*(?::[A-Za-z0-9_][\w.-]*){0,15})?$/u;
const same = (left, right) => !path.relative(left, right);

function physical(value, roots, directory = true) {
  const resolved = M.workspacePath(value, roots, { directory });
  if (!same(value, resolved)) throw M.fail('Use physical Gradle composite paths without links.');
  return resolved;
}

function selectedComponent(target, root) {
  if (target.provider !== 'gradle' || target.declaredBuild.kind !== 'gradle' || target.generated ||
      !['main', 'test'].includes(target.sourceRole) || target.scope !== (target.sourceRole === 'main' ? 'runtime' : 'test')) {
    throw M.fail('Select a recognized Gradle Java main or test source.');
  }
  const component = physical(target.projectRoot, [root]);
  const expected = path.join(component, 'src', target.sourceRole, 'java');
  const sourceRoot = physical(target.sourceRoot, [component]);
  const source = physical(fileURLToPath(target.sourceUri), [sourceRoot], false);
  if (!same(expected, sourceRoot) || path.extname(source) !== '.java') {
    throw M.fail('Select a physical Java file in the conventional main or test source layout.');
  }
  return { component, source };
}

function readFingerprint(file, maximum, dirty, beforeReport) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum ||
      !same(file, fs.realpathSync(file))) throw M.fail('Review only bounded physical Gradle configuration and source files.');
  if (dirty(file)) throw M.fail('Save all reviewed Gradle inputs before continuing.');
  const data = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (data.length > maximum || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || data.length !== after.size) {
    throw M.fail('Gradle inputs changed while being reviewed.');
  }
  beforeReport?.(data);
  return M.hash(data);
}

function configInventory(root, source, dirty) {
  const knownFiles = new Set([...settingsFiles, ...buildFiles, 'gradle.properties', 'gradle.lockfile']);
  const files = [];
  let total = 0, entries = 0;
  const capture = file => {
    if (files.length >= 160) throw M.fail('The selected Gradle composite has too many configuration files.');
    files.push([file, readFingerprint(file, 512 * 1024, dirty, bytes => {
      total += bytes.length;
      if (total > 8 * 1024 * 1024) throw M.fail('Gradle inputs exceed the reviewed model size.');
    })]);
  };
  function visit(directory, depth = 0) {
    if (depth > 16) throw M.fail('The selected Gradle composite has too many directory levels.');
    const entriesHere = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const item of entriesHere) {
      if (++entries > 4000) throw M.fail('The selected Gradle composite exceeds the reviewed directory entry limit.');
      if (ignore.has(item.name)) continue;
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink() || unsupported.has(item.name)) {
        throw M.fail('Links, custom build logic and selected daemon overrides require separate Gradle execution.');
      }
      if (item.isDirectory()) {
        physical(file, [root]);
        visit(file, depth + 1);
      } else if (knownFiles.has(item.name) || (/^(?:gradle|gradle\/.+)$/u.test(path.relative(root, directory).split(path.sep).join('/')) &&
          /\.(?:toml|xml|lockfile)$/u.test(item.name))) capture(file);
    }
  }
  visit(root);
  capture(source);
  return files;
}

function proofFor(target, root, folders, tools, dirty) {
  const workspace = M.workspaceRoots(folders);
  const compositeRoot = physical(root, workspace);
  const rootSettings = settingsFiles.map(name => path.join(compositeRoot, name)).filter(file => fs.existsSync(file));
  if (rootSettings.length !== 1) throw M.fail('Choose an in-workspace Gradle composite root with one saved settings descriptor.');
  const { source, component } = selectedComponent(target, compositeRoot);
  const project = { tool: 'gradle', root: compositeRoot, uri: pathToFileURL(compositeRoot).href, name: path.basename(compositeRoot) };
  const spec = buildSpec(project, tools, ['help']);
  const configuredHome = fs.realpathSync(tools.gradleHome);
  const launcher = spec.args[spec.args.indexOf('-cp') + 1];
  const version = /^gradle-launcher-(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.jar$/u.exec(path.basename(launcher));
  if (!version || Number(version[1]) < 9) throw M.fail('Configure an independent Gradle 9 installation with the composite model API.');
  const lib = path.dirname(launcher);
  const pinFiles = [spec.command, path.join(path.dirname(path.dirname(spec.command)), 'release'), launcher,
    path.join(lib, 'gradle-tooling-api-' + version.slice(1).join('.') + '.jar'),
    path.join(lib, 'gradle-tooling-api-provider-' + version.slice(1).join('.') + '.jar')];
  const toolPins = pinFiles.map(file => [file, readFingerprint(file, 64 * 1024 * 1024, () => false)]);
  const files = configInventory(compositeRoot, source, dirty);
  for (const file of rootSettings) {
    if (!files.some(item => same(file, item[0]))) throw M.fail('Gradle settings changed during inspection.');
  }
  const descriptor = files.find(([file]) => settingsFiles.includes(path.basename(file)) && same(path.dirname(file), compositeRoot));
  const key = M.hash({ root: compositeRoot, component, files, toolPins, home: configuredHome, rootSettings: descriptor });
  return { project, spec, tools: { ...tools, gradleHome: configuredHome }, key, files, component, source };
}

function bindModel(records, context) {
  const { project, files, component } = context;
  const captured = new Set(files.map(([file]) => file));
  function descriptor(directory, names, required) {
    const matches = names.map(name => path.join(directory, name)).filter(file => captured.has(file));
    if (matches.length > 1 || required && matches.length !== 1) {
      throw M.fail('The Gradle model has unreviewed or competing build descriptors.');
    }
    return matches[0];
  }
  const builds = new Map(), projects = [], selectors = new Set(), folders = new Set();
  for (const row of records) {
    const root = physical(row.buildRoot, [project.root]);
    if (row.kind === 'B') {
      const parent = row.parent && physical(row.parent, [project.root]);
      if (builds.has(root) || (parent ? !builds.has(parent) : !same(root, project.root))) {
        throw M.fail('Gradle reported ambiguous, external or disconnected included builds.');
      }
      builds.set(root, { root, parent, settingsFile: descriptor(root, settingsFiles, true) });
      continue;
    }
    const item = builds.get(root);
    const folder = physical(row.component, [root]);
    if (!item || !taskPath.test(row.treePath) || !taskPath.test(row.projectPath) ||
        selectors.has(row.treePath) || folders.has(folder) || (row.projectPath === ':') !== same(root, folder) ||
        (row.treePath === ':') !== same(project.root, folder)) {
      throw M.fail('Gradle reported ambiguous project membership or an unsupported build-tree selector.');
    }
    selectors.add(row.treePath);
    folders.add(folder);
    projects.push({ buildRoot: root, projectRoot: folder, projectPath: row.projectPath, treePath: row.treePath,
      settingsFile: item.settingsFile, buildFile: descriptor(folder, buildFiles, false) });
  }
  const selected = projects.find(item => same(item.projectRoot, component));
  if (!selected || !selected.buildFile || same(selected.buildRoot, project.root)) {
    throw M.fail('The selected Java source does not belong to one reviewed included Gradle build.');
  }
  const membershipSha256 = M.hash({
    builds: [...builds.values()].sort((left, right) => left.root.localeCompare(right.root)),
    projects: [...projects].sort((left, right) => left.treePath.localeCompare(right.treePath))
  });
  return { compositeRoot: project.root, selected, buildCount: builds.size, projectCount: projects.length, membershipSha256 };
}

function prepareGradleObservation(target, root, folders, tools, dirty) {
  const proof = proofFor(target, root, folders, tools, dirty);
  return { ...proof, review: { compositeRoot: proof.project.root, projectRoot: proof.component, sourceUri: target.sourceUri,
    gradleHome: proof.tools.gradleHome, javaHome: path.dirname(path.dirname(proof.spec.command)), inputCount: proof.files.length } };
}

async function observeGradleTarget(target, prepared, folders, dirty, cancellation) {
  if (proofFor(target, prepared.project.root, folders, prepared.tools, dirty).key !== prepared.key) {
    throw M.fail('The Gradle model inputs changed after review.');
  }
  const model = await readGradleSourceModel({ ...prepared, cancellation });
  const final = proofFor(target, prepared.project.root, folders, prepared.tools, dirty);
  if (final.key !== prepared.key) throw M.fail('The Gradle model inputs changed during inspection.');
  return { ...bindModel(model, final), key: final.key };
}

function verifyGradleObservation(target, observation, folders, tools, dirty) {
  const proof = proofFor(target, observation.compositeRoot, folders, tools, dirty);
  if (proof.key !== observation.key || !same(proof.component, observation.selected.projectRoot)) {
    throw M.fail('The reviewed Gradle composite model changed. Observe the current composite again.');
  }
  return proof;
}

module.exports = { prepareGradleObservation, observeGradleTarget, verifyGradleObservation, bindModel };
