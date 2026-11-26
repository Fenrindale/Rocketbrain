'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { registerJakartaWorkbench } = require('../src/java/jakarta-vscode');
const { buildSpec } = require('../src/java/workbench-tasks');
const { execute } = require('../src/java/testing/provision');
const { startOwnedManager, applicationResponse } = require('./helpers/jakarta-manager-fixture');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');

const fixture = path.join(__dirname, 'fixtures/java/jakarta-war');
const uri = file => pathToFileURL(file).href;

async function ownedDirectory(parent, prefix, work) {
  const boundary = await fs.realpath(parent), root = await fs.mkdtemp(path.join(boundary, prefix));
  const identity = await fs.lstat(root, { bigint: true });
  try { return await work(root); }
  finally {
    const current = await fs.realpath(root), stat = await fs.lstat(current, { bigint: true });
    assert.deepEqual([current, path.dirname(current), stat.dev, stat.ino], [root, boundary, identity.dev, identity.ino]);
    assert.ok(path.basename(current).startsWith(prefix));
    await fs.rm(current, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

async function modulesAt(root) {
  const modules = [];
  for (const name of ['peer', 'first', 'update']) {
    const folder = path.join(root, name);
    await fs.cp(fixture, folder, { recursive: true,
      filter: file => !['target', '.mvn', '.project', '.classpath', '.settings'].includes(path.basename(file)) });
    const pom = path.join(folder, 'pom.xml'), source = path.join(folder, 'src/main/java/jakartafixture/PingServlet.java');
    await fs.writeFile(pom, (await fs.readFile(pom, 'utf8')).replace('<artifactId>jakarta-war</artifactId>',
      '<artifactId>manager-war-' + name + '</artifactId>'));
    const original = await fs.readFile(source, 'utf8');
    const start = '        response.setContentType';
    assert.ok(original.includes(start));
    const jdbc = String.raw`
        String runtime = System.getenv("RB_JAKARTA_SPRING_URL");
        if (runtime == null || !runtime.matches("http://127\\.0\\.0\\.1:[0-9]{4,5}")) {
            response.sendError(503); return;
        }
        var connection = (java.net.HttpURLConnection) java.net.URI.create(runtime + "/probe/testing-state").toURL().openConnection();
        connection.setConnectTimeout(3500);
        connection.setReadTimeout(3500);
        connection.setInstanceFollowRedirects(false);
        try (var body = connection.getInputStream()) {
            var readable = new String(body.readNBytes(1025), java.nio.charset.StandardCharsets.UTF_8).replaceAll("\\s+", "");
            if (readable.length() >= 1025 || !readable.contains("\"people\":2")) { response.sendError(503); return; }
        } finally { connection.disconnect(); }
`;
    await fs.writeFile(source, original.replace(start, jdbc + start).replace('jakarta-servlet:', 'manager-' + name + ':')
      .replace('getServletContext().getMajorVersion()', '"people=2"'));
    const jsp = path.join(folder, 'src/main/webapp/page.jsp');
    await fs.writeFile(jsp, (await fs.readFile(jsp, 'utf8')).replace('jakarta-page:', 'manager-' + name + '-jsp:'));
    if (process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO) {
      await fs.mkdir(path.join(folder, '.mvn'));
      await fs.writeFile(path.join(folder, '.mvn/maven.config'),
        '-Dmaven.repo.local=' + path.resolve(process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO) + '\n');
    }
    modules.push({ root: folder, name, uri: uri(folder), tool: 'maven' });
  }
  return modules;
}

async function expectApp(server, context, name) {
  assert.equal(await applicationResponse(server, context, '/ping'), 'manager-' + name + ':' + context + ':people=2');
  assert.equal(await applicationResponse(server, context, '/page.jsp'), 'manager-' + name + '-jsp:' + context);
}

async function exercise(api, modules, server) {
  const manager = api.remoteManager;
  const jdbc = await jdbcReadback();
  assert.ok(jdbc);
  const input = { origin: server.origin, caFile: server.caFile, username: server.username,
    password: server.password, allowManagerAccess: true };
  const observe = overrides => manager.observe({ ...input, ...overrides });
  const exec = (plan, allowExecute = true) => manager.execute({ reviewId: plan.id, username: input.username,
    password: input.password, allowExecute });
  const archives = new Map();
  for (const project of modules) {
    const built = await api.buildWar({ projectUri: project.uri, allowProjectExecution: true });
    assert.equal(built.state, 'succeeded');
    assert.equal(built.artifacts.length, 1);
    archives.set(project.name, { projectUri: project.uri, warUri: built.artifacts[0].uri });
  }
  const review = (action, context, archive) => manager.review({ ...input, action, context, ...archive });
  await assert.rejects(observe({ allowManagerAccess: false }), /Explicitly approve/u);
  await assert.rejects(observe({ origin: server.origin.replace('https:', 'http:') }), /exact HTTPS origin/u);
  await assert.rejects(observe({ caFile: undefined }), /TLS or connection verification/u);
  await assert.rejects(observe({ origin: server.origin.replace('127.0.0.1', 'localhost') }), /TLS or connection verification/u);
  await assert.rejects(observe({ password: 'unauthorized-owned-attempt' }), /denied access/u);
  const listed = await observe();
  assert.deepEqual(listed.applications.map(item => item.context), ['/manager']);
  assert.match(listed.certificateSha256, /^[a-f0-9]{64}$/u);

  const peer = await review('deploy', '/rb-peer', archives.get('peer'));
  assert.equal((await exec(peer)).state, 'confirmed');
  await expectApp(server, '/rb-peer', 'peer');
  await assert.rejects(review('deploy', '/rb-peer', archives.get('peer')), /already exists/u);
  const firstInput = archives.get('first'), war = fileURLToPath(firstInput.warUri), bytes = await fs.readFile(war);
  const initial = await review('deploy', '/rb-target', firstInput);
  assert.equal(initial.uploadedSha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(exec(initial, false), /Explicitly approve/u);
  try {
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    await fs.writeFile(war, changed);
    await assert.rejects(exec(initial), /WAR artifact changed while staging/u);
  } finally { await fs.writeFile(war, bytes); }
  const ca = await fs.readFile(server.caFile);
  const trustPlan = await review('deploy', '/rb-target', firstInput);
  try {
    await fs.appendFile(server.caFile, '\n');
    await assert.rejects(exec(trustPlan), /certificate authority changed/u);
  } finally { await fs.writeFile(server.caFile, ca); }

  const first = await review('deploy', '/rb-target', firstInput);
  const competing = await review('deploy', '/rb-target', firstInput);
  const deployed = await exec(first);
  assert.equal(deployed.state, 'confirmed');
  assert.equal(deployed.uploadedSha256, first.uploadedSha256);
  await assert.rejects(exec(competing), /application state changed/u);
  await assert.rejects(exec(first), /Review the current/u);
  await expectApp(server, '/rb-target', 'first');
  const update = await review('update', '/rb-target', archives.get('update'));
  assert.equal(update.application.state, 'running');
  const updated = await exec(update);
  assert.equal(updated.state, 'confirmed');
  assert.notEqual(updated.uploadedSha256, deployed.uploadedSha256);
  await expectApp(server, '/rb-target', 'update');
  await expectApp(server, '/rb-peer', 'peer');

  const removed = await exec(await review('undeploy', '/rb-target'));
  assert.equal(removed.state, 'confirmed');
  await applicationResponse(server, '/rb-target', '/ping', 404);
  await expectApp(server, '/rb-peer', 'peer');

  const invalid = path.join(path.dirname(war), 'invalid-archive.war');
  await fs.writeFile(invalid, Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(24, 0x55)]));
  const unsafeChange = await review('deploy', '/rb-incomplete', { projectUri: firstInput.projectUri, warUri: uri(invalid) });
  const unconfirmed = await exec(unsafeChange);
  assert.equal(unconfirmed.state, 'unconfirmed');
  await assert.rejects(exec(unsafeChange), /Review the current/u);
  await expectApp(server, '/rb-peer', 'peer');
  assert.deepEqual(await jdbcReadback(), jdbc);
  for (const message of [initial, listed, first, deployed, update, updated, removed, unconfirmed]) {
    const forbidden = [server.password, 'Basic ' + Buffer.from(input.username + ':' + input.password).toString('base64')];
    assert.ok(forbidden.every(secret => !JSON.stringify(message).includes(secret)));
  }
  return { engine: process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE, serverVersion: '11.0.29', actualStockManager: true,
    verifiedTls: true, unknownCaAndNameRejected: true, badCredentialRejected: true, privateCredentials: true,
    reviewedDeployUpdateUndeploy: true, unequalUploadSha256: true, staleArtifactTrustAndTargetRejected: true,
    replayRejected: true, incompleteVendorResultUnconfirmed: true, peerPreserved: true,
    servletJspAndSpringJdbc: true, jdbc };
}

async function withManager(tools, action) {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const ownerFolder = path.dirname(await fs.realpath(config.dbConfigPath));
  const owner = JSON.parse(await fs.readFile(path.join(ownerFolder, 'owner.json'), 'utf8'));
  assert.equal(owner.id, path.basename(ownerFolder));
  assert.equal(owner.kind, { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1',
    mariadb: 'RocketbrainDisposableMariaDbFixture-v1' }[config.dbEngine]);
  return ownedDirectory(os.tmpdir(), 'rb-tls-manager-', async root => {
    const server = await startOwnedManager({ base: path.join(root, 'server'), ...tools, springUrl: config.baseUrl });
    try { return await action(server); }
    finally { await server.stop(); }
  });
}

async function runJakartaManagerChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const service = api.java.jakarta;
  assert.ok(service.remoteManager);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.jakarta.manager'));
  await importedSpring(api, workspace);
  const javaHome = api.java.getState().javaHome;
  const mavenHome = vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome');
  const tomcatHome = await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_TOMCAT_HOME);
  assert.ok(mavenHome);
  return ownedDirectory(workspace, 'rb-manager-modules-', async root => {
    const modules = await modulesAt(root), imports = [];
    try {
      for (const project of modules) {
        const state = await api.java.workbench.resyncProject({ projectUri: project.uri, allowProjectExecution: true });
        assert.ok(state.projects.some(item => !path.relative(item.root, project.root) && item.tool === 'maven'));
        imports.push(project.uri);
      }
      const result = await withManager({ javaHome, tomcatHome }, server => exercise(service, modules, server));
      checks.push('The installed Jakarta workbench used the stock Tomcat Manager over verified TLS to deploy, update and undeploy reviewed WARs while the peer continued serving Spring JDBC rows.');
      return { ...result, nativeView: true };
    } finally {
      if (imports.length) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], imports);
    }
  });
}

