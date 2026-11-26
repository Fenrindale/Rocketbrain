'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile, spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createJavaMountMapping } = require('../src/devcontainer/java-mapping');
const { checkedFormatter, createContainerJavaLsp, boundedMessages } = require('../src/devcontainer/java-lsp');
const { createDevContainers } = require('../src/devcontainer/runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');

const toolProtocol = createRequire(require.resolve('vscode-languageclient/node'))('vscode-languageserver-protocol/node');
const execute = promisify(execFile);
const localJdk = process.env.ROCKETBRAIN_CONTAINER_JAVA_TEST_LOCAL_JDK;
const localJdt = process.env.ROCKETBRAIN_CONTAINER_JAVA_TEST_LOCAL_JDT;
const cliPath = process.env.ROCKETBRAIN_DEVCONTAINER_CLI_PATH;
const dockerLive = process.env.ROCKETBRAIN_DEVCONTAINER_JAVA_LIVE === 'true';
const receiptPath = process.env.ROCKETBRAIN_DEVCONTAINER_JAVA_RECEIPT;
const guestRoot = '/workspaces/container-java';
const sourceText = 'package fixture; public class Example { Target field = new Target();  }\n';
const position = { line: 0, character: sourceText.indexOf('Target') + 1 };

async function ownedFiles(context) {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-container-jdt-'));
  assert.equal(path.dirname(owned), parent);
  assert.match(path.basename(owned), /^rb-container-jdt-/u);
  context.after(async () => {
    assert.equal(await fs.realpath(owned), owned);
    await fs.rm(owned, { recursive: true, force: true });
  });
  const root = path.join(owned, 'project');
  await fs.cp(path.join(__dirname, 'fixtures', 'devcontainer', 'java'), root, { recursive: true });
  return { owned, root, example: path.join(root, 'src', 'fixture', 'Example.java'), target: path.join(root, 'src', 'fixture', 'Target.java') };
}

test('Container Java source mapping permits exact mounted Java files and refuses alternate namespaces and path escape', async context => {
  const { root, owned, target } = await ownedFiles(context);
  const binds = [{ Type: 'bind', Source: root, Destination: guestRoot }];
  const mapping = createJavaMountMapping(root, guestRoot, binds);
  assert.equal(mapping.workspaceUri, 'file://' + guestRoot);
  assert.equal(mapping.toRemote(target), 'file://' + guestRoot + '/src/fixture/Target.java');
  assert.equal(mapping.toHost(mapping.toRemote(target)), target);
  for (const name of ['jdt://contents/Target.java', 'file:///tmp/Target.java', 'file://' + guestRoot + '-alt/Target.java',
    'file://' + guestRoot + '/%2e%2e/src/fixture/Target.java', 'file://' + guestRoot + '/src%2Ffixture/Target.java',
    'file://' + guestRoot + '/src/fixture/Target.java?query', 'file://remote' + guestRoot + '/src/fixture/Target.java']) {
    assert.throws(() => mapping.toHost(name), /workspace|URI/u);
  }
  assert.throws(() => createJavaMountMapping(root, guestRoot, [{ ...binds[0], Source: owned }]), /exact local workspace/);
  assert.throws(() => createJavaMountMapping(root, guestRoot, [...binds, { Destination: guestRoot + '/src' }]), /nested mounts/);
  await fs.symlink(owned, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => mapping.toHost('file://' + guestRoot + '/alias/project/src/fixture/Target.java'), /physical Java source/);
  const unicode = path.join(root, '자료 폴더.java');
  await fs.writeFile(unicode, 'class Example {}');
  assert.equal(mapping.toHost(mapping.toRemote(unicode)), unicode);
});

test('Container Java rejects oversized protocol messages and malformed, overlapping and out-of-bounds formatting', async () => {
  const framed = boundedMessages();
  const rejected = once(framed, 'error');
  framed.write('Content-Length: 9999999\r\n\r\n');
  assert.match((await rejected)[0].message, /protocol limit/);
  const range = (start, end) => ({ start: { line: 0, character: start }, end: { line: 0, character: end } });
  assert.deepEqual(checkedFormatter('a  b\r\nc', [{ range: range(1, 3), newText: ' ' }]), { before: 'a  b\r\nc', after: 'a b\r\nc' });
  assert.throws(() => checkedFormatter('abc', [{ range: range(0, 9), newText: '' }]), /source range/);
  assert.throws(() => checkedFormatter('abc', [{ range: range(0, 2), newText: '' }, { range: range(1, 3), newText: '' }]), /overlap/);
});

