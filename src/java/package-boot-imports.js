'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { lexJava, parseJavaFile, rangeAt } = require('../spring/java');

const autoConfiguration = 'org.springframework.boot.autoconfigure.AutoConfiguration';
const bean = 'org.springframework.context.annotation.Bean';
const filename = autoConfiguration + '.imports';
const importsTail = 'META-INF/spring/' + filename;
const conventionalRoots = ['src/main/resources', 'src/test/resources'];
const maxImportsBytes = 16 * 1024;
const maxCandidates = 128;
const qualifiedClass = /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const inPackage = (name, packageName) => name.startsWith(packageName + '.');

function bootImportsPath(file) {
  const normalized = file.split(path.sep).join('/');
  return conventionalRoots.some(root => normalized.endsWith('/' + root + '/' + importsTail));
}

function inProjectResources(file, projectRoot) {
  const relative = path.relative(projectRoot, file).split(path.sep).join('/');
  return conventionalRoots.some(root => relative === root + '/' + importsTail);
}

function parseImports(source) {
  const { text } = source;
  if (Buffer.byteLength(text) > maxImportsBytes || hash(text) !== source.diskHash ||
      text.startsWith('\uFEFF') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!\n)/u.test(text) ||
      (text.includes('\r\n') && /(?<!\r)\n/u.test(text))) {
    throw Error('Spring Boot imports require bounded plain UTF-8 text with consistent LF or CRLF.');
  }
  const candidates = [], names = new Set();
  for (const row of text.matchAll(/[^\r\n]+/gu)) {
    const line = row[0].split('#', 1)[0];
    const name = line.trim();
    if (!name) continue;
    if (!qualifiedClass.test(name) || names.has(name) || candidates.length >= maxCandidates) {
      throw Error('Review distinct literal Spring Boot import class names before renaming the package.');
    }
    const start = row.index + line.indexOf(name);
    candidates.push({ name, start, end: start + name.length });
    names.add(name);
  }
  return candidates;
}

function exactOwner(source, typeName) {
  const parsed = parseJavaFile(source);
  const type = parsed.types[0];
  const annotations = type?.annotations || [];
  const marker = annotations.filter(item => item.name === autoConfiguration);
  const lexed = lexJava(source.text);
  const typeIndex = lexed.tokens.findIndex(token => token.start === type?.start);
  let header = typeIndex - 2;
  while (['final', 'abstract', 'strictfp'].includes(lexed.tokens[header]?.text)) header--;
  if (parsed.issues.length || parsed.types.length !== 1 || type.fqn !== typeName || type.kind !== 'class' ||
      type.superTypes.length || lexed.tokens[header]?.text !== 'public' || marker.length !== 1 ||
      Object.keys(marker[0].attributes).length) {
    throw Error('A renamed Spring Boot import needs one exact public top-level @AutoConfiguration source without ordering attributes.');
  }
  const allowed = [marker[0], ...type.methods.flatMap(method => method.annotations.filter(item =>
    item.name === bean && !Object.keys(item.attributes).length))];
  return new Set(allowed.map(item => item.start));
}

function planBootImports({ sources, moved, projectRoot, oldPackage, newPackage }) {
  const entries = [], permissions = [], reviewedFiles = new Set(), allowedAnnotations = new Map();
  const byClass = new Map();
  let registrations = 0;
  for (const source of sources) {
    const move = moved.get(key(source.file));
    if (move) byClass.set(move.packageName + '.' + path.basename(source.file, '.java'), source);
  }
  for (const source of sources) {
    if (!inProjectResources(source.file, projectRoot) || !source.text.includes(oldPackage)) continue;
    const candidates = parseImports(source), nextNames = new Set(), edits = [];
    let next = source.text;
    for (const item of candidates) {
      let name = item.name;
      if (inPackage(name, oldPackage)) {
        const owner = byClass.get(name);
        if (!owner || name.split('.').at(-1).includes('$')) {
          throw Error('A Spring Boot import does not identify a top-level Java class in the reviewed package.');
        }
        const sourceKey = key(owner.file);
        if (!allowedAnnotations.has(sourceKey)) allowedAnnotations.set(sourceKey, exactOwner(owner, name));
        name = newPackage + name.slice(oldPackage.length);
        edits.push({ start: item.start, end: item.end, newText: name });
      }
      if (nextNames.has(name)) throw Error('Package Rename would duplicate a Spring Boot import candidate.');
      nextNames.add(name);
    }
    reviewedFiles.add(key(source.file));
    if (!edits.length) continue;
    for (const edit of [...edits].reverse()) next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
    registrations += edits.length;
    permissions.push({ uri: source.uri, beforeSha256: source.diskHash, afterSha256: hash(next) });
    entries.push({ textDocument: { uri: source.uri, version: source.version }, edits: edits.map(edit => ({
      range: rangeAt(source.text, edit.start, edit.end), newText: edit.newText
    })) });
  }
  return { entries, permissions, reviewedFiles, allowedAnnotations, registrations };
}

module.exports = { bootImportsPath, maxImportsBytes, planBootImports, parseImports, conventionalRoots, autoConfiguration };