function localWorkbench(root, modules, tools) {
  const stub = () => ({ dispose() {} });
  const vscode = {
    window: { createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }) },
    workspace: { isTrusted: true, workspaceFolders: [uri(root)], textDocuments: [] },
    commands: { registerCommand: stub, getCommands: async () => [] },
    debug: { onDidStartDebugSession: stub, onDidTerminateDebugSession: stub }
  };
  return registerJakartaWorkbench(vscode, { workbench: {
    getSnapshot: () => ({ projects: modules }),
    discoverTasks: async () => [{ id: 'package', name: 'package' }],
    async runTask({ projectUri }) {
      const spec = buildSpec(modules.find(project => project.uri === projectUri), tools, ['package']);
      const result = await execute(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, timeoutMs: 90000 });
      assert.equal(result.code, 0, result.output);
      return { state: 'succeeded' };
    }
  } });
}

async function headless() {
  const { javaHome } = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const mavenHome = await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
  const tomcatHome = await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_TOMCAT_HOME);
  return ownedDirectory(os.tmpdir(), 'rb-manager-modules-', async root => {
    const modules = await modulesAt(root), service = localWorkbench(root, modules, { javaHome, mavenHome });
    try {
      const result = await withManager({ javaHome, tomcatHome }, server => exercise(service, modules, server));
      return { ...result, nativeView: false };
    } finally { await service.dispose(); }
  });
}

module.exports = { runJakartaManagerChecks };
if (require.main === module) headless().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
