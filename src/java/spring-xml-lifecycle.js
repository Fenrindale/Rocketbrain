'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SaxesParser } = require('saxes');
const { rangeAt } = require('../spring/java');
const { inside } = require('./workbench-model');
const { analyzeJavaSources, visitJar } = require('./signature-compiler');
const { observedClasspath } = require('./spring-binary-lifecycle');

const RESOURCE_UNKNOWN = 'spring.external-registration-resource';
const SPRING_ENTRY = 'org/springframework/context/annotation/ImportResource.class';
const BEANS = 'http://www.springframework.org/schema/beans';
const SCHEMAS = new Set(['http', 'https'].map(scheme => BEANS + ' ' + scheme + '://www.springframework.org/schema/beans/spring-beans.xsd'));
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const MAX_XML = 128 * 1024;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_FINDINGS = 256;
const boundedName = /^[A-Za-z_$][\w$]{0,127}$/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = reason => Error('Spring XML lifecycle review: ' + reason);

function resourceEntry(location) {
  if (typeof location !== 'string' || !location.startsWith('classpath:')) return undefined;
  const entry = location.slice(10);
  if (entry.length <= 180 && entry.endsWith('.xml') &&
      entry.split('/').every(part => /^[A-Za-z0-9_][\w.-]{0,63}$/u.test(part) && !part.endsWith('.'))) return entry;
}

