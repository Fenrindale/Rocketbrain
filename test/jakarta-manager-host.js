'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { text } = require('node:stream/consumers');
const { createTomcatManager } = require('../src/java/jakarta-manager');
const { storageFolder } = require('../src/java/jakarta-manager-journal');
const { registerJakartaWorkbench } = require('../src/java/jakarta-vscode');
const { buildSpec } = require('../src/java/workbench-tasks');
const { execute } = require('../src/java/testing/provision');
const { startOwnedManager, applicationResponse, publishExternalFixtureWar } = require('./helpers/jakarta-manager-fixture');
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
        if ("1".equals(request.getParameter("ownedSession"))) request.getSession().setAttribute("ownedFixture", Boolean.TRUE);
`;
    await fs.writeFile(source, original.replace(start, jdbc + start).replace('jakarta-servlet:', 'manager-' + name + ':')
      .replace('getServletContext().getMajorVersion()', '"people=2"'));
    const jsp = path.join(folder, 'src/main/webapp/page.jsp');
    await fs.writeFile(jsp, (await fs.readFile(jsp, 'utf8')).replace('jakarta-page:', 'manager-' + name + '-jsp:'));
    if (process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO) {
      await fs.mkdir(path.join(folder, '.mvn'));
      await fs.writeFile(path.join(folder, '.mvn/maven.config'),
        '-Dmaven.repo.local=' + path.resolve(process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO) + '\n' +
        (process.env.ROCKETBRAIN_JAKARTA_MAVEN_OFFLINE === '1' ? '--offline\n' : ''));
    }
    modules.push({ root: folder, name, uri: uri(folder), tool: 'maven' });
  }
  return modules;
}

async function expectApp(server, context, name) {
  assert.equal(await applicationResponse(server, context, '/ping'), 'manager-' + name + ':' + context + ':people=2');
  assert.equal(await applicationResponse(server, context, '/page.jsp'), 'manager-' + name + '-jsp:' + context);
}

async function exerciseRestore(server, { observe, exec, review, archives, profile }) {
  const context = '/rb-tracked', source = archives.get('first'), updatedSource = archives.get('update');
  const file = fileURLToPath(source.warUri), bytes = await fs.readFile(file);
  const updated = await fs.readFile(fileURLToPath(updatedSource.warUri));
  const digest = data => createHash('sha256').update(data).digest('hex');
  await assert.rejects(review('restore', '/rb-peer'), /context tracked by this Tomcat Manager/u);
  await assert.rejects(review('track-deploy', '/rb-peer', source), /empty Tomcat context/u);
  const firstPlan = await review('track-deploy', context, source);
  assert.equal(firstPlan.nextRevision, 1);
  assert.equal(firstPlan.historyScope, 'profile');
  assert.equal(firstPlan.version, undefined);
  const first = await exec(firstPlan);
  assert.match(first.version, /^rb001-[a-f0-9]{32}$/u);
  assert.equal(first.uploadedSha256, digest(bytes));
  assert.equal(first.state, 'confirmed');
  await expectApp(server, context, 'first');
  await assert.rejects(review('restore', context), /second tracked WAR/u);
  await assert.rejects(review('update', context, source), /parallel deployments/u);
  await assert.rejects(review('track-update', context, source), /different bytes/u);

  // A normal Maven rebuild can replace the same target WAR path. The retained
  // archive must still be the exact deployed bytes, independent of that path.
  try {
    await fs.writeFile(file, updated);
    const stale = await review('track-update', context, source);
    await fs.writeFile(file, bytes);
    await assert.rejects(exec(stale), /WAR artifact changed/u);
    await assert.rejects(exec(stale), /Review the current/u);
    await fs.writeFile(file, updated);
    const updatePlan = await review('track-update', context, source);
    assert.equal(updatePlan.nextRevision, 2);
    assert.equal(updatePlan.currentVersion, first.version);
    assert.equal(updatePlan.currentSha256, digest(bytes));
    assert.equal(updatePlan.uploadedSha256, digest(updated));
    const update = await exec(updatePlan);
    assert.equal(update.state, 'confirmed');
    assert.match(update.version, /^rb002-[a-f0-9]{32}$/u);
    await expectApp(server, context, 'update');
    const oldSession = await applicationResponse(server, context, '/ping?ownedSession=1', 200, { captureSession: true });
    assert.equal(oldSession.body, 'manager-update:' + context + ':people=2');
    assert.match(oldSession.cookie, /^JSESSIONID=[A-Fa-f\d.]+$/u);

    let restore = await review('restore', context);
    assert.equal(restore.nextRevision, 3);
    assert.equal(restore.version, undefined);
    assert.deepEqual(restore.retainedVersions, [first.version, update.version]);
    assert.equal(restore.restoreFromVersion, first.version);
    assert.equal(restore.currentVersion, update.version);
    assert.equal(restore.application.version, update.version);
    assert.ok(restore.application.sessions >= 1);
    assert.equal(restore.currentSha256, digest(updated));
    assert.equal(restore.uploadedSha256, digest(bytes));
    await assert.rejects(exec(restore, false), /Explicitly approve/u);
    let resumed;
    if (profile) {
      const directory = path.join(profile.path, storageFolder, digest(JSON.stringify([server.origin, context])));
      for (const slot of ['001', '002']) {
        const record = await fs.readFile(path.join(directory, slot, 'confirmed.json'), 'utf8');
        assert.ok([server.username, server.password, server.origin, server.caFile].every(value => !record.includes(value)));
      }
      async function tamper(slot, action) {
        const archive = path.join(directory, slot, 'reviewed.war'), original = await fs.readFile(archive), changed = Buffer.from(original);
        changed[changed.length - 1] ^= 1;
        try {
          await fs.writeFile(archive, changed);
          await assert.rejects(action(), /WAR artifact changed/u);
        } finally { await fs.writeFile(archive, original); }
      }
      await tamper('002', () => exec(restore));
      await tamper('001', () => review('restore', context));
      const ca = await fs.readFile(server.caFile);
      try {
        await fs.appendFile(server.caFile, '\n');
        await assert.rejects(review('restore', context), /same endpoint, account and certificate/u);
      } finally { await fs.writeFile(server.caFile, ca); }
      restore = await review('restore', context);
      resumed = await profile.resume(context);
      assert.notEqual(resumed.pid, process.pid);
      assert.notEqual(resumed.review.id, restore.id);
      assert.deepEqual([resumed.review.currentVersion, resumed.review.currentSha256, resumed.review.restoreFromVersion,
        resumed.review.uploadedSha256, resumed.review.historyScope],
      [restore.currentVersion, restore.currentSha256, restore.restoreFromVersion, restore.uploadedSha256, 'profile']);
    }
    const restored = resumed?.receipt || await exec(restore);
    assert.equal(restored.state, 'confirmed');
    assert.match(restored.version, /^rb003-[a-f0-9]{32}$/u);
    assert.equal(restored.application.version, restored.version);
    assert.equal(restored.uploadedSha256, digest(bytes));
    await assert.rejects(exec(restore), /Review the current/u);
    await expectApp(server, context, 'first');
    assert.equal(await applicationResponse(server, context, '/ping', 200, { cookie: oldSession.cookie }), oldSession.body);
    const listed = (await observe()).applications.filter(item => item.context === context);
    assert.deepEqual(listed.map(item => item.version).sort(), [first.version, update.version, restored.version]);
    assert.ok(listed.find(item => item.version === update.version).sessions >= 1);
    for (const revision of [first, update, restored]) {
      const warName = context.slice(1) + '##' + revision.version + '.war';
      const deployedBytes = await fs.readFile(path.join(server.applicationBase, warName));
      assert.equal(digest(deployedBytes), revision.uploadedSha256);
    }

    const obsolete = await review('restore', context);
    assert.equal(obsolete.nextRevision, 4);
    await publishExternalFixtureWar(server, context, file);
    await assert.rejects(exec(obsolete), /reviewed live Tomcat versions changed/u);
    await assert.rejects(exec(obsolete), /Review the current/u);
    await assert.rejects(review('restore', context), /live Tomcat versions no longer match/u);
    const after = (await observe()).applications.filter(item => item.context === context);
    assert.equal(after.length, 4);
    assert.ok(after.every(item => !item.version?.startsWith('rb004-')));
    await expectApp(server, context, 'update');
    await expectApp(server, '/rb-peer', 'peer');
    return { originalSha256: first.uploadedSha256, currentSha256: update.uploadedSha256,
      restoredSha256: restored.uploadedSha256, versionsBeforeRestore: 2, versionsAfterRestore: 3,
      sameSourcePathRebuilt: true, currentBytesRetained: true, freshSessionRestored: true, existingSessionPreserved: true,
      exactLocalReviewedUpload: true, ownedServerArchiveSha256Matched: true, replayRefused: true,
      foreignVersionAndOrdinaryContextRefused: true, staleWarRefused: true, profileHistory: true,
      ...(profile && { freshProcessRestore: true, oldAndCurrentArchiveTamperingRefused: true,
        changedIdentityRefused: true, storedMetadataExcludedManagerCredentials: true }) };
  } finally { await fs.writeFile(file, bytes); }
}

async function exercise(api, modules, server, profile) {
  const jdbc = await jdbcReadback();
  assert.ok(jdbc);
  const input = { origin: server.origin, caFile: server.caFile, username: server.username,
    password: server.password, allowManagerAccess: true };
  const observe = overrides => api.remoteManager.observe({ ...input, ...overrides });
  const exec = (plan, allowExecute = true) => api.remoteManager.execute({ reviewId: plan.id, username: input.username,
    password: input.password, allowExecute });
  const archives = new Map();
  for (const project of modules) {
    const built = await api.buildWar({ projectUri: project.uri, allowProjectExecution: true });
    assert.equal(built.state, 'succeeded');
    assert.equal(built.artifacts.length, 1);
    archives.set(project.name, { projectUri: project.uri, warUri: built.artifacts[0].uri });
  }
  const review = (action, context, archive) => api.remoteManager.review({ ...input, action, context, ...archive });
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
  const uncertainPlan = await review('track-deploy', '/rb-interrupted', { projectUri: firstInput.projectUri, warUri: uri(invalid) });
  assert.equal(uncertainPlan.historyScope, 'profile');
  assert.equal((await exec(uncertainPlan)).state, 'unconfirmed');
  await assert.rejects(review('track-deploy', '/rb-interrupted', firstInput), /interrupted or is still in progress/u);
  await expectApp(server, '/rb-peer', 'peer');
  assert.deepEqual(await jdbcReadback(), jdbc);
  const trackedRestore = await exerciseRestore(server, { observe, exec, review, archives, profile });
  await assert.rejects(review('track-deploy', '/rb-interrupted', firstInput), /interrupted or is still in progress/u);
  assert.deepEqual(await jdbcReadback(), jdbc);
  for (const message of [initial, listed, first, deployed, update, updated, removed, unconfirmed]) {
    const forbidden = [server.password, 'Basic ' + Buffer.from(input.username + ':' + input.password).toString('base64')];
    assert.ok(forbidden.every(secret => !JSON.stringify(message).includes(secret)));
  }
  return { engine: process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE, serverVersion: '11.0.29', actualStockManager: true,
    verifiedTls: true, unknownCaAndNameRejected: true, badCredentialRejected: true, privateCredentials: true,
    reviewedDeployUpdateUndeploy: true, unequalUploadSha256: true, staleArtifactTrustAndTargetRejected: true,
    replayRejected: true, incompleteVendorResultUnconfirmed: true, peerPreserved: true,
    servletJspAndSpringJdbc: true, interruptedProfileHistoryRefused: true, trackedRestore, jdbc };
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
      checks.push('The Manager restored exact retained WAR bytes as a new parallel version, preserving a previous session and rejecting an externally published version.');
      return { ...result, nativeView: true };
    } finally {
      if (imports.length) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], imports);
    }
  });
}

function localWorkbench(root, modules, tools, profilePath) {
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
  } }, { storageUri: { scheme: 'file', fsPath: profilePath } });
}

function resumeInChild(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--resume-profile'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: AbortSignal.timeout(90000)
    });
    let output = '', errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-24000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(-24000); });
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(Error(errors));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function resumedProfile() {
  const { storagePath, context, input } = JSON.parse(await text(process.stdin));
  const manager = createTomcatManager({ storagePath });
  try {
    const review = await manager.review({ ...input, action: 'restore', context, allowManagerAccess: true });
    const receipt = await manager.execute({ reviewId: review.id, username: input.username, password: input.password, allowExecute: true });
    return { pid: process.pid, review, receipt };
  } finally { await manager.dispose(); }
}

async function headless() {
  const { javaHome } = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const mavenHome = await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
  const tomcatHome = await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_TOMCAT_HOME);
  return ownedDirectory(os.tmpdir(), 'rb-manager-modules-', async root => {
    const modules = await modulesAt(root), profilePath = path.join(root, 'profile');
    const start = () => localWorkbench(root, modules, { javaHome, mavenHome }, profilePath);
    let service = start();
    const facade = { buildWar: input => service.buildWar(input), get remoteManager() { return service.remoteManager; } };
    try {
      const result = await withManager({ javaHome, tomcatHome }, server => exercise(facade, modules, server, {
        path: profilePath, async resume(context) {
          await service.dispose();
          const { origin, caFile, username, password } = server;
          const result = await resumeInChild({ storagePath: profilePath, context, input: { origin, caFile, username, password } });
          service = start();
          return result;
        }
      }));
      return { ...result, nativeView: false };
    } finally { await service.dispose(); }
  });
}

module.exports = { runJakartaManagerChecks };
if (require.main === module) (process.argv.includes('--resume-profile') ? resumedProfile() : headless())
  .then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
