'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { SaxesParser } = require('saxes');
const { micronautMavenProject } = require('./micronaut-model');
const { packagedJar } = require('./micronaut-runtime');
const { buildSpec } = require('./workbench-tasks');
const { execute } = require('./testing/provision');
const { fail, cancelled, hash, inside, LIMITS } = require('./workbench-model');

const PREFIX = 'rb-micronaut-rebuild-';
const REVIEW_LIFETIME_MS = 8 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_FILES = 1200;
const MAX_DEPTH = 24;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const SHA = bytes => createHash('sha256').update(bytes).digest('hex');
const PHYSICAL_KEYS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
const NONSTANDARD_POM_PATHS = new Set(['modules', 'systemPath', 'sourceDirectory', 'testSourceDirectory',
  'outputDirectory', 'testOutputDirectory', 'directory', 'extensions']);
const portable = value => value.split(path.sep).join('/');
const sameFile = (a, b) => PHYSICAL_KEYS.every(key => a[key] === b[key]);

function steady(cancellation) {
  if (cancelled(cancellation)) throw fail('The reviewed Micronaut restart was cancelled.');
}

function physical(file, kind, optional) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || path.relative(file, fs.realpathSync(file)) ||
      !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) {
    throw fail('Use unlinked physical files and directories for the reviewed Micronaut rebuild.');
  }
  return stat;
}

function readInput(file, maximum = MAX_FILE_BYTES) {
  const before = physical(file, 'file');
  if (before.size > BigInt(maximum)) throw fail('A Micronaut rebuild input exceeds its byte limit.');
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameFile(before, fs.fstatSync(handle, { bigint: true }))) throw fail('A rebuild input moved while being read.');
    const bytes = Buffer.alloc(Number(before.size));
    const count = fs.readSync(handle, bytes, 0, bytes.length, 0);
    if (count !== bytes.length || !sameFile(before, fs.fstatSync(handle, { bigint: true })) ||
        !sameFile(before, physical(file, 'file'))) {
      throw fail('A Micronaut rebuild input changed while being read.');
    }
    return bytes;
  } finally { fs.closeSync(handle); }
}

function singleModule(pom) {
  const lineage = [];
  let resource;
  let relativeParent = '', relativePaths = 0, elements = 0;
  const parser = new SaxesParser({ xmlns: true });
  const reject = () => { throw fail('Use a standard single-module Micronaut Maven POM with a repository parent and conventional sources.'); };
  parser.on('doctype', reject);
  parser.on('error', reject);
  parser.on('opentag', tag => {
    if (lineage.length >= 32 || ++elements > 10000) reject();
    lineage.push(tag.local);
    const from = lineage.join('/');
    const resources = /^project\/build\/(resources\/resource|testResources\/testResource)\/directory$/u.exec(from);
    const pluginExtension = /^project\/build\/(?:pluginManagement\/)?plugins\/plugin\/extensions$/u.test(from);
    if (tag.uri !== 'http://maven.apache.org/POM/4.0.0' || resource ||
        NONSTANDARD_POM_PATHS.has(tag.local) && !resources && !pluginExtension) reject();
    if (resources) resource = { path: resources[1] === 'resources/resource' ? 'src/main/resources' : 'src/test/resources', text: '' };
    if (from === 'project/parent/relativePath') relativePaths++;
  });
  const text = value => {
    if (lineage.join('/') === 'project/parent/relativePath') relativeParent += value;
    if (resource) resource.text += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    lineage.pop();
    if (resource) {
      if (![resource.path, '$'+'{project.basedir}/'+resource.path].includes(resource.text.trim())) reject();
      resource = undefined;
    }
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(pom)).close();
  if (relativePaths !== 1 || relativeParent.trim()) reject();
}