test('Container Java rejects server-initiated workspace edits and remaps only physical locations in its mount', async context => {
  const { root, example, target } = await ownedFiles(context);
  const mapping = createJavaMountMapping(root, guestRoot, [{ Type: 'bind', Source: root, Destination: guestRoot }]);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    kill() { this.emit('close'); } });
  const server = toolProtocol.createProtocolConnection(new toolProtocol.StreamMessageReader(child.stdin),
    new toolProtocol.StreamMessageWriter(child.stdout));
  const open = new Promise(resolve => { server.onNotification('textDocument/didOpen', resolve); });
  server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: { openClose: true, change: 2 } } }));
  server.onRequest('shutdown', () => null);
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  server.onRequest('textDocument/definition', () => [
    { uri: 'file:///tmp/escape.java', range }, { uri: mapping.toRemote(target), range }
  ]);
  server.listen();
  const lsp = createContainerJavaLsp({ protocol: toolProtocol, child, mapping, settings: serverSettings() });
  try {
    await lsp.initialize();
    assert.deepEqual(await server.sendRequest('workspace/applyEdit', { edit: { changes: {
      [mapping.toRemote(target)]: [{ range, newText: 'unsafe unsolicited edit' }]
    } } }), { applied: false, failureReason: 'Review edits in the workspace editor.' });
    const locations = await lsp.definition({ file: example, text: sourceText, version: 1 }, position);
    assert.deepEqual(locations, [{ file: target, range }]);
    assert.equal((await open).textDocument.uri, mapping.toRemote(example));
    assert.match(await fs.readFile(target, 'utf8'), /public class Target/u);
  } finally {
    await lsp.stop();
    server.dispose();
    child.emit('close');
  }
});

