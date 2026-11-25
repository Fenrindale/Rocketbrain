'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { registerJavaWorkbench } = require('../src/java/workbench');
const { applyManagedSpringLaunch } = require('../src/java/spring-launch');
const { jdbcReadback } = require('./java-source-analysis-host');
const { fixture, fakeVscode } = require('./java-workbench-fixture');
const F = require('./helpers/spring-launch-fixture');

async function waitFor(check, failure, budget = 45000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const state = await check();
    if (state) return state;
    await delay(140);
  }
  throw Error(failure);
}

async function probe(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/config-probe', { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : undefined;
  } catch { return undefined; }
}

async function exercise(workbench, config, project, workspace) {
  const main = await waitFor(async () => (await workbench.mainClasses({ projectUri: project.uri }))
    .find(entry => entry.mainClass === F.main), 'The owned Spring main did not resolve.');
  const input = await F.inputs(config, 'jvm');
  let rebound = await F.inputs(config, 'jvm');
  for (let attempt = 0; rebound.port === input.port && attempt < 3; attempt++) rebound = await F.inputs(config, 'jvm');
  assert.notEqual(rebound.port, input.port);
  const sample = rebound.sample + ' · imported';
  const args = ['--management.endpoint.health.show-details=never'], vmArgs = ['-Drocketbrain.fixture.shared=true'];
  const file = path.join(workspace, 'rb-share-fixture-' + randomUUID() + '.rocketbrain-run.json');
  const source = { rootUri: workspace, fileUri: file };
  let original, imported;
  try {
    original = await workbench.saveRunConfiguration({ name: 'Owned shared run fixture', projectUri: project.uri,
      mainClass: main.mainClass, projectName: main.projectName, args, vmArgs, env: input.env, springBoot: input.springBoot });
    const exported = await workbench.exportSharedRun({ ...source, configurationId: original.id });
    const manifest = await fs.readFile(file, 'utf8');
    for (const value of [...args, ...vmArgs, input.env.SPRING_DATASOURCE_PASSWORD, input.sample]) assert.ok(!manifest.includes(value));
    assert.equal(exported.privateValuesIncluded, false);
    const review = await workbench.reviewSharedRun(source);
    assert.equal(review.sha256, exported.sha256);
    const binding = { args, vmArgs, env: rebound.env, springValues: ['12', '1', sample] };
    await assert.rejects(workbench.applySharedRun({ reviewId: review.reviewId, bindings: binding }), /approve/i);
    imported = await workbench.applySharedRun({ reviewId: review.reviewId, approved: true, bindings: binding });
    assert.notEqual(imported.id, original.id);
    assert.equal(workbench.getSnapshot().runs.length, 0);
    const group = await workbench.startRunGroup({ configurations: [
      { configurationId: original.id, debug: false }, { configurationId: imported.id, debug: false }
    ] });
    assert.deepEqual(group.runs.map(run => run.configurationId), [original.id, imported.id]);
    const probes = await Promise.all([input, rebound].map(item => waitFor(() => probe(item.port),
      'The owned Spring process did not become ready.')));
    assert.deepEqual(probes.map(probe => probe.displayName), [input.sample, sample]);
    for (const observed of probes) {
      assert.deepEqual(observed.people, [1]);
      assert.equal(observed.queryLimit, 1);
      assert.equal(/MariaDB/i.test(observed.serverVersion), config.dbEngine === 'mariadb');
    }
    await workbench.stop({ runId: group.runs[0].runId });
    await waitFor(async () => !await probe(input.port), 'The independently stopped process remained available.', 12000);
    assert.equal((await probe(rebound.port)).displayName, sample);
    await workbench.stop({ runId: group.runs[1].runId });
    await waitFor(async () => !await probe(rebound.port), 'The imported run did not stop.', 12000);
    return { engine: config.dbEngine, observedJdbcRows: probes.map(probe => probe.people),
      shareRebound: true, freshApproval: true, exportedValuesOmitted: true, noAutoExecutionOnImport: true,
      groupCount: group.runs.length, independentStop: true };
  } finally {
    await workbench.stop();
    for (const entry of [original, imported]) if (entry) await workbench.deleteRunConfiguration(entry.id);
    await fs.rm(file, { force: true });
  }
}

async function verifySharedRunsBackend() {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const runtime = await F.readRuntime(), workspace = fixture();
  workspace.javaHome = runtime.home;
  const harness = fakeVscode(workspace), children = new Map();
  const request = harness.java.requestWorkspaceCommand;
  harness.java.requestWorkspaceCommand = function(name, args) {
    if (name === 'vscode.java.resolveMainClass') return Promise.resolve([{ mainClass: F.main, projectName: 'fixture' }]);
    return request.call(this, name, args);
  };
  const debug = harness.vscode.debug, launch = debug.startDebugging, stop = debug.stopDebugging;
  debug.startDebugging = async function(folder, configuration, options) {
    applyManagedSpringLaunch(configuration);
    const child = F.startOwnedArtifact(runtime, configuration);
    try {
      const admitted = await launch.call(this, folder, configuration, options);
      children.set('debug-' + harness.starts.length, child);
      return admitted;
    } catch (error) {
      await child.stop();
      throw error;
    }
  };
  debug.stopDebugging = async function(session) {
    await children.get(session.id)?.stop();
    children.delete(session.id);
    return stop.call(this, session);
  };
  const api = registerJavaWorkbench(harness.context, harness.vscode, harness.java, harness.output, { runner: harness.runner });
  try { return { ...await exercise(api, config, workspace, workspace.root), jdbc: await jdbcReadback() }; }
  finally {
    await api.dispose();
    assert.equal(children.size, 0);
    const folder = await fs.realpath(workspace.parent);
    assert.equal(path.dirname(folder), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(folder), /^rb-workbench-v18-/);
    await fs.rm(folder, { recursive: true, maxRetries: 3 });
  }
}

async function runSharedRunChecks(api, vscode, checks) {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await F.ownedProject(workspace, await F.readRuntime());
  const workbench = api.java.workbench;
  try {
    await api.java.start();
    await workbench.resyncProject({ projectUri: project.uri, allowProjectExecution: true });
    const result = await exercise(workbench, config, project, workspace);
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['exportSharedRun','importSharedRun','startRunGroup']) {
      assert.ok(commands.includes('rocketbrain.java.workbench.' + command));
    }
    checks.push('The installed Java project share omitted local values, reopened a trusted file and started two independently stoppable Spring JVMs using the same real database.');
    return { ...result, nativeSharedGroup: true, jdbc: await jdbcReadback() };
  } finally {
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [project.uri]).catch(() => {});
    await project.close();
  }
}

if (require.main === module) verifySharedRunsBackend().then(result => console.log(JSON.stringify(result)),
  error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runSharedRunChecks, verifySharedRunsBackend };
