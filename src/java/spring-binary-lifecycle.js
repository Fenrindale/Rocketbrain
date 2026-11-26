'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { lexJava, parseJavaTokens, parseAnnotation, rangeAt } = require('../spring/java');
const { analyzeJavaSources } = require('./signature-compiler');
const { inside } = require('./workbench-model');

const ownerName = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u;
const standard = /^(?:java|javax|jakarta|org\.springframework)\./u;
const unknownMessage = 'An external annotation used on a factory with this return type has an unresolved Spring lifecycle contract.';

const modifiers = new Set(['public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native', 'strictfp', 'default']);

function returnsFactoryType(tokens, start, file, owner, simple) {
  let cursor = start;
  while (modifiers.has(tokens[cursor]?.text) || tokens[cursor]?.text === '@') {
    if (modifiers.has(tokens[cursor].text)) {
      cursor++;
      continue;
    }
    const annotation = parseAnnotation(tokens, cursor, file);
    if (!annotation) return false;
    cursor = annotation.next;
  }
  if (tokens[cursor]?.kind !== 'id') return false;
  let type = tokens[cursor++].text;
  while (tokens[cursor]?.text === '.' && tokens[cursor + 1]?.kind === 'id') {
    type += '.' + tokens[cursor + 1].text;
    cursor += 2;
  }
  return (type === owner || type === simple) && tokens[cursor]?.kind === 'id' && tokens[cursor + 1]?.text === '(';
}

function possibleFactoryAnnotations(sources, owner) {
  const files = sources.map(source => {
    const lexical = lexJava(source.text);
    return { file: parseJavaTokens(source, lexical), tokens: lexical.tokens };
  });
  const local = new Set(files.flatMap(({ file }) => file.types.map(type => type.fqn)));
  const simple = owner.slice(owner.lastIndexOf('.') + 1);
  return files.flatMap(({ file, tokens }) => {
    const result = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].text !== '@') continue;
      const annotation = parseAnnotation(tokens, index, file);
      if (!annotation) continue;
      index = annotation.next - 1;
      if (standard.test(annotation.name) || local.has(annotation.name) ||
          !returnsFactoryType(tokens, annotation.next, file, owner, simple)) continue;
      result.push({ uri: file.uri, annotation: annotation.name, range: rangeAt(file.text, annotation.start, annotation.end) });
    }
    return result;
  });
}

function observedClasspath(answer) {
  if (!Array.isArray(answer?.classpaths) || !answer.classpaths.length || answer.classpaths.length > 250 ||
      !Array.isArray(answer.modulepaths || []) || answer.modulepaths?.length) {
    throw Error('Observed Java classpath projects are required for binary Spring lifecycle review.');
  }
  const entries = [], absent = [];
  for (const input of answer.classpaths) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw Error('Absolute local Java classpaths are required.');
    let stat;
    try { stat = fs.lstatSync(input); }
    catch (error) {
      if (error.code === 'ENOENT' && !input.toLowerCase().endsWith('.jar')) {
        absent.push(input);
        continue;
      }
      throw error;
    }
    const actual = fs.realpathSync(input);
    if (stat.isSymbolicLink() || path.relative(input, actual)) throw Error('Linked Java classpaths need separate review.');
    if (!entries.some(file => !path.relative(file, actual))) entries.push(actual);
  }
  if (!entries.length) throw Error('Import compiled dependencies before reviewing binary Spring lifecycle metadata.');
  return { entries, absent };
}

function provenance(value, inputs) {
  const input = value && inputs[value.archive];
  if (!input || typeof input.file !== 'string' || !/^[\da-f]{64}$/u.test(input.sha256) ||
      typeof value.entry !== 'string' || !/^[A-Za-z_$][\w$/]*\.class$/u.test(value.entry) ||
      !/^[\da-f]{64}$/u.test(value.classSha256)) throw Error('The compiled annotation archive identity is incomplete.');
  return { archive: input.file, archiveSha256: input.sha256, entry: value.entry, classSha256: value.classSha256 };
}

function findings(analysis, result) {
  analysis.binaryLifecycle = result.report;
  for (const item of result.unknowns) {
    analysis.unknowns.push(item);
    analysis.relatedReferences.push(item);
  }
  for (const item of result.conflicts) {
    analysis.conflicts.push(item);
    analysis.relatedReferences.push(item);
  }
  if (analysis.unknowns.length) analysis.verdict = 'unknown';
  else if (analysis.conflicts.length) analysis.verdict = 'blocked';
}

