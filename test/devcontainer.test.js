'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { createDevContainers, cliVersion, sessionLabel } = require('../src/devcontainer/runtime');

const executeFile = promisify(execFile);
const fixture = path.join(__dirname, 'fixtures', 'devcontainer');
const cliPath = process.env.ROCKETBRAIN_DEVCONTAINER_CLI_PATH;
const inventoryProbe = process.env.ROCKETBRAIN_DEVCONTAINER_INSPECT_DOCKER_PATH;
const dockerPath = process.env.ROCKETBRAIN_DEVCONTAINER_DOCKER_PATH;
const live = process.env.ROCKETBRAIN_DEVCONTAINER_LIVE === 'true';
const receipt = process.env.ROCKETBRAIN_DEVCONTAINER_RECEIPT;
const runningId = 'c'.repeat(64);
const approved = plan => ({ file: plan.file, fingerprint: plan.fingerprint, allowProjectExecution: true });
const response = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });

async function tempFixture(context, name) {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-devcontainer-'));
  context.after(async () => {
    const resolved = await fs.realpath(owned);
    assert.equal(resolved, owned);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^rb-devcontainer-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(owned, name);
  await fs.cp(path.join(fixture, name), root, { recursive: true });
  return { root, owned };
}

async function modeledService(context, { kind = 'image', trusted = true, failAfterCreation = false } = {}) {
  const { root, owned } = await tempFixture(context, 'image');
  const packageFolder = path.join(owned, 'cli');
  await fs.mkdir(packageFolder);
  await fs.writeFile(path.join(packageFolder, 'package.json'), JSON.stringify({ name: '@devcontainers/cli', version: cliVersion }));
  await fs.writeFile(path.join(packageFolder, 'devcontainer.js'), '');
  const sessions = new Map();
  const state = { running: false, label: undefined, calls: [], host: 'unix:///var/run/docker.sock' };
  const engine = {
    trusted: () => trusted,
    settings: () => ({ cliPath: packageFolder, nodePath: process.execPath, dockerPath: process.execPath }),
    readSession: key => sessions.get(key),
    writeSession: (key, value) => value ? sessions.set(key, value) : sessions.delete(key),
    async run(_, args) {
      state.calls.push(args);
      if (args[0] === 'context') return response(state.host);
      if (args[1] === 'read-configuration') return response({
        configuration: kind === 'compose' ? { dockerComposeFile: 'compose.yml', name: 'multi' } : { image: 'ubuntu:24.04', name: 'fixture' },
        workspace: { workspaceFolder: '/workspaces/image' }
      });
      if (args[1] === 'up') {
        state.running = true;
        state.label = args.find(value => value.startsWith(sessionLabel + '=')).split('=')[1];
        return failAfterCreation ? { code: 1 } : response({ outcome: 'success', containerId: runningId, remoteWorkspaceFolder: '/workspaces/image' });
      }
      if (args[1] === 'exec') return { code: 7, stdout: 'command output\n', stderr: 'command diagnostics\n' };
      if (args[2] === 'ls') return response(state.label ? runningId : '');
      if (args[2] === 'inspect') return response({ Id: runningId, Config: { Labels: { [sessionLabel]: state.label } },
        State: { Running: state.running } });
      if (args[2] === 'stop') {
        assert.equal(args.at(-1), runningId);
        state.running = false;
        return response(runningId);
      }
      throw Error('Unexpected test invocation: ' + args.join(' '));
    }
  };
  return { root, engine, state, service: createDevContainers(engine) };
}

test('Dev Container workflow binds literal argv and persistent stop to the verified exact container', async context => {
  const { root, engine, state, service } = await modeledService(context);
  assert.deepEqual(await service.status(root), { state: 'none' });
  const plan = await service.inspect(root);
  assert.equal(plan.workspaceFolder, '/workspaces/image');
  await assert.rejects(service.start(root, plan), /Review/);
  const started = await service.start(root, approved(plan));
  assert.equal(started.id, runningId);
  assert.equal(started.state, 'running');
  const upArgs = state.calls.find(args => args[1] === 'up');
  assert.ok(upArgs.includes('--mount-workspace-git-root=false'));
  assert.ok(upArgs.includes('--skip-post-attach'));
  assert.ok(upArgs.includes(sessionLabel + '=' + state.label));
  assert.ok(!upArgs.includes('--remove-existing-container'));
  await assert.rejects(service.execute(root, ['--help']), /JSON array/);
  const argv = ['java', '-version', 'literal ; $input', ''];
  const result = await service.execute(root, argv);
  assert.deepEqual(result, { id: runningId, code: 7, stdout: 'command output\n', stderr: 'command diagnostics\n' });
  const execArgs = state.calls.find(args => args[1] === 'exec');
  assert.equal(execArgs[execArgs.indexOf('--container-id') + 1], runningId);
  assert.deepEqual(execArgs.slice(-argv.length), argv);
  const restartedHost = createDevContainers(engine);
  assert.deepEqual(await restartedHost.status(root), { state: 'running', id: runningId });
  assert.deepEqual(await restartedHost.stop(root), { state: 'stopped', id: runningId });
  assert.deepEqual(await restartedHost.status(root), { state: 'none' });
});

test('Dev Container rejects untrusted workspaces, stale review, Compose launch and foreign labels', async context => {
  const blocked = await modeledService(context, { trusted: false });
  await assert.rejects(blocked.service.inspect(blocked.root), /Trust/);
  assert.deepEqual(blocked.state.calls, []);
  const compose = await modeledService(context, { kind: 'compose' });
  const composePlan = await compose.service.inspect(compose.root);
  assert.equal(composePlan.kind, 'compose');
  await assert.rejects(compose.service.start(compose.root, approved(composePlan)), /single-image or Dockerfile/);
  const { root, state, service } = await modeledService(context);
  const plan = await service.inspect(root);
  await fs.appendFile(plan.file, '\n// configuration changed\n');
  await assert.rejects(service.start(root, approved(plan)), /changed/);
  assert.ok(!state.calls.some(args => args[1] === 'up'));
  await service.start(root, approved(await service.inspect(root)));
  await fs.appendFile(plan.file, '\n// changed since startup\n');
  await assert.rejects(service.execute(root, ['java']), /changed/);
  state.label = 'other-owner';
  await assert.rejects(service.stop(root), /ownership/);
  assert.ok(!state.calls.some(args => args[2] === 'stop'));
  const remote = await modeledService(context);
  remote.state.host = 'ssh://test.example';
  const original = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_CONTEXT = 'rocketbrain-devcontainer-test';
  try {
    await assert.rejects(remote.service.inspect(remote.root), /local Unix socket or Windows named pipe/);
  } finally {
    if (original === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = original;
  }
});

test('Dev Container can verify and stop its own container after an uncertain launch', async context => {
  const { root, engine, state, service } = await modeledService(context, { failAfterCreation: true });
  const plan = await service.inspect(root);
  const started = service.start(root, approved(plan));
  await assert.rejects(service.status(root), /already running/);
  await assert.rejects(started, /could not start/);
  assert.ok(state.running);
  const restartedHost = createDevContainers(engine);
  assert.deepEqual(await restartedHost.status(root), { state: 'running', id: runningId });
  assert.deepEqual(await restartedHost.stop(root), { state: 'stopped', id: runningId });
  assert.equal(state.running, false);
});

test('official Dev Container CLI resolves JSONC and selected workspace variables with a test-only empty inventory', {
  skip: !cliPath || !inventoryProbe
}, async context => {
  const service = createDevContainers({ trusted: () => true,
    settings: () => ({ nodePath: process.execPath, cliPath, dockerPath: inventoryProbe }) });
  const configs = {};
  for (const kind of ['image', 'dockerfile']) {
    const { root } = await tempFixture(context, kind);
    const plan = await service.inspect(root);
    assert.equal(plan.kind, kind);
    assert.equal(plan.workspaceFolder, '/workspaces/' + kind);
    assert.match(plan.workspaceMount, /type=bind/);
    assert.deepEqual(plan.lifecycleHooks, ['postCreateCommand']);
    configs[kind] = { workspaceFolder: plan.workspaceFolder, lifecycleHooks: plan.lifecycleHooks };
  }
  if (receipt) await fs.writeFile(receipt, JSON.stringify({ cliVersion, source: 'official CLI', dockerInventory: 'empty test adapter',
    configurations: configs }, null, 2) + '\n');
});

test('actual local Docker starts image and Dockerfile Dev Containers, runs their workspace hooks and stops only their IDs', {
  skip: !live,
  timeout: 720000
}, async context => {
  assert.ok(cliPath, 'Set ROCKETBRAIN_DEVCONTAINER_CLI_PATH to the locked CLI package.');
  const proof = {};
  for (const name of ['image', 'dockerfile']) {
    const { root } = await tempFixture(context, name);
    const sessions = new Map();
    const service = createDevContainers({ trusted: () => true,
      settings: () => ({ nodePath: process.execPath, cliPath, dockerPath }),
      readSession: key => sessions.get(key),
      writeSession: (key, value) => value ? sessions.set(key, value) : sessions.delete(key)
    });
    const docker = async args => (await executeFile(dockerPath || 'docker', args, {
      cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024
    })).stdout.trim();
    const plan = await service.inspect(root);
    assert.equal(plan.kind, name);
    assert.equal(plan.workspaceFolder, '/workspaces/' + name);
    assert.match(plan.workspaceMount, /type=bind/);
    assert.deepEqual(plan.lifecycleHooks, ['postCreateCommand']);
    const started = await service.start(root, approved(plan));
    const active = [...sessions.values()][0];
    try {
      assert.equal(started.workspaceFolder, plan.workspaceFolder);
      assert.deepEqual(await service.status(root), { state: 'running', id: started.id });
      const mounted = await service.execute(root, ['cat', 'fixture.txt']);
      assert.equal(mounted.code, 0, mounted.stderr);
      assert.equal(mounted.stdout.trim(), 'Rocketbrain mounted workspace');
      const prepared = await service.execute(root, ['cat', '/tmp/rocketbrain-devcontainer-ready']);
      assert.equal(prepared.code, 0, prepared.stderr);
      const marker = name === 'image' ? 'image' : 'build';
      assert.equal(prepared.stdout, 'ready-' + marker);
      const remoteEnvironment = await service.execute(root, ['printenv', 'ROCKETBRAIN_CONTAINER_FIXTURE']);
      assert.equal(remoteEnvironment.code, 0, remoteEnvironment.stderr);
      assert.equal(remoteEnvironment.stdout.trim(), 'managed-' + marker);
      const literal = await service.execute(root, ['printf', '%s', 'literal ; $argument']);
      assert.equal(literal.code, 0, literal.stderr);
      assert.equal(literal.stdout, 'literal ; $argument');
      const nonzero = await service.execute(root, ['sh', '-c', 'exit 7']);
      assert.equal(nonzero.code, 7, nonzero.stderr);
      if (name === 'dockerfile') {
        const built = await service.execute(root, ['cat', '/rocketbrain-devcontainer-build']);
        assert.equal(built.code, 0, built.stderr);
        assert.equal(built.stdout, 'built-dockerfile');
      }
      const stopped = await service.stop(root);
      assert.deepEqual(stopped, { state: 'stopped', id: started.id });
      assert.equal(await docker(['container', 'inspect', '--format', '{{.State.Running}}', started.id]), 'false');
      proof[name] = { cliVersion, workspace: started.workspaceFolder, mount: mounted.stdout.trim(), lifecycle: prepared.stdout,
        remoteEnvironment: remoteEnvironment.stdout.trim(), literal: literal.stdout, exitCode: nonzero.code, stopped: true };
    } finally {
      await service.stop(root);
      const actual = JSON.parse(await docker(['container', 'inspect', '--format', '{{json .}}', started.id]));
      assert.equal(actual.Id, started.id);
      assert.equal(actual.Config.Labels[sessionLabel], active.session);
      assert.equal(actual.State.Running, false);
      await docker(['container', 'rm', started.id]);
    }
  }
  if (receipt) await fs.writeFile(receipt, JSON.stringify(proof, null, 2) + '\n');
});