function localRepository(projectRoot, bytes) {
  const config = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^\s*-Dmaven\.repo\.local=([^\r\n"\u0000]+)\s*$/u.exec(config);
  if (!match || !path.isAbsolute(match[1]) || match[1] !== match[1].trim() ||
      /^(?:\\\\|\/\/)/u.test(match[1])) {
    throw fail('The reviewed rebuild supports only one absolute local repository option in .mvn/maven.config.');
  }
  const repository = fs.realpathSync(match[1]);
  if (!fs.statSync(repository).isDirectory() || path.relative(match[1], repository) || inside(projectRoot, repository)) {
    throw fail('Use a physical Maven dependency repository outside the build root.');
  }
  return repository;
}

function captureRestartInputs(project, cancellation, includeBytes = false) {
  steady(cancellation);
  const selected = micronautMavenProject(project);
  const root = project.root;
  const rootStat = physical(root, 'directory');
  const files = [], names = new Set();
  let bytes = 0, entries = 0, repository;
  function add(file, limit) {
    steady(cancellation);
    const name = portable(path.relative(root, file)), key = name.toLowerCase();
    if (names.has(key)) throw fail('Micronaut rebuild paths must be unique on case-insensitive filesystems.');
    names.add(key);
    const content = readInput(file, limit);
    bytes += content.length;
    if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw fail('The Micronaut source snapshot exceeds its limit.');
    files.push({ name, sha256: SHA(content), ...(includeBytes && { content }) });
    return content;
  }
  function visit(directory, level) {
    if (level > MAX_DEPTH) throw fail('The Micronaut source tree exceeds its directory depth limit.');
    physical(directory, 'directory');
    const handle = fs.opendirSync(directory);
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        steady(cancellation);
        if (++entries > MAX_ENTRIES || !/^[^<>:"/\\|?*\u0000-\u001F\u007F]{1,140}$/u.test(entry.name) ||
            /[. ]$/u.test(entry.name)) throw fail('The Micronaut source tree has unsupported paths or exceeds its entry limit.');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file, level + 1);
        else if (entry.isFile()) add(file);
        else throw fail('Use ordinary physical files and directories in the Micronaut source tree.');
      }
    } finally { handle.closeSync(); }
  }
  singleModule(add(path.join(root, 'pom.xml'), LIMITS.fileBytes));
  const configRoot = path.join(root, '.mvn');
  if (physical(configRoot, 'directory', true)) {
    const entries = fs.readdirSync(configRoot);
    if (entries.some(name => name !== 'maven.config')) {
      throw fail('The reviewed rebuild uses fixed Maven arguments and ordinary POM dependencies.');
    }
    if (entries.length) repository = localRepository(root, add(path.join(configRoot, 'maven.config'), 4096));
  }
  if (physical(path.join(root, 'src'), 'directory', true)) visit(path.join(root, 'src'), 0);
  if (!files.some(({ name }) => /^src\/main\/java\/.+\.java$/u.test(name))) {
    throw fail('The reviewed Micronaut restart requires saved Java sources under src/main/java.');
  }
  const sorted = files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const digest = hash(sorted.map(({ name, sha256 }) => [name, sha256]));
  return { ...selected, files: sorted, digest, repository, rootKey: [String(rootStat.dev), String(rootStat.ino)].join('/') };
}

function changedInputs(previous, next) {
  const prior = new Map(previous?.files.map(file => [file.name, file.sha256]));
  const now = new Map(next.files.map(file => [file.name, file.sha256]));
  const entries = [];
  for (const file of new Set([...now.keys(), ...prior.keys()])) {
    if (now.get(file) === prior.get(file)) continue;
    const action = !now.has(file) ? 'removed' : !prior.has(file) ? 'added' : 'modified';
    entries.push({ file, action });
  }
  return entries;
}

