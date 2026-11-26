'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('./workbench-tasks');
const { execute } = require('./testing/provision');
const { pomFacts } = require('./dependency-builds');
const { cancelled, fail, inside, workspacePath } = require('./workbench-model');

const pluginVersion = '3.11.0';
const goal = 'org.apache.maven.plugins:maven-dependency-plugin:' + pluginVersion + ':tree';
const limit = 2 * 1024 * 1024;
const component = /^[A-Za-z0-9_.$+-]{1,180}$/u;
const knownScopes = new Set(['compile', 'provided', 'runtime', 'test', 'system', 'import']);
const descriptorNames = ['pom.xml', '.mvn/maven.config', '.mvn/jvm.config', '.mvn/extensions.xml'];

function coordinate(text, root = false) {
  const pieces = text.split(':');
  const minimum = root ? 4 : 5;
  if (pieces.length < minimum || pieces.length > minimum + 1 || pieces.some(part => !component.test(part))) {
    throw fail('Maven returned an unsupported dependency coordinate.');
  }
  const scope = root ? '' : pieces.pop(), version = pieces.pop();
  if (!root && !knownScopes.has(scope)) throw fail('Maven returned an unrecognized dependency scope.');
  const [group, artifact, type, classifier = ''] = pieces;
  return { group, artifact, type, classifier, version, scope };
}

const key = value => [value.group, value.artifact, value.type, value.classifier].join(':');
const display = value => [value.group, value.artifact, value.type, value.classifier, value.version, value.scope].filter(Boolean).join(':');

function branch(text) {
  const omitted = text.startsWith('(');
  if (omitted && !text.endsWith(')')) throw fail('Maven returned an incomplete omitted dependency.');
  const body = omitted ? text.slice(1, -1) : text;
  const marker = omitted ? body.lastIndexOf(' - omitted for ') : -1;
  if (omitted && marker < 0) throw fail('Maven did not identify why this dependency was omitted.');
  const payload = marker < 0 ? body : body.slice(0, marker);
  const parsed = /^(\S+)(?: \(([^)]{1,500})\))?$/u.exec(payload);
  if (!parsed) throw fail('Maven returned an unsupported verbose dependency line.');
  const note = parsed[2] || '';
  const reason = marker < 0 ? '' : body.slice(marker + ' - omitted for '.length);
  const managed = /(?:^|; )version managed from ([A-Za-z0-9_.$+-]{1,180})(?:; |$)/u.exec(note)?.[1];
  const conflict = /^conflict with ([A-Za-z0-9_.$+-]{1,180})$/u.exec(reason)?.[1];
  let state = 'selected';
  if (omitted) {
    state = conflict ? 'conflict' : reason === 'duplicate' ? 'duplicate' : reason === 'cycle' ? 'cycle' : 'omitted';
  }
  return { ...coordinate(parsed[1]), state, ...(note && { note }), ...(managed && { managedFrom: managed }),
    ...(reason && { reason }), ...(conflict && { winnerVersion: conflict }) };
}

function parseMavenResolution(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw fail('The Maven dependency report is invalid or exceeds its size limit.');
  }
  const lines = text.replace(/^\uFEFF/u, '').trimEnd().split(/\r?\n/u);
  if (lines.length > 5001) throw fail('The Maven dependency report exceeds 5,000 paths.');
  const root = coordinate(lines[0], true), nodes = [], stack = [], selected = new Map();
  for (const line of lines.slice(1)) {
    const input = /^((?:\| {2}| {3})*)(?:\+- |\\- )(.*)$/u.exec(line);
    const depth = input && input[1].length / 3;
    if (!input || depth > 63 || depth > stack.length) throw fail('Maven returned an incomplete dependency path.');
    const parent = depth ? stack[depth - 1] : undefined;
    if (parent && parent.state !== 'selected') throw fail('Maven returned children of an omitted dependency.');
    const value = branch(input[2]), node = { ...value, id: nodes.length + 1, parentId: parent?.id || 0, depth };
    stack.length = depth;
    stack.push(node);
    nodes.push(node);
    if (node.state === 'selected') {
      const identity = key(node);
      selected.set(identity, [...(selected.get(identity) || []), node]);
    }
  }
  for (const node of nodes) {
    if (!['conflict', 'duplicate'].includes(node.state)) continue;
    const version = node.winnerVersion || node.version;
    const candidates = (selected.get(key(node)) || []).filter(option => option.version === version);
    if (candidates.length === 1) node.winnerId = candidates[0].id;
  }
  return { root, nodes };
}

async function physicalFile(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || path.relative(file, await fs.realpath(file))) {
    throw fail('Use bounded physical Maven descriptor and report files.');
  }
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) throw fail('A Maven descriptor or report grew beyond its limit.');
  return bytes;
}

