'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { SaxesParser } = require('saxes');

const CPE_PROJECT = 2;
const CPE_SOURCE = 3;

function localPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) return undefined;
  try {
    const result = value.startsWith('file:') ? fileURLToPath(value) : value;
    if (path.isAbsolute(result) && !/^(?:\\\\|\/\/)/.test(result)) return path.resolve(result);
  } catch { /* unavailable local path */ }
  return undefined;
}

function pathKey(value) {
  const local = localPath(value);
  return local && (process.platform === 'win32' ? local.toLowerCase() : local);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function observedOutput(value, projectRoot) {
  const candidate = localPath(value);
  if (!candidate || !isInside(projectRoot, candidate)) return undefined;
  let current = projectRoot, exists = true;
  const parts = path.relative(projectRoot, candidate).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    } catch (error) {
      if (error.code !== 'ENOENT') return undefined;
      exists = false;
      break;
    }
  }
  return { path: candidate, exists };
}

function sourceRole(projectRoot, source, entry) {
  const relative = path.relative(projectRoot, source).split(path.sep).join('/');
  const attributes = entry?.attributes;
  const generated = attributes?.generated === 'true' || attributes?.['m2e.apt.configured'] === 'true' ||
    /^(?:target\/(?:generated-sources|generated-test-sources)|build\/generated)(?:\/|$)/.test(relative);
  const test = attributes?.test === 'true' || /^(?:src\/test|target\/generated-test-sources)(?:\/|$)/.test(relative);
  const scope = test ? 'test' : attributes?.test === 'false' || /^src\/main(?:\/|$)/.test(relative) ? 'main' : 'unspecified';
  return { scope, generated };
}

function eclipseSegments(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[\\/][^\\/]/.test(value)) return [];
  const segments = value.slice(1).split(/[\\/]/);
  return segments.every(part => part && part !== '.' && part !== '..' && !/[\x00-\x1f:]/.test(part)) ? segments : [];
}

function eclipseProjectName(root) {
  try {
    const file = path.join(root, '.project'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) return undefined;
    const stack = [], names = [];
    let value = '';
    const parser = new SaxesParser();
    const directName = () => stack.length === 2 && stack[0] === 'projectDescription' && stack[1] === 'name';
    parser.on('opentag', tag => { stack.push(tag.name); if (directName()) value = ''; });
    parser.on('text', text => { if (directName()) value += text; });
    parser.on('closetag', () => { if (directName()) names.push(value.trim()); stack.pop(); });
    parser.write(text).close();
    if (names.length === 1 && names[0] && names[0].length <= 255 && !/[\\/:\x00-\x1f]/.test(names[0])) return names[0];
  } catch { /* the language server may not write project metadata into the source tree */ }
  return undefined;
}

function describeSourceLayout(project, entries, defaultLocation) {
  const byPath = new Map(), outputs = new Map();
  const required = new Set();
  if (Array.isArray(entries)) {
    for (const entry of entries.slice(0, 2000)) {
      if (entry?.kind === CPE_PROJECT) {
        const parts = eclipseSegments(entry.path);
        if (parts.length === 1) required.add(parts[0]);
      }
      if (entry?.kind !== CPE_SOURCE) continue;
      const key = pathKey(entry.path);
      if (key) byPath.set(key, entry);
    }
  }
  const addOutput = (location, root, usesDefault) => {
    const output = observedOutput(location, project.root);
    if (!output) return;
    const key = pathKey(output.path);
    if (!outputs.has(key)) outputs.set(key, { ...output, default: usesDefault, sourceRootIds: [], scopes: [] });
    const recorded = outputs.get(key);
    if (root) {
      recorded.sourceRootIds.push(root.id);
      if (!recorded.scopes.includes(root.scope)) recorded.scopes.push(root.scope);
    }
    return output.path;
  };
  addOutput(defaultLocation, null, true);
  for (const root of project.sourceRoots) {
    if (root.unavailable || !isInside(project.root, root.path)) continue;
    const entry = byPath.get(pathKey(root.path));
    const role = sourceRole(project.root, root.path, entry);
    Object.assign(root, role, { layoutSource: entry ? 'jdt-classpath' : 'source-root' });
    if (entry) root.outputPath = addOutput(entry.output || defaultLocation, root, !entry.output);
  }
  project.outputRoots = [...outputs.values()];
  project.eclipseName = eclipseProjectName(project.root);
  project.eclipseReferences = [...required];
}

function bindProjectOutputs(projects) {
  const owners = new Map(), names = new Map();
  for (const project of projects) {
    if (project.eclipseName) {
      if (!names.has(project.eclipseName)) names.set(project.eclipseName, []);
      names.get(project.eclipseName).push(project);
    }
    for (const output of project.outputRoots) {
      const key = pathKey(output.path);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(project);
    }
  }
  for (const project of projects) {
    for (const library of project.libraries) {
      const candidates = owners.get(pathKey(library.path));
      let owner, output;
      if (candidates?.size === 1) {
        [owner] = candidates;
        output = library.path;
      } else if (!candidates) {
        const [name, ...segments] = eclipseSegments(library.path);
        const logical = names.get(name);
        if (segments.length && project.eclipseReferences.includes(name) && logical?.length === 1) {
          const [candidate] = logical;
          const absolute = path.join(candidate.root, ...segments);
          if (candidate.outputRoots.some(item => pathKey(item.path) === pathKey(absolute))) {
            owner = candidate;
            output = absolute;
          }
        }
      }
      if (owner && owner.id !== project.id) library.projectDependency = { id: owner.id, name: owner.name, output };
    }
  }
}

module.exports = { describeSourceLayout, bindProjectOutputs, observedOutput };
