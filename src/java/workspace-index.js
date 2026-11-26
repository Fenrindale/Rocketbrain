'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { inside, LIMITS, cancelled, local } = require('./workbench-model');

const pointerKey = 'rocketbrain.java.workspaceIndex.v1';
const markerName = 'rocketbrain-index-generation.json';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const excluded = new Set(['.git', '.hg', '.svn', '.gradle', '.metadata', 'node_modules', 'build', 'target', 'bin', 'out']);
const generatedMetadata = /(?:^|[\\/])(?:\.project|\.classpath|\.settings(?:[\\/]|$))/u;
const sources = /\.(?:java|kt|kts|groovy|scala|gradle|prefs)$/iu;
const controls = new Set(['pom.xml', 'gradle.properties', 'gradle-wrapper.properties', 'gradle-wrapper.jar',
  'libs.versions.toml', 'maven.config', 'jvm.config', 'extensions.xml', 'toolchains.xml', '.project', '.classpath']);

const hash = input => createHash('sha256').update(Buffer.isBuffer(input) ? input : JSON.stringify(input)).digest('hex');
const key = input => process.platform === 'win32' ? input.replace(/^[a-z]:/u, drive => drive.toUpperCase()) : input;
const samePath = (a, b) => key(path.resolve(a)) === key(path.resolve(b));
const physicalInside = (root, file) => samePath(root, file) ||
  key(path.resolve(file)).startsWith(key(path.normalize(root.endsWith(path.sep) ? root : root + path.sep)));

function physicalDirectory(file) {
  if (!path.isAbsolute(file || '') || file.startsWith('\\\\')) throw Error('Choose an ordinary local Java workspace path.');
  const stat = fs.lstatSync(file, { bigint: true });
  const real = fs.realpathSync.native(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, file)) {
    throw Error('Java index paths must be physical local directories without links.');
  }
  return { file: real, device: String(stat.dev), inode: String(stat.ino) };
}

function indexScope(folders, storageUri) {
  if (storageUri?.scheme !== 'file' || storageUri.authority ||
      !Array.isArray(folders) || !folders.length || folders.length > 8 ||
      folders.some(({ uri }) => uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment)) {
    throw Error('Open a trusted local Java workspace with at most eight physical folders.');
  }
  const roots = folders.map(folder => physicalDirectory(folder.uri.fsPath));
  if (roots.some((root, slot) => roots.some((peer, other) => slot !== other && physicalInside(peer.file, root.file)))) {
    throw Error('Use distinct nonoverlapping folders for a Java workspace index rebuild.');
  }
  if (roots.some(root => inside(root.file, storageUri.fsPath) || inside(storageUri.fsPath, root.file))) {
    throw Error('Keep Rocketbrain index storage separate from project files.');
  }
  return { roots, key: hash(roots), storage: path.join(storageUri.fsPath, 'java') };
}

function indexStorage(scope, generation) {
  if (generation == null) return scope.storage;
  if (!uuid.test(generation)) throw Error('The saved Java index generation is invalid.');
  const base = physicalDirectory(scope.storage).file;
  const parent = physicalDirectory(path.join(base, 'index-generations')).file;
  const folder = physicalDirectory(path.join(parent, generation)).file;
  if (!samePath(path.dirname(folder), parent)) throw Error('The Java index generation is outside Rocketbrain storage.');
  const markerFile = path.join(folder, markerName), marker = fs.lstatSync(markerFile);
  if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 512) throw Error('The Java index generation marker is invalid.');
  const recorded = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (recorded.format !== 1 || recorded.scope !== scope.key || recorded.id !== generation) {
    throw Error('The Java index generation belongs to another workspace.');
  }
  return folder;
}

function readGeneration(scope, state) {
  const pointer = state.get(pointerKey);
  if (!pointer || pointer.scope !== scope.key) return null;
  if (pointer.format !== 1) throw Error('This Java index generation has an unsupported workspace record.');
  indexStorage(scope, pointer.id);
  return pointer.id;
}

function reserveGeneration(scope) {
  const base = physicalDirectory(scope.storage).file;
  const parent = path.join(base, 'index-generations');
  try { fs.mkdirSync(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const owned = physicalDirectory(parent).file;
  const id = randomUUID(), folder = path.join(owned, id);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, markerName), JSON.stringify({ format: 1, scope: scope.key, id }), { flag: 'wx' });
  indexStorage(scope, id);
  return id;
}

const sourceMetadata = file => generatedMetadata.test(file);
function isInput(file) {
  const name = path.basename(file).toLowerCase();
  return sources.test(name) || controls.has(name) ||
    name === 'settings.json' && path.basename(path.dirname(file)) === '.vscode';
}

function savedInput(file, budget) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(LIMITS.fileBytes) ||
      ++budget.files > LIMITS.files || (budget.bytes += Number(before.size)) > LIMITS.sourceBytes) {
    throw Error('Java index review requires at most 2,000 physical input files, 1 MiB each and 32 MiB total.');
  }
  const contents = fs.readFileSync(file);
  const after = fs.lstatSync(file, { bigint: true });
  if (contents.length !== Number(before.size) ||
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(field => before[field] !== after[field])) {
    throw Error('An index input changed while it was being reviewed.');
  }
  return hash(contents);
}