// Admit an entirely known document rather than extracting names from unknown XML behavior.
function readLifecycleXml(bytes, owner) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_XML) throw unavailable('resource-size-limit');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.startsWith('\uFEFF')) throw unavailable('unsupported-xml-encoding');
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  const definitions = new Map();
  let depth = 0;
  const unsupported = () => { throw unavailable('unsupported-xml'); };
  for (const event of ['doctype', 'processinginstruction', 'cdata', 'error']) parser.on(event, unsupported);
  parser.on('xmldecl', declaration => {
    if (declaration.version !== '1.0' || declaration.encoding && !/^utf-8$/iu.test(declaration.encoding)) unsupported();
  });
  parser.on('text', content => { if (/[^ \t\n\r]/u.test(content)) unsupported(); });
  parser.on('opentag', tag => {
    depth++;
    const attributes = Object.values(tag.attributes);
    if (tag.uri !== BEANS || tag.prefix !== '') unsupported();
    if (depth === 1 && tag.local === 'beans') {
      if (attributes.some(item => !(item.uri === XMLNS &&
          (item.name === 'xmlns' && item.value === BEANS || item.name === 'xmlns:xsi' && item.value === XSI) ||
          item.uri === XSI && item.name === 'xsi:schemaLocation' &&
          SCHEMAS.has(item.value.trim().replace(/[ \t\n\r]+/gu, ' '))))) unsupported();
      return;
    }
    if (depth !== 2 || tag.local !== 'bean' || definitions.size >= 128 || attributes.some(item =>
      item.uri !== '' || !['id', 'class', 'abstract', 'parent', 'init-method', 'destroy-method'].includes(item.name))) unsupported();
    const opening = text.lastIndexOf('<', parser.position - 1);
    const raw = text.slice(opening, parser.position);
    const literal = new Map([...raw.matchAll(/\s(id|class|abstract|parent|init-method|destroy-method)\s*=\s*(["'])([^"']*)\2/dgu)]
      .map(match => [match[1], { value: match[3], offset: match.indices[3][0], end: match.indices[3][1] }]));
    if (attributes.some(item => literal.get(item.name)?.value !== item.value)) unsupported();
    const id = literal.get('id')?.value, declaredOwner = literal.get('class')?.value;
    const parent = literal.get('parent')?.value, abstract = literal.get('abstract')?.value;
    const beanId = /^[A-Za-z_$][\w$.-]{0,127}$/u;
    if (!beanId.test(id || '') || definitions.has(id) || parent !== undefined && !beanId.test(parent) ||
        abstract !== undefined && !['true', 'false'].includes(abstract) ||
        declaredOwner !== undefined && declaredOwner !== owner || !parent && !declaredOwner) unsupported();
    const callbacks = new Map();
    for (const attribute of ['init-method', 'destroy-method']) {
      const matched = literal.get(attribute);
      if (!matched) continue;
      if (!boundedName.test(matched.value)) unsupported();
      callbacks.set(attribute, { id, owner, attribute, name: matched.value,
        range: rangeAt(text, opening + matched.offset, opening + matched.end) });
    }
    definitions.set(id, { parent, abstract: abstract === 'true', callbacks });
  });
  parser.on('closetag', () => { depth--; });
  parser.write(text).close();
  if (depth !== 0 || definitions.size === 0) unsupported();

  const resolving = new Set(), resolved = new Map();
  const resolve = id => {
    if (resolved.has(id)) return resolved.get(id);
    const bean = definitions.get(id);
    if (!bean || resolving.has(id)) unsupported();
    resolving.add(id);
    const inherited = bean.parent ? resolve(bean.parent) : new Map();
    const merged = new Map(inherited);
    for (const [kind, callback] of bean.callbacks) merged.set(kind, callback);
    resolving.delete(id);
    resolved.set(id, merged);
    return merged;
  };
  const callbacks = [], used = new Set();
  for (const [id, bean] of definitions) {
    const effective = resolve(id);
    if (bean.abstract) continue;
    for (const callback of effective.values()) {
      used.add(callback);
      callbacks.push(callback.id === id ? callback : { ...callback, id, declaredOn: callback.id });
    }
  }
  // An abstract name remains a contract for consumers which inherit it outside this document.
  for (const bean of definitions.values()) {
    for (const callback of bean.callbacks.values()) {
      if (!used.has(callback)) callbacks.push({ ...callback, templateOnly: true });
    }
  }
  return callbacks;
}

function optionalStat(file) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return undefined;
  }
}

function directoryShadows(entries, keys, ownerEntry, projectRoot) {
  let ownerOutput;
  for (const file of entries) {
    if (!fs.statSync(file).isDirectory()) continue;
    for (const key of keys) {
      if (optionalStat(path.join(file, key))) throw unavailable('competing-classpath-directory-resource');
    }
    const outputFile = path.join(file, ownerEntry);
    const output = optionalStat(outputFile);
    if (output) {
      if (ownerOutput || !output.isFile() || !inside(projectRoot, fs.realpathSync(outputFile))) {
        throw unavailable('competing-classpath-directory-owner');
      }
      ownerOutput = outputFile;
    }
  }
}

function reviewedArchive(input) {
  const descriptor = fs.openSync(input.file, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE) throw unavailable('archive-size-limit');
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const size = fs.readSync(descriptor, bytes, offset, bytes.length - offset);
      if (!size) throw unavailable('archive-changed');
      offset += size;
    }
    if (hash(bytes) !== input.sha256 || fs.fstatSync(descriptor).size !== stat.size) throw unavailable('archive-changed');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function selfContainedJarIndex(bytes, file) {
  const index = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/gu, '\n').trimEnd();
  const lines = index.split('\n');
  return lines[0] === 'JarIndex-Version: 1.0' && lines[1] === '' && lines[2] === path.basename(file) &&
    lines.slice(3).every(line => /^[A-Za-z0-9_.$/-]+$/u.test(line) && !line.endsWith('.jar'));
}