async function checkJdt(api, { root, example, target }, signals) {
  const document = { file: example, text: sourceText, version: 1 };
  assert.equal((await fs.readFile(example, 'utf8')).replace(/\r\n/gu, '\n'), sourceText);
  let definition;
  for (let attempt = 0; attempt < 25; attempt++) {
    definition = await api.definition(document, position);
    if (definition.some(location => !path.relative(location.file, target))) break;
    await delay(350);
  }
  assert.ok(definition.some(location => !path.relative(location.file, target)), 'A real JDT definition must resolve to Target.java.');
  const fieldPosition = { line: 0, character: sourceText.indexOf('field') + 1 };
  let hover;
  for (let attempt = 0; attempt < 20; attempt++) {
    hover = await api.hover(document, fieldPosition);
    if (hover.includes('field')) break;
    await delay(350);
  }
  assert.match(hover, /Target.*field/u);
  const { before, after } = await api.formatting(document, { insertSpaces: true, tabSize: 4 });
  assert.equal(before, sourceText);
  assert.match(after, /class Example \{\s+Target field/u);
  assert.notEqual(after, before);
  assert.equal((await fs.readFile(example, 'utf8')).replace(/\r\n/gu, '\n'), sourceText);
  const invalid = { ...document, text: sourceText.replaceAll('Target', 'MissingType'), version: 2 };
  await api.synchronize(invalid);
  for (let attempt = 0; attempt < 25 && !signals.some(row => row.version === 2 && row.items.some(item => /MissingType/u.test(item.message))); attempt++) {
    await delay(350);
  }
  assert.ok(signals.some(row => row.version === 2 && row.items.some(item => /MissingType/u.test(item.message))),
    'JDT must diagnose an unresolved type from the synchronized editor version.');
  await assert.rejects(api.definition({ ...invalid, file: path.resolve(root, '..', 'NotMounted.java') }, position), /workspace|physical/u);
  return { realDefinition: true, realHover: true, realFormatter: true, unsavedDiagnostics: true, outsideWorkspaceRefused: true };
}

test('Real official JDT handles editor edits and produces bounded locations and formatting through the managed LSP protocol', {
  skip: !localJdt || !localJdk, timeout: 100000
}, async context => {
  const fixture = await ownedFiles(context);
  const launch = resolveLaunch({ javaHome: localJdk, serverPath: localJdt, storagePath: path.join(fixture.owned, 'jdk-state') });
  const child = spawn(launch.command, launch.args, { ...launch.options, stdio: ['pipe', 'pipe', 'ignore'] });
  const childExit = once(child, 'close');
  const map = {
    workspaceUri: pathToFileURL(fixture.root).href,
    toRemote(file) {
      if (path.relative(fixture.root, file).split(path.sep).includes('..')) throw Error('Use a Java file in the mounted workspace.');
      return pathToFileURL(file).href;
    },
    toHost(uri) {
      const file = fileURLToPath(uri);
      this.toRemote(file);
      return file;
    }
  };
  const signals = [];
  const api = createContainerJavaLsp({ child, protocol: toolProtocol, mapping: map, settings: serverSettings(),
    onDiagnostics: (_file, items, version) => signals.push({ items, version }) });
  try {
    await api.initialize();
    const proof = await checkJdt(api, fixture, signals);
    context.diagnostic(JSON.stringify(proof));
  } finally {
    await api.stop();
    await childExit;
  }
});

test('Actual Docker runs the reviewed official JDT server and maps real editor operations to its owned bind mount', {
  skip: !dockerLive || !cliPath, timeout: 420000
}, async context => {
  const fixture = await ownedFiles(context);
  const { root, example } = fixture;
  const token = randomUUID().replaceAll('-', '');
  const image = 'rocketbrain-devcontainer-java:rb' + token;
  const label = 'rocketbrain.devcontainer.fixture-jdt';
  const docker = async (args, timeout = 60000) => (await execute('docker', args, {
    cwd: root, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true
  })).stdout.trim();
  const signals = [];
  const managed = createDevContainers({ trusted: () => true, settings: () => ({ cliPath, nodePath: process.execPath }),
    javaProtocol: () => toolProtocol, onJavaDiagnostics: (_root, _file, items, version) => signals.push({ items, version }) });
  let started, built = false;
  try {
    await docker(['build', '--tag', image, '--label', label + '=' + token, '--file', 'Containerfile.txt', '.'], 240000);
    built = true;
    context.diagnostic('Official pinned JDK and JDT image built');
    const descriptor = path.join(root, '.devcontainer.json');
    const project = JSON.parse(await fs.readFile(descriptor, 'utf8'));
    await fs.writeFile(descriptor, JSON.stringify({ ...project, image }, null, 2) + '\n');
    const review = await managed.inspect(root);
    started = await managed.start(root, { file: review.file, fingerprint: review.fingerprint, allowProjectExecution: true });
    const runtime = { containerRoot: guestRoot, javaHome: '/opt/java/openjdk', serverPath: '/opt/jdtls' };
    await assert.rejects(managed.inspectJava(root, { ...runtime, containerRoot: '/tmp' }), /exact local workspace bind mount/);
    const java = await managed.inspectJava(root, runtime);
    assert.equal(java.jdk, 25);
    assert.equal(java.containerId, started.id);
    await assert.rejects(managed.startJava(root, { token: java.token }), /Review the mounted workspace/);
    const approval = { token: java.token, allowContainerProjectImport: true };
    const actual = await managed.startJava(root, approval);
    assert.equal(actual.containerId, started.id);
    await assert.rejects(managed.startJava(root, approval), /current container Java review/);
    context.diagnostic('Exact container Eclipse JDT initialized');
    const operations = {
      definition: (...args) => managed.javaDefinition(root, ...args), hover: (...args) => managed.javaHover(root, ...args),
      formatting: (...args) => managed.javaFormat(root, ...args), synchronize: (...args) => managed.javaSynchronize(root, ...args)
    };
    const proof = await checkJdt(operations, fixture, signals);
    const closedResult = await operations.formatting({ file: example, text: sourceText, version: 3 }, { insertSpaces: true, tabSize: 4 });
    assert.equal((await fs.readFile(example, 'utf8')).replace(/\r\n/gu, '\n'), closedResult.before);
    await fs.writeFile(example, closedResult.after);
    const readback = await managed.execute(root, ['cat', guestRoot + '/src/fixture/Example.java']);
    assert.equal(readback.code, 0);
    assert.equal(readback.stdout, closedResult.after);
    context.diagnostic('Real JDT read and reviewed formatting bytes agree with the mounted host file');
    await docker(['container', 'stop', '--time', '1', started.id]);
    for (let attempt = 0; attempt < 20; attempt++) {
      try { if ((await managed.javaStatus(root)).state === 'none') break; } catch {}
      await delay(200);
    }
    assert.deepEqual(await managed.javaStatus(root), { state: 'none' });
    await assert.rejects(managed.javaDefinition(root, { file: example, text: sourceText, version: 4 }, position), /Start Container Java/);
    const receipt = { runtime: { jdk: '25.0.5+8', jdt: '1.63.0', transport: 'docker-exec-stdio' },
      java: { ...proof, bindMountVerified: true, exactLocalFormatReadback: true, approvalOneShot: true, rejectDifferentMount: true,
        containerExitClosedRoute: true } };
    if (receiptPath) await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  } finally {
    try {
      await managed.stop(root);
      if (started) await docker(['container', 'rm', started.id]);
    } finally {
      managed.dispose();
      if (built) {
        const labels = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', image]));
        assert.equal(labels[label], token);
        await docker(['image', 'rm', image]);
      }
    }
  }
});