function inputSnapshot(scope, models, context, cancellation) {
  const roots = scope.roots.map(root => root.file);
  const inputCheck = () => {
    if (cancelled(cancellation)) throw Error('Java workspace index rebuild cancelled.');
    if (context.documents().some(doc => doc.isDirty && !doc.isClosed && doc.uri?.scheme === 'file' &&
        typeof doc.uri.fsPath === 'string' && (doc.uri.fsPath === context.workspaceFile?.fsPath ||
          roots.some(root => inside(root, doc.uri.fsPath)) && (isInput(doc.uri.fsPath) || sourceMetadata(doc.uri.fsPath))))) {
      throw Error('Save modified Java sources and project settings before rebuilding the index.');
    }
  };
  inputCheck();
  const observed = modelSnapshot(scope, models);
  const loaded = new Map(), visited = new Set();
  const budget = { files: 0, bytes: 0, entries: 0 };
  function scan(folder, depth = 0) {
    if (visited.has(key(folder))) return;
    visited.add(key(folder));
    if (depth > LIMITS.directoryDepth) throw Error('Java index review exceeds its directory depth limit.');
    const opened = fs.opendirSync(folder);
    try {
      let entry;
      while ((entry = opened.readSync()) !== null) {
        if (++budget.entries > LIMITS.entries) throw Error('Java index review exceeds 20,000 directory entries.');
        if (cancelled(cancellation)) throw Error('Java workspace index rebuild cancelled.');
        if (excluded.has(entry.name.toLowerCase())) continue;
        const file = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw Error('Java workspace index review requires physical sources and build files.');
        if (entry.isDirectory()) scan(file, depth + 1);
        else if (entry.isFile() && (isInput(file) || sourceMetadata(file))) loaded.set(file, savedInput(file, budget));
      }
    } finally { opened.closeSync(); }
  }
  for (const root of roots) scan(root);
  for (const project of observed) for (const source of project.sources) if (source.directory) scan(source.directory.file);
  if (context.workspaceFile) {
    const file = context.workspaceFile;
    if (file.scheme !== 'file' || file.authority || file.query || file.fragment) throw Error('Save this local VS Code workspace before rebuilding.');
    if (!loaded.has(file.fsPath)) loaded.set(file.fsPath, savedInput(file.fsPath, budget));
  }
  inputCheck();
  const files = [...loaded].sort(([a], [b]) => a.localeCompare(b));
  return { observed, count: budget.files, all: hash(files), authored: hash(files.filter(([file]) => !sourceMetadata(file))) };
}

function missingSource(scope, value) {
  const file = path.resolve(local(value));
  if (!scope.roots.some(root => physicalInside(root.file, file))) {
    throw Error('An unresolved Java source root is outside the reviewed workspace.');
  }
  let parent = file;
  for (;;) {
    try {
      fs.lstatSync(parent);
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
      parent = path.dirname(parent);
      continue;
    }
    if (parent === file) throw Error('A Java source root is reported unresolved despite existing on disk.');
    physicalDirectory(parent);
    return key(file);
  }
}