async function readObservedEntries(inputs, keys, ownerEntry, projectRoot, cancellation) {
  const files = new Map(), selected = new Map(keys.map(key => [key.toLowerCase(), key]));
  const binaryOwner = ownerEntry.toLowerCase();
  directoryShadows(inputs.map(input => input.file), keys, ownerEntry, projectRoot);
  for (const input of inputs) {
    if (cancellation?.isCancellationRequested) throw unavailable('cancelled');
    if (fs.statSync(input.file).isDirectory()) continue;
    // Parse only bytes whose archive hash matches the independent compiler's classpath snapshot.
    await visitJar(reviewedArchive(input), async (entry, read) => {
      const name = entry.fileName, lower = name.toLowerCase();
      if (lower === 'meta-inf/index.list') {
        // This older JAR metadata may exist even on modern project classpaths.
        // Permit only a self-index, which does not introduce another archive.
        if (entry.uncompressedSize > MAX_XML || !selfContainedJarIndex(await read(), input.file)) throw unavailable('indirect-classpath');
        return;
      }
      if (lower === 'meta-inf/manifest.mf') {
        if (entry.uncompressedSize > 4 * 1024 * 1024) throw unavailable('manifest-size-limit');
        const main = (await read()).toString('utf8').replace(/\r\n?/gu, '\n').split('\n\n', 1)[0].replace(/\n /gu, '');
        if (/^class-path\s*:/imu.test(main)) throw unavailable('indirect-classpath');
        return;
      }
      const versioned = /^meta-inf\/versions\/[^/]+\/(.+)$/u.exec(lower)?.[1];
      if (lower === binaryOwner || versioned === binaryOwner) throw unavailable('competing-classpath-jar-owner');
      if (versioned && selected.has(versioned)) throw unavailable('versioned-classpath-resource');
      const key = selected.get(lower);
      if (!key) return;
      if (key !== name || files.has(key)) throw unavailable('competing-classpath-jar-resource');
      if (entry.uncompressedSize > MAX_XML) throw unavailable('resource-size-limit');
      const bytes = await read();
      if (!/^[a-f\d]{64}$/u.test(input.sha256 || '')) throw unavailable('unverified-archive-origin');
      files.set(key, { bytes, archive: input.file, archiveSha256: input.sha256, entry: name, entrySha256: hash(bytes) });
    });
  }
  return files;
}

function validSpan(value, file) {
  return Number.isSafeInteger(value?.start) && Number.isSafeInteger(value?.end) &&
    value.start >= 0 && value.end > value.start && value.end <= file.text.length;
}

function sameRange(a, b) {
  return a.start.line === b.start.line && a.start.character === b.start.character &&
    a.end.line === b.end.line && a.end.character === b.end.character;
}

function addBindings(analysis, matched, report, conflicts) {
  const resolved = item => item.kind === RESOURCE_UNKNOWN && matched.some(site => site.uri === item.uri && sameRange(site.range, item.range));
  analysis.binaryResourceLifecycle = report;
  analysis.unknowns = analysis.unknowns.filter(item => !resolved(item));
  analysis.relatedReferences = analysis.relatedReferences.filter(item => !resolved(item));
  analysis.conflicts.push(...conflicts);
  analysis.relatedReferences.push(...conflicts);
  analysis.verdict = analysis.unknowns.length ? 'unknown' : analysis.conflicts.length ? 'blocked' : 'allowed';
}