async function descriptorInputs(project, boundary, dirty) {
  const values = [];
  let folder = project.root;
  for (let depth = 0; depth < 24 && inside(boundary, folder); depth++) {
    for (const relative of descriptorNames) {
      const file = path.join(folder, relative);
      let bytes;
      try { bytes = await physicalFile(file, 1024 * 1024); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (dirty(file)) throw fail('Save the Maven POM and project configuration before inspecting resolution.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      values.push({ file, sha: createHash('sha256').update(bytes).digest('hex'),
        ...(relative === 'pom.xml' && { facts: pomFacts({ path: file, uri: pathToFileURL(file).href, text }) }) });
    }
    if (!path.relative(folder, boundary)) return values;
    folder = path.dirname(folder);
  }
  throw fail('The imported Maven project is too deeply nested in its workspace.');
}

function addPomAnchors(report, descriptors, project) {
  const root = descriptors.find(item => !path.relative(item.file, path.join(project.root, 'pom.xml')))?.facts;
  if (!root || root.gav.artifact !== report.root.artifact || root.gav.group && root.gav.group !== report.root.group ||
      root.gav.version && root.gav.version !== report.root.version) {
    throw fail('Maven resolved a different project than the selected POM.');
  }
  const knownPoms = descriptors.flatMap(item => item.facts ? [item.facts] : []);
  for (const node of report.nodes) {
    const anchors = [];
    const direct = root.dependencies.filter(dep => key(dep) === key(node));
    if (node.parentId === 0 && direct.length === 1) anchors.push({
      kind: 'direct', uri: root.file.uri, range: direct[0].range
    });
    if (node.managedFrom) {
      const matches = knownPoms.flatMap(pom => pom.managedDependencies.filter(dep =>
        key(dep) === key(node) && dep.version === node.version).map(dep => ({ kind: 'managed', uri: pom.file.uri, range: dep.range })));
      if (matches.length === 1) anchors.push(matches[0]);
    }
    if (anchors.length) node.pomAnchors = anchors;
  }
  return report;
}

async function inspectMavenResolution({ project, tools, workspaceRoot, allowProjectExecution, cancellation,
  dirty = () => false, trusted, runner = execute }) {
  trusted();
  if (allowProjectExecution !== true) throw fail('Choose Inspect Maven Dependency Resolution before executing project code.');
  if (project?.tool !== 'maven' || path.relative(project.root, workspacePath(project.root, [workspaceRoot]))) {
    throw fail('Choose an imported local Maven project.');
  }
  const descriptors = await descriptorInputs(project, workspaceRoot, dirty);
  if (!descriptors.some(item => !path.relative(item.file, path.join(project.root, 'pom.xml')))) {
    throw fail('Choose the saved Maven POM of the imported project.');
  }
  const validate = async () => {
    trusted();
    if (cancelled(cancellation)) throw fail('Maven dependency inspection was cancelled.');
    const fresh = await descriptorInputs(project, workspaceRoot, dirty);
    if (JSON.stringify(fresh.map(({ file, sha }) => [file, sha])) !== JSON.stringify(descriptors.map(({ file, sha }) => [file, sha]))) {
      throw fail('The Maven project descriptors changed. Inspect dependency resolution again.');
    }
  };
  const parent = await fs.realpath(os.tmpdir()), stage = await fs.mkdtemp(path.join(parent, 'rb-maven-tree-'));
  const identity = await fs.lstat(stage, { bigint: true });
  try {
    const target = path.join(stage, 'dependency-tree.txt'), spec = buildSpec(project, tools, [goal]);
    const options = { cwd: spec.cwd, env: spec.env, cancellation, timeoutMs: 90000 };
    const args = [...spec.args, '--non-recursive', '--show-version', '-Dstyle.color=never', '-Dverbose=true', '-Dtokens=standard',
      '-DoutputType=text', '-DoutputEncoding=UTF-8', '-DappendOutput=false', '-DoutputFile=' + target];
    const result = await runner(spec.command, args, options);
    await validate();
    if (result.cancelled || result.timedOut || result.code !== 0) {
      throw fail('Maven did not complete dependency resolution. Resolve the selected project and retry.');
    }
    const stdout = String(result.output || '').replace(/\u001b\[[0-9;]*m/gu, '');
    const version = /(?:^|\n)Apache Maven ([A-Za-z0-9_.-]+)(?=\s|$)/u.exec(stdout)?.[1];
    if (!version) throw fail('Maven did not report the version of the running launcher.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await physicalFile(target, limit));
    const report = addPomAnchors(parseMavenResolution(text), descriptors, project);
    await validate();
    return { ...report, mavenVersion: version, dependencyPlugin: pluginVersion, validate };
  } finally {
    const real = await fs.realpath(stage), current = await fs.lstat(real, { bigint: true });
    if (path.relative(stage, real) || path.relative(parent, path.dirname(real)) || !path.basename(real).startsWith('rb-maven-tree-') ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw fail('The Maven report staging directory changed ownership.');
    await fs.rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}

module.exports = { inspectMavenResolution, parseMavenResolution, printCoordinate: display, goal };