function modelSnapshot(scope, models) {
  if (!Array.isArray(models) || !models.length || models.length > LIMITS.projects ||
      !models.some(project => !project.buildOnly)) {
    throw Error('Import the bounded Java projects before rebuilding the workspace index.');
  }
  const physical = file => {
    const record = physicalDirectory(file);
    if (!scope.roots.some(root => physicalInside(root.file, record.file))) {
      throw Error('Review only Java project and source roots inside this workspace.');
    }
    return record;
  };
  return models.map(project => ({
    directory: physical(project.root), tool: project.tool, jdk: project.jdk, compliance: project.compliance,
    ...(project.buildOnly && { buildOnly: true, members: project.reactorMembers || [] }),
    libraries: project.libraries.map(item => [item.kind, item.path || item.name]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    sources: project.sourceRoots.map(item => {
      if (item.unavailable) return { missing: missingSource(scope, item.path) };
      return { directory: physical(item.path), scope: item.scope, generated: Boolean(item.generated) };
    }).sort((a, b) => (a.directory?.file || a.missing).localeCompare(b.directory?.file || b.missing))
  })).sort((a, b) => a.directory.file.localeCompare(b.directory.file));
}

function createWorkspaceIndex({ context, current, observe, stop, start, memento,
  now = Date.now, deadlineMs = 120000, pollMs = 500 }) {
  let review;
  function scopeCheck(request) {
    const value = context();
    if (cancelled(request)) throw Error('Java workspace index rebuild cancelled.');
    return value;
  }
  const sameContext = (one, other) => one.scope.key === other.scope.key && one.settings === other.settings &&
    samePath(one.scope.storage, other.scope.storage) && one.workspaceFile?.fsPath === other.workspaceFile?.fsPath;
  const sameEngine = (one, other) => one?.session === other?.session && one?.runtimeIdentity === other?.runtimeIdentity &&
    one?.generation === other?.generation && one?.workspaceData === other?.workspaceData && one?.applied === other?.applied;

  async function reviewRebuild(cancellation) {
    const environment = scopeCheck(cancellation), active = current();
    if (!active?.workspaceData) throw Error('Start the independent Java engine before reviewing an index rebuild.');
    const models = await observe(cancellation, now() + deadlineMs);
    const inputs = inputSnapshot(environment.scope, models, environment, cancellation);
    if (!sameContext(environment, scopeCheck(cancellation)) || !sameEngine(active, current())) {
      throw Error('The Java engine, configuration or workspace changed during review.');
    }
    if (readGeneration(environment.scope, memento) !== active.generation ||
        !inside(indexStorage(environment.scope, active.generation), active.workspaceData)) {
      throw Error('The selected Java engine does not match its saved index generation.');
    }
    review = { id: randomUUID(), environment, active, inputs, expiresAt: now() + 120000 };
    return { id: review.id, expiresAt: review.expiresAt, currentWorkspaceData: active.workspaceData, inputFiles: inputs.count,
      projects: inputs.observed.map(item => ({ root: item.directory.file, tool: item.tool, jdk: item.jdk,
        generatedRoots: item.sources.filter(source => source.generated).length })) };
  }

  async function apply(id, { approved, cancellation } = {}) {
    const plan = review;
    if (approved !== true || !plan || plan.id !== id || now() >= plan.expiresAt) {
      throw Error('Open and approve a current Java workspace index rebuild review.');
    }
    const { environment, active, inputs } = plan;
    const guard = () => {
      if (!sameContext(environment, scopeCheck(cancellation))) throw Error('The Java workspace or configuration changed after review.');
      if (readGeneration(environment.scope, memento) !== active.generation) throw Error('The saved Java index generation changed.');
    };
    guard();
    if (!sameEngine(active, current()) || readGeneration(environment.scope, memento) !== active.generation) {
      throw Error('The active Java index changed after review.');
    }
    const observed = await observe(cancellation, now() + deadlineMs);
    const before = inputSnapshot(environment.scope, observed, environment, cancellation);
    guard();
    if (review !== plan || now() >= plan.expiresAt || !sameEngine(active, current()) ||
        before.all !== inputs.all || hash(before.observed) !== hash(inputs.observed)) {
      throw Error('The saved Java project/source model changed after review. Review the rebuild again.');
    }
    review = undefined;
    const generation = reserveGeneration(environment.scope);
    let stopped = false;
    try {
      await stop();
      stopped = true;
      guard();
      if (inputSnapshot(environment.scope, observed, environment, cancellation).all !== inputs.all) {
        throw Error('Saved Java index inputs changed before restart.');
      }
      const next = await start(environment.scope, generation);
      const storage = indexStorage(environment.scope, generation);
      if (!next || next.runtimeIdentity !== active.runtimeIdentity || next.applied !== active.applied || next.generation !== generation ||
          !next.workspaceData || !inside(storage, next.workspaceData) || samePath(active.workspaceData, next.workspaceData)) {
        throw Error('The new Java engine does not match the approved isolated index generation.');
      }
      const deadline = now() + deadlineMs;
      for (;;) {
        guard();
        if (now() >= deadline) throw Error('The new Java index did not rebind the approved project models.');
        const loaded = await observe(cancellation, deadline);
        if (loaded.length === inputs.observed.length &&
            hash(modelSnapshot(environment.scope, loaded)) === hash(inputs.observed)) {
          const after = inputSnapshot(environment.scope, loaded, environment, cancellation);
          guard();
          if (after.authored !== inputs.authored || !sameEngine(next, current())) throw Error('Java index inputs or engine changed during rebinding.');
          const priorRetained = fs.statSync(active.workspaceData).isDirectory();
          if (!priorRetained) throw Error('Rocketbrain could not confirm the retained Java index.');
          await memento.update(pointerKey, { format: 1, scope: environment.scope.key, id: generation });
          return { state: 'rebuilt', generation, previousWorkspaceData: active.workspaceData, workspaceData: next.workspaceData,
            projects: inputs.observed.length, inputFiles: inputs.count, priorRetained };
        }
        await pause(pollMs);
      }
    } catch (error) {
      if (!stopped) throw error;
      try {
        await stop();
        if (!sameContext(environment, context())) throw Error('The workspace configuration changed.');
        const restored = await start(environment.scope, active.generation);
        if (!restored || restored.workspaceData !== active.workspaceData) throw Error('The original index did not restart.');
      } catch {
        throw Error(error.message + ' The prior Java index files were retained. Restart Java after checking the current workspace configuration.');
      }
      throw Error(error.message + ' Rocketbrain restored the prior Java index.');
    }
  }
  return { review: reviewRebuild, apply, clear() { review = undefined; } };
}

module.exports = { createWorkspaceIndex, indexScope, indexStorage, readGeneration, hash };
