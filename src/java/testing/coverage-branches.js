'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lexJava, matching } = require('../../spring/java');
const { execute, sha } = require('./provision');
const worker = require('./branch-evidence-source.json');

function sourcePositions(text) {
  const lines = [0];
  for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) lines.push(offset + 1);
  const position = offset => {
    let start = 0, end = lines.length;
    while (end - start > 1) {
      const middle = (start + end) >> 1;
      if (lines[middle] <= offset) start = middle;
      else end = middle;
    }
    return { line: start, character: offset - lines[start] };
  };
  return { position, range: (start, end) => ({ start: position(start), end: position(end) }) };
}

function arm(tokens, start, position, range) {
  const braces = tokens[start]?.text === '{';
  const first = start + Number(braces);
  if (!['return', 'throw'].includes(tokens[first]?.text)) return null;
  let end = first + 1;
  while (tokens[end] && ![';', '{', '}'].includes(tokens[end].text)) end++;
  if (tokens[end]?.text !== ';' || braces && tokens[end + 1]?.text !== '}') return null;
  const span = range(tokens[first].start, tokens[end].end);
  if (position(tokens[end].start).line !== span.start.line) return null;
  return { range: span, next: end + 1 + Number(braces) };
}

function sourceChoices(text) {
  const { tokens, issues } = lexJava(text);
  if (issues.length || tokens.length > 50000 || /\r(?!\n)/.test(text)) return new Map();
  const { position, range } = sourcePositions(text), choices = new Map();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== 'if' || tokens[index + 1]?.text !== '(') continue;
    const close = matching(tokens, index + 1);
    if (close < 0) continue;
    const condition = range(tokens[index].start, tokens[close].end);
    if (condition.start.line !== condition.end.line ||
        tokens.slice(index + 2, close).some(token => ['?', '&', '|'].includes(token.text))) continue;
    const yes = arm(tokens, close + 1, position, range);
    const no = yes && tokens[yes.next]?.text === 'else' && arm(tokens, yes.next + 1, position, range);
    if (!no || yes.range.start.line <= condition.start.line || no.range.start.line <= yes.range.start.line) continue;
    const row = condition.start.line;
    choices.set(row, choices.has(row) ? null : { condition, then: yes.range, else: no.range });
  }
  return choices;
}

function parseCandidates(output, files) {
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines.pop() !== 'complete' || lines.length > 5000) return null;
  const candidates = [];
  for (const row of lines) {
    const [tag, index, relative, owner, method, descriptor, branch, first, firstCount, second, secondCount, ...extra] = row.split('\t');
    const numbers = [index, branch, first, firstCount, second, secondCount].map(Number);
    if (tag !== 'branch' || numbers.some(value => !Number.isSafeInteger(value) || value < 0) || extra.length ||
        !/^[\p{L}\p{N}_.$/-]+\.java$/u.test(relative || '') || relative.split('/').some(part => !part || part === '..' || part === '.') ||
        !owner || !method || !descriptor || ![branch, first, firstCount, second, secondCount].every(n => /^\d+$/.test(n)) ||
        !files[numbers[0]]) return null;
    candidates.push({ classFile: files[numbers[0]][0], relative, owner, method, descriptor, line: numbers[1] - 1,
      edges: [{ line: numbers[2] - 1, size: numbers[3] }, { line: numbers[4] - 1, size: numbers[5] }] });
  }
  return candidates;
}

async function classEvidence(config, directory, snapshot, cancellation) {
  const files = Object.entries(snapshot.classes);
  if (!files.length || files.length > 8000) return null;
  const manifest = files.map(([file, hash]) => pathToFileURL(file).href + '\t' + hash).join('\n') + '\n';
  if (Buffer.byteLength(manifest) > 4 * 1024 * 1024) return null;
  const list = path.join(directory, 'branch-evidence.tsv'), script = path.join(directory, 'BranchEvidence.java');
  await fs.writeFile(list, manifest, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(script, worker, { flag: 'wx', mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:_JAVA_OPTIONS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH)$/i.test(name)));
  const java = path.join(config.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const { output, code, cancelled, timedOut } = await execute(java, ['-Xmx128m', '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8', script, list], { cwd: directory, env, timeoutMs: 20000, cancellation });
  if (code !== 0 || cancelled || timedOut) return null;
  return parseCandidates(output, files);
}

async function readBranchEvidence(config, directory, snapshot, cancellation) {
  try {
    const candidates = await classEvidence(config, directory, snapshot, cancellation);
    if (candidates === null) return null;
    const getSource = new Map(), grouped = new Map();
    for (const candidate of candidates) {
      let source = getSource.get(candidate.relative);
      if (source === undefined) {
        const locations = [...new Set(config.sourceRoots.map(root => path.resolve(root, candidate.relative)))]
          .filter(file => Object.hasOwn(snapshot.sources, file));
        source = null;
        if (locations.length === 1) {
          const file = locations[0], info = await fs.stat(file);
          if (info.size <= 1024 * 1024) {
            const data = await fs.readFile(file);
            if (sha(data) === snapshot.sources[file]) {
              source = { uri: pathToFileURL(file).href, modified: info.mtimeMs, sha256: snapshot.sources[file], choices: sourceChoices(data.toString('utf8')) };
            }
          }
        }
        getSource.set(candidate.relative, source);
      }
      if (!source || source.modified > (await fs.stat(candidate.classFile)).mtimeMs) continue;
      const choice = source.choices.get(candidate.line);
      if (!choice) continue;
      const yes = candidate.edges.find(edge => edge.line === choice.then.start.line);
      const no = candidate.edges.find(edge => edge.line === choice.else.start.line);
      if (!yes || !no) continue;
      if (!grouped.has(source.uri)) grouped.set(source.uri, new Map());
      const byLine = grouped.get(source.uri);
      byLine.set(candidate.line, byLine.has(candidate.line) ? null : { ...candidate, ...choice, yes, no, sourceSha256: source.sha256 });
    }
    return grouped;
  } catch { return null; }
}

function applyBranchEvidence(coverage, evidence) {
  if (!evidence) return coverage;
  let decisions = 0;
  for (const file of coverage.files) {
    const candidates = evidence.get(file.uri);
    if (!candidates?.size) continue;
    const byLine = new Map(file.details.map(row => [row.line, row]));
    for (const [location, choice] of candidates) {
      if (!choice) continue;
      const { owner, method, descriptor, condition, yes, no } = choice;
      if (!file.methodDetails.some(item => item.className === owner && item.name === method &&
          item.descriptor === descriptor && item.branches.total === 2)) continue;
      const decision = byLine.get(location), first = byLine.get(yes.line), second = byLine.get(no.line);
      if (decision?.branches?.total !== 2 || !first || !second ||
          first.coveredInstructions + first.missedInstructions !== yes.size ||
          second.coveredInstructions + second.missedInstructions !== no.size ||
          decision.branches.covered !== Number(first.covered) + Number(second.covered)) continue;
      file.branchSourceSha256 = choice.sourceSha256;
      decision.branchSource = { condition, arms: [
        { label: 'then', covered: first.covered, range: choice.then },
        { label: 'else', covered: second.covered, range: choice.else }
      ] };
      decisions++;
    }
  }
  if (decisions) {
    coverage.branchLocations = 'Source ranges for verified terminal if/else arms, with JaCoCo line counts for other branches.';
    coverage.mappedBranchDecisions = decisions;
  }
  return coverage;
}

module.exports = { readBranchEvidence, applyBranchEvidence };