async function reviewBinaryLifecycle({ analysis, sources, project, candidate, uri, cancellation, send, parseUri, runtime }) {
  const owner = analysis.declaration.owner;
  if (candidate.kind !== 'method' || !ownerName.test(owner || '')) return;
  const main = path.join(project.root, 'src/main/java');
  if (!project.sourceRoots.some(root => !path.relative(root, main)) || !inside(main, parseUri(uri).fsPath)) return;
  const java = sources.filter(source => /\.java$/iu.test(source.uri) && inside(main, parseUri(source.uri).fsPath));
  const possible = possibleFactoryAnnotations(java, owner);
  if (!possible.length) return;

  const report = { state: 'unavailable', executedProjectCode: false, source: 'observed-main-java-classpath', uses: [] };
  const result = { report, conflicts: [], unknowns: [] };
  const unavailable = (reason, sites = possible) => {
    for (const item of sites.slice(0, 64)) result.unknowns.push({
      kind: 'spring.binary-lifecycle-unresolved', uri: item.uri, range: item.range,
      message: unknownMessage, annotation: item.annotation, reason
    });
    findings(analysis, result);
  };
  if (possible.length > 64) { unavailable('review-limit'); return; }

  const metadata = () => send('workspace/executeCommand', {
    command: 'java.project.getClasspaths', arguments: [uri, { scope: 'runtime' }]
  }, cancellation);
  try {
    const answer = await metadata();
    if (!answer?.projectRoot || path.relative(project.root, fs.realpathSync(parseUri(answer.projectRoot).fsPath))) {
      throw Error('The imported binary lifecycle project boundary changed.');
    }
    const observation = observedClasspath(answer);
    const fingerprint = JSON.stringify(observation);
    const settings = await send('workspace/executeCommand', { command: 'java.project.getSettings',
      arguments: [uri, ['org.eclipse.jdt.core.compiler.compliance']] }, cancellation);
    const configured = settings?.['org.eclipse.jdt.core.compiler.compliance'];
    const release = configured ? Number(String(configured).replace(/^1\./u, '')) : 25;
    const tool = runtime?.();
    const inspected = await analyzeJavaSources({ ...tool, classpath: observation.entries, release, sources: java, cancellation,
      manifestLimit: 256 * 1024, inspection: { kind: 'binaryBeanLifecycle', owner } });
    const packet = inspected.binaryBeanLifecycle;
    if (inspected.errors?.length || !packet || packet.limitReached || !Array.isArray(packet.uses)) {
      unavailable('compiler-coverage');
      return;
    }
    const inputs = inspected.classpathEntries;
    const uses = packet.uses.map(raw => {
      const file = java.find(source => source.uri === raw.uri);
      if (!file || !Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) ||
          raw.start < 0 || raw.end <= raw.start || raw.end > file.text.length) throw Error('A lifecycle source span is stale.');
      return { annotation: raw.name, state: raw.state, uri: raw.uri, range: rangeAt(file.text, raw.start, raw.end),
        ...(raw.provenance && { provenance: provenance(raw.provenance, inputs) }), ...(raw.values && { values: raw.values }) };
    });
    report.state = 'inspected';
    report.uses = uses;
    if (Object.hasOwn(packet.springBean || {}, 'archive')) report.springBean = provenance(packet.springBean, inputs);
    if (Object.hasOwn(packet.springAliasFor || {}, 'archive')) report.springAliasFor = provenance(packet.springAliasFor, inputs);
    for (const use of uses) {
      if (use.state !== 'reviewed') {
        result.unknowns.push({ kind: 'spring.binary-lifecycle-unresolved', uri: use.uri, range: use.range,
          message: unknownMessage, annotation: use.annotation, reason: use.state, ...(use.provenance && { provenance: use.provenance }) });
        continue;
      }
      for (const lifecycle of use.values.filter(item => item.name === candidate.name)) {
        result.conflicts.push({ kind: 'spring.binary-bean-lifecycle', uri: use.uri, range: use.range,
          message: 'Safe Delete is blocked by a compiled Spring @Bean ' + lifecycle.attribute + ' contract.',
          annotation: use.annotation, lifecycle, provenance: use.provenance });
      }
    }
    const validateDisk = () => {
      if (JSON.stringify(observedClasspath(answer)) !== fingerprint) {
        throw Error('The observed Spring annotation classpath changed after review.');
      }
      inspected.validateClasspath();
    };
    const validate = async () => {
      const fresh = await metadata();
      if (!fresh?.projectRoot || path.relative(project.root, fs.realpathSync(parseUri(fresh.projectRoot).fsPath)) ||
          JSON.stringify(observedClasspath(fresh)) !== fingerprint) {
        throw Error('The observed Spring annotation classpath changed after review.');
      }
      validateDisk();
    };
    await validate();
    findings(analysis, result);
    return { validate, preApply: validateDisk };
  } catch (error) {
    if (cancellation?.isCancellationRequested) throw error;
    report.state = 'unavailable';
    report.uses = [];
    delete report.springBean;
    delete report.springAliasFor;
    result.conflicts.length = 0;
    result.unknowns.length = 0;
    unavailable('unverified-classpath');
  }
}

module.exports = { reviewBinaryLifecycle, possibleFactoryAnnotations, observedClasspath };