async function reviewBinaryResourceLifecycle({ analysis, sources, project, candidate, uri, cancellation, send, parseUri, runtime }) {
  const unknowns = analysis.unknowns.filter(item => item.kind === RESOURCE_UNKNOWN);
  const main = path.join(project.root, 'src/main/java');
  if (!unknowns.length || candidate.kind !== 'method' || candidate.eligibilityConflicts.length ||
      !analysis.declaration.owner || !project.sourceRoots.some(root => !path.relative(root, main)) ||
      !inside(main, parseUri(uri).fsPath)) return;
  const report = { state: 'unresolved', executedProjectCode: false, source: 'observed-main-java-classpath', uses: [] };
  analysis.binaryResourceLifecycle = report;
  const metadata = () => send('workspace/executeCommand', {
    command: 'java.project.getClasspaths', arguments: [uri, { scope: 'runtime' }]
  }, cancellation);
  const observationOf = answer => {
    if (!answer?.projectRoot || path.relative(project.root, fs.realpathSync(parseUri(answer.projectRoot).fsPath))) {
      throw unavailable('classpath-project-changed');
    }
    return observedClasspath(answer);
  };
  try {
    const answer = await metadata();
    const observation = observationOf(answer), fingerprint = JSON.stringify(observation);
    const java = sources.filter(source => /\.java$/iu.test(source.uri) && inside(main, parseUri(source.uri).fsPath));
    const selected = java.find(file => file.uri === uri);
    const position = candidate.declarationRange.start;
    const offset = selected?.text.split('\n').slice(0, position.line).reduce((size, line) => size + line.length + 1, position.character);
    const settings = await send('workspace/executeCommand', { command: 'java.project.getSettings',
      arguments: [uri, ['org.eclipse.jdt.core.compiler.compliance']] }, cancellation);
    const configured = settings?.['org.eclipse.jdt.core.compiler.compliance'];
    const release = configured ? Number(String(configured).replace(/^1\./u, '')) : 25;
    const inspected = await analyzeJavaSources({ ...runtime?.(), classpath: observation.entries, release, sources: java,
      manifestLimit: 256 * 1024, cancellation, inspection: { kind: 'springResourceImports', uri, offset, name: candidate.name } });
    const packet = inspected.springResourceImports;
    const target = packet?.target;
    if (inspected.errors?.length || !packet || packet.limitReached || target.owner !== analysis.declaration.owner ||
        target.uri !== uri || !validSpan(target, selected) || target.name !== candidate.name || target.start !== offset ||
        target.end !== offset + candidate.name.length) throw unavailable('compiler-coverage');
    const uses = packet.uses.flatMap(use => {
      const file = java.find(item => item.uri === use.uri);
      if (!file || !validSpan(use, file)) return [];
      const range = rangeAt(file.text, use.start, use.end);
      if (!unknowns.some(item => item.uri === use.uri && sameRange(item.range, range))) return [];
      const entries = use.locations.map(resourceEntry);
      return entries.every(Boolean) ? [{ uri: use.uri, range, entries }] : [];
    });
    const keys = [...new Set([SPRING_ENTRY, ...uses.flatMap(use => use.entries)])];
    if (!uses.length || keys.length > 64 || new Set(keys.map(key => key.toLowerCase())).size !== keys.length) {
      throw unavailable('unsupported-resource-location');
    }
    const ownerEntry = target.owner.replaceAll('.', '/') + '.class';
    const files = await readObservedEntries(inspected.classpathEntries, keys, ownerEntry, project.root, cancellation);
    const annotation = files.get(SPRING_ENTRY);
    if (!annotation || annotation.archive !== inspected.classpathEntries[packet.springArchive]?.file) {
      throw unavailable('unverified-spring-annotation-origin');
    }
    const matches = [], conflicts = [], inspectedResources = new Map();
    let findings = 0;
    for (const site of uses) {
      const registrations = [];
      try {
        for (const entry of site.entries) {
          const found = files.get(entry);
          if (!found) throw unavailable('missing-resource');
          if (!inspectedResources.has(entry)) {
            const { bytes, ...provenance } = found;
            inspectedResources.set(entry, { provenance, callbacks: readLifecycleXml(bytes, target.owner) });
          }
          registrations.push(inspectedResources.get(entry));
        }
      } catch { continue; }
      findings += 1 + registrations.reduce((count, registration) => count + 1 + registration.callbacks.length, 0);
      if (findings > MAX_FINDINGS) throw unavailable('review-limit');
      matches.push(site);
      report.uses.push({ uri: site.uri, range: site.range, resources: registrations });
      for (const { provenance, callbacks } of registrations) {
        for (const callback of callbacks.filter(item => item.name === target.name)) {
          conflicts.push({ kind: 'spring.binary-xml-lifecycle', uri: site.uri, range: site.range,
            message: 'Safe Delete is blocked by a Spring XML ' + callback.attribute + ' callback for this Java declaration.',
            provenance, callback, declaration: analysis.declaration, signature: target.signature });
        }
      }
    }
    if (!matches.length) throw unavailable('no-reviewed-resource');
    const validateDisk = () => {
      if (JSON.stringify(observationOf(answer)) !== fingerprint) throw unavailable('classpath-membership-changed');
      directoryShadows(observation.entries, keys, ownerEntry, project.root);
      inspected.validateClasspath();
    };
    const validate = async () => {
      if (JSON.stringify(observationOf(await metadata())) !== fingerprint) throw unavailable('classpath-membership-changed');
      validateDisk();
    };
    await validate();
    const { bytes: annotationBytes, ...provenance } = annotation;
    report.springAnnotation = provenance;
    report.state = 'inspected';
    addBindings(analysis, matches, report, conflicts);
    return { validate, preApply: validateDisk };
  } catch (error) {
    if (cancellation?.isCancellationRequested) throw error;
    report.uses = [];
    report.reason = /^Spring XML lifecycle review: ([a-z-]+)$/u.exec(error.message)?.[1] || 'unverified-classpath';
  }
}

module.exports = { resourceEntry, readLifecycleXml, selfContainedJarIndex, reviewBinaryResourceLifecycle };