function buildFor(project, tools, repository) {
  const spec = buildSpec(project, tools, ['package']);
  spec.args.splice(-1, 0, '--offline', '-DforkCount=0', ...(repository ? ['-Dmaven.repo.local=' + repository] : []));
  for (const name of Object.keys(spec.env)) {
    if (/^(?:MAVEN_ARGS|MAVEN_OPTS|MAVEN_PROJECTBASEDIR|CLASSPATH|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/iu.test(name)) {
      delete spec.env[name];
    }
  }
  return spec;
}

function toolBinding(project, tools, repository) {
  const spec = buildFor(project, tools, repository);
  return hash([spec.command, spec.args, ...[
    spec.command, spec.args.find(arg => arg.startsWith('-Dclassworlds.conf=')).slice('-Dclassworlds.conf='.length),
    spec.args[spec.args.indexOf('-cp') + 1]
  ].map(file => {
    const stat = physical(file, 'file');
    return PHYSICAL_KEYS.map(key => String(stat[key]));
  })]);
}

async function artifactDigest(file, cancellation) {
  const before = physical(file, 'file');
  const digest = createHash('sha256');
  let header;
  for await (const bytes of fs.createReadStream(file)) {
    steady(cancellation);
    header ||= bytes.subarray(0,4);
    digest.update(bytes);
  }
  if (header?.length!==4 || header.readUInt32BE()!==0x504b0304) throw fail('The fresh Micronaut package is not a JAR.');
  if (!sameFile(before, physical(file, 'file'))) throw fail('The fresh Micronaut build artifact changed after packaging.');
  return digest.digest('hex');
}

async function buildFresh(project, tools, snapshot, cancellation, log) {
  const parent = await fsp.realpath(os.tmpdir());
  const folder = await fsp.mkdtemp(path.join(parent, PREFIX));
  const identity = physical(folder, 'directory');
  const remove = async () => {
    const current = physical(folder, 'directory');
    if (identity.dev !== current.dev || identity.ino !== current.ino ||
        path.relative(parent, path.dirname(folder)) || !path.basename(folder).startsWith(PREFIX)) {
      throw fail('The private Micronaut rebuild directory changed ownership.');
    }
    await fsp.rm(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  };
  try {
    for (const entry of snapshot.files) {
      steady(cancellation);
      if (entry.name === '.mvn/maven.config') continue; // The reviewed repository is passed as one argv value.
      const target = path.join(folder, entry.name);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.writeFile(target, entry.content, { flag: 'wx', mode: 0o600 });
    }
    const copy = { ...project, root: folder };
    const spec = buildFor(copy, tools, snapshot.repository);
    const built = await execute(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, cancellation,
      timeoutMs: LIMITS.buildMs, onOutput: log });
    steady(cancellation);
    if (built.code !== 0) throw fail('Maven did not produce a fresh Micronaut package. See Rocketbrain Micronaut output.');
    const artifact = await packagedJar(copy);
    const sha256 = await artifactDigest(artifact.file, cancellation);
    return { copy, sha256, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

function createMicronautRestart({ runtime, currentProject, currentTools, validate, log }) {
  let retained, approval;

  function remember(run, input) {
    retained = input && { runId: run.runId, input };
    approval = undefined;
  }

  function owned(runId) {
    const run = runtime.getState();
    if (run.state !== 'running' || run.kind !== 'maven-jar' || run.debug || runId && run.runId !== runId) {
      throw fail('Choose the current owned, non-debug Micronaut Maven application to restart.');
    }
    return run;
  }

  async function prepare(cancellation) {
    const run = owned();
    const project = await currentProject(run.projectUri, cancellation);
    validate(project, cancellation);
    const input = captureRestartInputs(project, cancellation);
    const tools = toolBinding(project, currentTools(project), input.repository);
    await runtime.verifyHttpTarget({ runId: run.runId, cancellation });
    validate(project, cancellation);
    owned(run.runId);
    const previous = retained?.runId === run.runId ? retained.input : undefined;
    const publicReview = {
      reviewId: randomUUID(), runId: run.runId, projectUri: run.projectUri, name: project.name,
      environment: run.environment, task: 'Maven offline package', oldBaseUrl: run.baseUrl,
      sourceDigest: input.digest, sourceCount: input.files.length, baselineObserved: !!previous,
      changes: changedInputs(previous, input)
    };
    approval = { publicReview, tools, rootKey: input.rootKey, expires: Date.now() + REVIEW_LIFETIME_MS };
    return structuredClone(publicReview);
  }

  async function apply({ reviewId, allowProjectExecution, cancellation, authorized }) {
    steady(cancellation);
    if (allowProjectExecution !== true) throw fail('Explicitly approve the reviewed Micronaut rebuild and restart.');
    if (typeof reviewId !== 'string' || !approval || approval.publicReview.reviewId !== reviewId || Date.now() >= approval.expires) {
      throw fail('Prepare a current one-use Micronaut restart review.');
    }
    const { publicReview, tools, rootKey } = approval;
    approval = undefined;
    const run = owned(publicReview.runId);
    const project = await currentProject(publicReview.projectUri, cancellation);
    const verifiedInputs = includeBytes => {
      validate(project, cancellation);
      const input = captureRestartInputs(project, cancellation, includeBytes);
      if (input.digest !== publicReview.sourceDigest || input.rootKey !== rootKey ||
          toolBinding(project, currentTools(project), input.repository) !== tools) {
        throw fail('Micronaut sources, project location or toolchain changed after review. Review and try again.');
      }
      return input;
    };
    const checkOwner = () => runtime.verifyHttpTarget({ runId: run.runId, cancellation });
    const snapshot = verifiedInputs(true);
    await checkOwner();
    authorized();
    const selectedTools = currentTools(project);
    verifiedInputs(false);
    const built = await buildFresh(project, selectedTools, snapshot, cancellation, log);
    let next;
    try {
      await checkOwner();
      authorized();
      const latest = verifiedInputs(false);
      await runtime.stop();
      authorized();
      verifiedInputs(false);
      next = await runtime.start({ project: built.copy, javaHome: selectedTools.javaHome,
        environment: run.environment, cancellation, allowProjectExecution: true, workspaceTrusted: true,
        expectedArtifactSha256: built.sha256, launchInStaging: true, verifyHttp: true });
      remember(next, latest);
      return { ...next, restartedFrom: run.runId, sourceDigest: latest.digest, previousArtifactSha256: run.sha256,
        mode: 'owned-jvm-restart', ownershipVerified: true };
    } finally {
      try { await built.remove(); }
      catch (error) {
        if (next) await runtime.stop();
        throw error;
      }
    }
  }

  return { prepare, apply, remember, forget: () => { retained = undefined; approval = undefined; } };
}

module.exports = { createMicronautRestart, captureRestartInputs };
