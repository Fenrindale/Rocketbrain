'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const M = require('./workbench-model');
const { describeSourceLayout } = require('./workbench-source-layout');
const { resolveBuildTarget, verifyNestedComponent } = require('./source-target-builds');

const settingsKeys = [
  'org.eclipse.jdt.ls.core.sourcePaths',
  'org.eclipse.jdt.ls.core.outputPath',
  'org.eclipse.jdt.ls.core.classpathEntries',
  'org.eclipse.jdt.ls.core.natureIds',
  'org.eclipse.jdt.core.compiler.compliance'
];
const resolved = (left, right) => path.relative(left, right) === '';

function exactPath(value, roots, directory = true) {
  const input = M.local(value);
  if (/^(?:\\\\|\/\/)/u.test(input)) throw M.fail('Use a physical local Java workspace path.');
  const file = M.workspacePath(input, roots, { directory });
  if (!resolved(input, file)) throw M.fail('Use a physical Java workspace path without linked parents.');
  return file;
}

function sourceSnapshot(file, dirty) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > M.LIMITS.fileBytes || !resolved(file, fs.realpathSync(file))) {
    throw M.fail('Use a bounded physical Java source file.');
  }
  if (dirty(file)) throw M.fail('Save the Java source before inspecting its build target.');
  const bytes = fs.readFileSync(file);
  if (bytes.length > M.LIMITS.fileBytes) throw M.fail('The Java source grew beyond its inspection limit.');
  return M.hash(bytes);
}

function exactClasspaths(packet, project, folders) {
  if (!packet?.projectRoot || !resolved(project, exactPath(packet.projectRoot, folders))) {
    throw M.fail('JDT did not associate the selected source with the exact imported Java component.');
  }
  if (!Array.isArray(packet.classpaths) || !Array.isArray(packet.modulepaths) ||
      packet.classpaths.length + packet.modulepaths.length > M.LIMITS.libraries) {
    throw M.fail('The Java engine did not provide bounded classpath metadata for this source.');
  }
  return Object.fromEntries([['classpath', packet.classpaths], ['modulepath', packet.modulepaths]].map(([kind, entries]) =>
    [kind, [...new Set(entries.map(entry => {
      const local = M.local(entry);
      if (/^(?:\\\\|\/\/)/u.test(local)) throw M.fail('Java source classpath entries must use local paths.');
      return local;
    }))]]));
}

async function resolveJavaSourceTarget({ sourceUri, folders, request, dirty = () => false, cancellation }) {
  const check = () => { if (M.cancelled(cancellation)) throw M.fail('Java source target inspection cancelled.'); };
  check();
  const roots = M.workspaceRoots(folders);
  const selected = exactPath(sourceUri, roots, false);
  if (!selected.toLowerCase().endsWith('.java')) throw M.fail('Select a saved Java source file.');
  const source = pathToFileURL(selected).href, sourceDigest = sourceSnapshot(selected, dirty);
  const observed = await request('java.project.getAll', [], cancellation);
  check();
  if (!Array.isArray(observed) || observed.length > M.LIMITS.projects) {
    throw M.fail('Inspect a workspace containing at most 30 observed Java projects.');
  }
  const candidates = [];
  for (const value of observed) {
    let root;
    try { root = exactPath(value, roots); } catch { continue; }
    if (M.inside(root, selected) && !candidates.some(item => resolved(item, root))) candidates.push(root);
  }
  candidates.sort((left, right) => right.length - left.length);
  const project = candidates[0];
  if (!project) throw M.fail('Import the Java component containing the selected source.');
  const workspace = roots.filter(root => M.inside(root, project)).sort((left, right) => right.length - left.length)[0];
  verifyNestedComponent(selected, project);
  const declared = resolveBuildTarget(project, workspace, dirty);
  const runtime = await request('java.project.getClasspaths', [source, { scope: 'runtime' }], cancellation);
  check();
  const runtimePaths = exactClasspaths(runtime, project, roots);
  const settings = await request('java.project.getSettings', [source, settingsKeys], cancellation);
  check();
  const pathValues = settings?.[settingsKeys[0]];
  if (!Array.isArray(pathValues) || pathValues.length > M.LIMITS.sourceRoots) {
    throw M.fail('JDT did not report bounded source roots for this Java component.');
  }
  const matching = [];
  for (const value of pathValues) {
    let root;
    try { root = exactPath(value, [project]); } catch { continue; }
    if (M.inside(root, selected) && !matching.some(item => resolved(item.path, root))) {
      matching.push({ id: M.id('source-target-root', root), path: root });
    }
  }
  matching.sort((left, right) => right.path.length - left.path.length);
  if (!matching.length) throw M.fail('The selected Java file is outside the imported component source roots.');
  const layout = { root: project, sourceRoots: matching };
  describeSourceLayout(layout, settings[settingsKeys[2]], settings[settingsKeys[1]]);
  const { path: sourceRoot, scope: sourceRole, outputPath, layoutSource, generated } = layout.sourceRoots[0];
  const scope = sourceRole === 'test' ? 'test' : 'runtime';
  const classpaths = scope === 'runtime' ? runtimePaths :
    exactClasspaths(await request('java.project.getClasspaths', [source, { scope }], cancellation), project, roots);
  check();
  verifyNestedComponent(selected, project);
  if (sourceSnapshot(selected, dirty) !== sourceDigest || resolveBuildTarget(project, workspace, dirty).fingerprint !== declared.fingerprint) {
    throw M.fail('The source or a build descriptor changed during inspection.');
  }
  const natures = settings[settingsKeys[3]];
  const names = Array.isArray(natures) && natures.length <= 32
    ? natures.filter(name => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,140}$/u.test(name)) : [];
  const maven = names.includes('org.eclipse.m2e.core.maven2Nature');
  const gradle = names.includes('org.eclipse.buildship.core.gradleprojectnature');
  if (maven && gradle) throw M.fail('JDT reported competing Maven and Gradle providers for this Java component.');
  const provider = maven ? 'maven' : gradle ? 'gradle' : 'jdt';
  return {
    sourceUri: source, projectUri: pathToFileURL(project).href, projectRoot: project,
    sourceRoot, sourceRole, ...(outputPath && { outputPath }), layoutSource, generated: Boolean(generated),
    scope, provider, ...classpaths, observedProjectOutputs: layout.outputRoots,
    compliance: typeof settings[settingsKeys[4]] === 'string' ? settings[settingsKeys[4]] : undefined,
    declaredBuild: declared.build, executedProjectCode: false,
    fingerprint: M.hash({ sourceDigest, build: declared.fingerprint, project, candidates, sourceRoot, sourceRole, outputPath,
      layoutSource, scope, provider, classpaths, compliance: settings[settingsKeys[4]] })
  };
}

module.exports = { resolveJavaSourceTarget, settingsKeys };
