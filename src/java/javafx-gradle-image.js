'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { inside, fail } = require('./workbench-model');

const moduleName = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;
const launcherName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const maxDescriptorBytes = 64 * 1024;
const artifactMagic = 0xCAFEDADA;

// The task catalog opts into these getters on the recognized plugin task only.
const gradleImageModel = `
def javafxImageModel = { project, task ->
  if (task.path != ':jlink' ||
      !project.pluginManager.hasPlugin('org.openjfx.javafxplugin') ||
      !project.pluginManager.hasPlugin('org.beryx.jlink')) return null
  if (task.class.superclass.name != 'org.beryx.jlink.JlinkTask' &&
      task.class.name != 'org.beryx.jlink.JlinkTask') return null
  try {
    if (!task.targetPlatforms.isEmpty() || !task.secondaryLaunchers.isEmpty() || task.customImageData.enabled) return null
    return [directory: task.imageDirAsFile.absoluteFile.toPath().normalize().toString(),
      intermediate: project.file(task.jlinkBasePath).absoluteFile.toPath().normalize().toString(),
      module: task.moduleName, launcher: task.launcherData.name]
  } catch (Exception ignored) {
    return null
  }
}
`;

function physicalChild(root, target, { directory = false, mayBeMissing = false } = {}) {
  if (!path.isAbsolute(target) || !inside(root, target) || !path.relative(root, target)) {
    throw fail('JavaFX image paths must stay inside the selected project.');
  }
  const components = path.relative(root, target).split(path.sep);
  let current = root, stat;
  for (const [index, part] of components.entries()) {
    current = path.join(current, part);
    stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && mayBeMissing) return { path: target };
    if (!stat || stat.isSymbolicLink() || (index < components.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) {
      throw fail('Use physical project-owned JavaFX image paths and regular runtime files.');
    }
  }
  return { path: current, stat };
}

function readModule(root) {
  const { path: file, stat } = physicalChild(root, path.join(root, 'src/main/java/module-info.java'));
  if (stat.size > maxDescriptorBytes) throw fail('The JavaFX module descriptor exceeds its supported size.');
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, ' ');
  const name = /\bmodule\s+([\w$.]+)\s*\{/u.exec(text)?.[1];
  if (!moduleName.test(name || '') || !/\brequires\s+(?:(?:static|transitive)\s+)*javafx\.[\w.]+\s*;/u.test(text)) {
    throw fail('Select a Gradle Java module that explicitly requires JavaFX.');
  }
  return { name, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function planImage(root, module, metadata) {
  if (metadata?.module !== module.name || !launcherName.test(metadata?.launcher || '') ||
      ![metadata?.directory, metadata?.intermediate].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw fail('The observed :jlink task must declare a supported local JavaFX module, image and launcher.');
  }
  const build = path.join(root, 'build');
  const directories = [metadata.directory, metadata.intermediate];
  if (directories.some(value => !path.relative(build, value) || !inside(build, value)) ||
      inside(directories[0], directories[1]) || inside(directories[1], directories[0])) {
    throw fail('Use separate JavaFX image and intermediate directories below the project build directory.');
  }
  for (const value of directories) physicalChild(root, value, { directory: true, mayBeMissing: true });
  return { directory: path.normalize(metadata.directory), intermediate: path.normalize(metadata.intermediate),
    launcher: metadata.launcher, module: module.name };
}

function observeImage(root, planned, platform = process.platform) {
  const plan = planImage(root, { name: planned.module }, planned);
  const { directory, module, launcher } = plan;
  physicalChild(root, directory, { directory: true });
  const locate = (...parts) => physicalChild(root, path.join(directory, ...parts));
  const java = locate('bin', platform === 'win32' ? 'java.exe' : 'java');
  const entry = locate('bin', launcher + (platform === 'win32' ? '.bat' : ''));
  const release = locate('release'), modules = locate('lib', 'modules');
  if (release.stat.size > maxDescriptorBytes || entry.stat.size === 0 || java.stat.size === 0 || modules.stat.size < 28) {
    throw fail('The observed jlink result is missing its runtime image metadata or launcher.');
  }
  const content = fs.readFileSync(release.path, 'utf8');
  const names = /^MODULES="([^"\r\n]+)"\r?$/mu.exec(content)?.[1].split(' ') || [];
  if (!names.includes(module) || !names.some(name => /^javafx\./u.test(name))) {
    throw fail('The built image must contain the reviewed application and JavaFX modules.');
  }
  const header = Buffer.alloc(4), fd = fs.openSync(modules.path, 'r');
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
        (header.readUInt32LE() !== artifactMagic && header.readUInt32BE() !== artifactMagic)) {
      throw fail('The observed lib/modules is not a jlink runtime payload.');
    }
  } finally {
    fs.closeSync(fd);
  }
  return { directoryUri: pathToFileURL(directory).href, launcherUri: pathToFileURL(entry.path).href,
    javaUri: pathToFileURL(java.path).href, module, modulePayloadBytes: modules.stat.size };
}

module.exports = { gradleImageModel, readModule, planImage, observeImage };
