'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { createDevContainers, cliVersion, sessionLabel } = require('../src/devcontainer/runtime');
const { openFixtureForward, checkHttp, attachJdwp, waitForReleasedPort } = require('./devcontainer-port-fixture');

const executeFile = promisify(execFile);
const fixture = path.join(__dirname, 'fixtures', 'devcontainer');
const cliPath = process.env.ROCKETBRAIN_DEVCONTAINER_CLI_PATH;
const inventoryProbe = process.env.ROCKETBRAIN_DEVCONTAINER_INSPECT_DOCKER_PATH;
const dockerPath = process.env.ROCKETBRAIN_DEVCONTAINER_DOCKER_PATH;
const live = process.env.ROCKETBRAIN_DEVCONTAINER_LIVE === 'true';
const receipt = process.env.ROCKETBRAIN_DEVCONTAINER_RECEIPT;
const runningId = 'c'.repeat(64);
const dependencyId = 'b'.repeat(64);
const composeLabel = 'com.docker.compose.project';
const approved = plan => ({ file: plan.file, fingerprint: plan.fingerprint, allowProjectExecution: true });
const response = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });

function runWithFixtureTrace(executable, args, { cwd, env, timeout }) {
  const specStart = args[1] === 'up';
  const argv = specStart ? [...args, '--log-level', 'debug'] : args;
  return new Promise((resolve, reject) => {
    const child = execFile(executable, argv, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(Error('The owned Docker fixture process did not complete.'));
      if (error && specStart) {
        const text = [stdout, stderr].join('\n').replace(/fixture-secret-[0-9a-f-]+/giu, '[fixture value]');
        const diagnostics = text.split(/\r?\n/u).filter(line => /error|failed|denied|not found/iu.test(line)).slice(-14);
        console.error(diagnostics.map(line => line.slice(0, 1000)).join('\n'));
      }
      resolve({ code: error?.code || 0, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

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

async function modeledService(context, { trusted = true, failAfterCreation = false } = {}) {
  const { root, owned } = await tempFixture(context, 'image');
  const packageFolder = path.join(owned, 'cli');
  await fs.mkdir(packageFolder);
  await fs.writeFile(path.join(packageFolder, 'package.json'), JSON.stringify({ name: '@devcontainers/cli', version: cliVersion }));
  await fs.writeFile(path.join(packageFolder, 'devcontainer.js'), '');
  const sessions = new Map();
  const state = { running: false, label: undefined, calls: [], host: 'unix:///var/run/docker.sock', python: true,
    trusted, networkMode: 'default', startedAt: '2026-01-01T03:00:00.000Z', workspaceOpen: true };
  const engine = {
    trusted: () => state.trusted,
    workspaceOpen: () => state.workspaceOpen,
    settings: () => ({ cliPath: packageFolder, nodePath: process.execPath, dockerPath: process.execPath }),
    readSession: key => sessions.get(key),
    writeSession: (key, value) => value ? sessions.set(key, value) : sessions.delete(key),
    async run(_, args) {
      state.calls.push(args);
      if (args[0] === 'context') return response(state.host);
      if (args[1] === 'read-configuration') return response({
        configuration: { image: 'ubuntu:24.04', name: 'fixture' },
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
        State: { Running: state.running, StartedAt: state.startedAt }, HostConfig: { NetworkMode: state.networkMode } });
      if (args[2] === 'exec') {
        assert.deepEqual(args.slice(3, 9), ['--interactive', runningId, 'python3', '-I', '-S', '-u']);
        return state.python ? response('') : {code: 1};
      }
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

test('Loopback forwarding relays binary bytes after exact review and closes on a new container generation', { timeout: 15000 }, async context => {
  const { root, state, engine } = await modeledService(context);
  let bridges = 0;
  const service = createDevContainers({ ...engine, startBridge(target, id, port) {
    assert.equal(target.host, state.host);
    assert.equal(id, runningId);
    assert.equal(port, 6789);
    bridges++;
    return spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'ignore'] });
  } });
  context.after(() => service.dispose());
  await assert.rejects(service.inspectPort(root, { containerPort: 6789 }), /before forwarding/);
  await service.start(root, approved(await service.inspect(root)));
  await assert.rejects(service.inspectPort(root, { containerPort: '6789' }), /container TCP port/);
  await assert.rejects(service.inspectPort(root, { containerPort: 6789, localPort: 81 }), /local port/);
  state.networkMode = 'host';
  await assert.rejects(service.inspectPort(root, { containerPort: 6789 }), /own network namespace/);
  state.networkMode = 'default';
  state.python = false;
  await assert.rejects(service.inspectPort(root, { containerPort: 6789 }), /requires Python 3/);
  state.python = true;
  const review = await service.inspectPort(root, { containerPort: 6789 });
  assert.equal(review.localPort, 0);
  await assert.rejects(service.forwardPort(root, { token: review.token }), /approve/);
  const forward = await service.forwardPort(root, { token: review.token, allowLoopbackAccess: true });
  await assert.rejects(service.forwardPort(root, { token: review.token, allowLoopbackAccess: true }), /current port forwarding review/);
  assert.deepEqual((await service.status(root)).forwards, [forward]);
  const socket = net.createConnection({ host: forward.host, port: forward.localPort });
  await once(socket, 'connect');
  const payload = Buffer.from([0x00, 0xff, 0x05, 0x0a, 0x11]);
  socket.write(payload);
  const [echo] = await once(socket, 'data');
  assert.deepEqual(echo, payload);
  assert.equal(bridges, 1);
  const socketClosed = once(socket, 'close');
  state.startedAt = '2026-01-01T03:00:03.000Z';
  await socketClosed;
  await waitForReleasedPort(forward);
  assert.deepEqual(await service.forwardedPorts(root), []);
  const retry = await openFixtureForward(service, root, 6789, forward.localPort);
  await service.closePort(root, retry.id);
  await waitForReleasedPort(retry);
  await assert.rejects(service.closePort(root, retry.id), /current port forward/);
});

test('Port forwarding rechecks context and source, rejects port collisions and releases on stop and close', { timeout: 15000 }, async context => {
  const { root, state, service } = await modeledService(context);
  context.after(() => service.dispose());
  const input = { containerPort: 5005 };
  await service.start(root, approved(await service.inspect(root)));
  const review = await service.inspectPort(root, input);
  state.host = 'unix:///var/run/other.sock';
  await assert.rejects(service.forwardPort(root, { token: review.token, allowLoopbackAccess: true }), /selected local Docker route changed/);
  state.host = 'unix:///var/run/docker.sock';
  const forward = await openFixtureForward(service, root, 5005);
  const collision = await service.inspectPort(root, { ...input, localPort: forward.localPort });
  await assert.rejects(service.forwardPort(root, { token: collision.token, allowLoopbackAccess: true }), /loopback port could not be opened/);
  assert.deepEqual(await service.forwardedPorts(root), [forward]);
  const second = await openFixtureForward(service, root, 9000);
  await service.stop(root);
  await Promise.all([waitForReleasedPort(forward), waitForReleasedPort(second)]);
  await service.start(root, approved(await service.inspect(root)));
  const changed = await service.inspectPort(root, input);
  const descriptor = path.join(root, '.devcontainer', 'devcontainer.json');
  await fs.appendFile(descriptor, '\n');
  await assert.rejects(service.forwardPort(root, { token: changed.token, allowLoopbackAccess: true }), /configuration changed/);
  await service.stop(root);
  await service.start(root, approved(await service.inspect(root)));
  const third = await openFixtureForward(service, root, 5005);
  state.workspaceOpen = false;
  await waitForReleasedPort(third);
  state.workspaceOpen = true;
  const fourth = await openFixtureForward(service, root, 5005);
  service.dispose();
  await waitForReleasedPort(fourth);
  assert.deepEqual(await service.forwardedPorts(root), []);
});

async function modeledCompose(context,{partial=false}={}) {
  const {root,owned}=await tempFixture(context,'compose');
  const packageFolder=path.join(owned,'cli'), config=JSON.parse(await fs.readFile(path.join(root,'.devcontainer.json'),'utf8'));
  await fs.mkdir(packageFolder);
  await fs.writeFile(path.join(packageFolder,'package.json'),JSON.stringify({name:'@devcontainers/cli',version:cliVersion}));
  await fs.writeFile(path.join(packageFolder,'devcontainer.js'),'');
  const state={calls:[],containers:new Map(),sessions:new Map(),resolved:'owner-only test value'};
  const engine={
    trusted:()=>true,
    settings:()=>({cliPath:packageFolder,nodePath:process.execPath,dockerPath:process.execPath}),
    readSession:key=>state.sessions.get(key),
    writeSession:(key,value)=>value?state.sessions.set(key,value):state.sessions.delete(key),
    async run(_,args,{env}){
      state.calls.push(args);
      if(args[0]==='context')return response('unix:///var/run/docker.sock');
      if(args[1]==='read-configuration')return response({configuration:config,workspace:{workspaceFolder:config.workspaceFolder}});
      if(args[1]==='compose') {
        const project=args[args.indexOf('--project-name')+1];
        assert.equal(env.COMPOSE_PROJECT_NAME,project);
        return response({name:project,services:{
          workspace:{image:'ubuntu:24.04',environment:{OWNED_VALUE:state.resolved},depends_on:{dependency:{condition:'service_started'}}},
          dependency:{image:'busybox:1.37.0'}
        },networks:{default:{name:project+'_default'}}});
      }
      if(args[1]==='up') {
        const project=env.COMPOSE_PROJECT_NAME,owner=args.find(arg=>arg.startsWith(sessionLabel+'=')).slice(sessionLabel.length+1);
        assert.match(project,/^rocketbraindc[a-f0-9]{32}$/u);
        state.containers.set(dependencyId,{id:dependencyId,project,service:'dependency',owner:'',oneOff:'False',running:true});
        if(partial)return {code:1,stdout:'',stderr:'partial owned test start'};
        state.containers.set(runningId,{id:runningId,project,service:'workspace',owner,oneOff:'False',running:true});
        return response({outcome:'success',containerId:runningId,remoteWorkspaceFolder:config.workspaceFolder});
      }
      if(args[1]==='exec') {
        assert.equal(env.COMPOSE_PROJECT_NAME,state.containers.get(runningId).project);
        assert.equal(args[args.indexOf('--container-id')+1],runningId);
        return {code:0,stdout:'owned output',stderr:''};
      }
      if(args[2]==='ls') {
        const project=args.at(-1).slice(('label='+composeLabel+'=').length);
        assert.ok(args.at(-1).startsWith('label='+composeLabel+'='));
        return response([...state.containers.values()].filter(row=>row.project===project).map(row=>row.id).join('\n'));
      }
      if(args[2]==='inspect')return response(state.containers.get(args.at(-1)));
      if(args[2]==='stop') {
        for(const id of args.slice(5))state.containers.get(id).running=false;
        return response(args.slice(5).join('\n'));
      }
      throw Error('Unexpected Compose verification invocation.');
    },
  };
  return {root,state,engine,service:createDevContainers(engine)};
}

test('Compose verifies the exact reviewed project, app and dependency through resume and stop',async context=>{
  const {root,state,engine,service}=await modeledCompose(context);
  const plan=await service.inspect(root);
  assert.equal(plan.kind,'compose');
  assert.deepEqual(plan.compose.files,['compose.yaml','compose.workspace.yaml']);
  assert.deepEqual(plan.compose.services,['workspace','dependency']);
  assert.ok(!JSON.stringify(plan).includes(state.resolved));
  assert.equal(plan.compose.signature,undefined);
  const unrelated='e'.repeat(64);
  state.containers.set(unrelated,{id:unrelated,project:'another-project',service:'workspace',owner:'',oneOff:'False',running:true});
  const started=await service.start(root,approved(plan));
  assert.equal(started.id,runningId);
  assert.ok(!JSON.stringify(started).includes(state.resolved));
  assert.deepEqual(started.services.map(row=>[row.service,row.id]),[['workspace',runningId],['dependency',dependencyId]]);
  assert.equal((await service.execute(root,['printf','%s','literal ; $argument'])).stdout,'owned output');
  const resumed=createDevContainers(engine);
  assert.equal((await resumed.status(root)).state,'running');
  state.containers.get(dependencyId).running=false;
  assert.equal((await resumed.status(root)).state,'partial');
  await assert.rejects(resumed.execute(root,['cat','fixture.txt']),/not all running/);
  assert.equal((await resumed.stop(root)).state,'stopped');
  assert.equal(state.containers.get(runningId).running,false);
  assert.equal(state.containers.get(unrelated).running,true);
  assert.deepEqual(await resumed.status(root),{state:'none'});
  await assert.rejects(resumed.start(root,approved(plan)),/fresh Compose/);
});

test('Compose refuses changed files, changed resolved environment and pre-existing project containers',async context=>{
  const {root,state,service}=await modeledCompose(context);
  const old=await service.inspect(root);
  await fs.appendFile(path.join(root,'compose.workspace.yaml'),'\n# changed exact bytes\n');
  await assert.rejects(service.start(root,approved(old)),/changed/);
  const current=await service.inspect(root);
  const id='d'.repeat(64);
  state.containers.set(id,{id,project:current.compose.project,service:'workspace',owner:'foreign',oneOff:'False',running:true});
  await assert.rejects(service.start(root,approved(current)),/already has containers/);
  assert.ok(!state.calls.some(args=>args[1]==='up'));
  state.containers.delete(id);
  await service.start(root,approved(current));
  state.resolved='changed effective interpolation';
  await assert.rejects(service.execute(root,['cat','fixture.txt']),/resolved configuration changed/);
  state.containers.get(dependencyId).owner='other-owner';
  await assert.rejects(service.stop(root),/ownership changed/);
  assert.ok(!state.calls.some(args=>args[2]==='stop'));
});

test('Compose can stop a verified dependency after an uncertain app launch and refuses a replaced service ID',async context=>{
  const partial=await modeledCompose(context,{partial:true});
  await assert.rejects(partial.service.start(partial.root,approved(await partial.service.inspect(partial.root))),/could not start/);
  const resumed=createDevContainers(partial.engine);
  assert.equal((await resumed.status(partial.root)).state,'partial');
  assert.equal((await resumed.stop(partial.root)).state,'stopped');
  assert.equal(partial.state.containers.get(dependencyId).running,false);

  const {root,state,service}=await modeledCompose(context);
  await service.start(root,approved(await service.inspect(root)));
  const dependency=state.containers.get(dependencyId),changed='a'.repeat(64);
  state.containers.delete(dependencyId);
  state.containers.set(changed,{...dependency,id:changed});
  await assert.rejects(service.stop(root),/ownership changed/);
  assert.ok(!state.calls.some(args=>args[2]==='stop'));
});

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

test('Dev Container rejects untrusted workspaces, stale review and foreign labels', async context => {
  const blocked = await modeledService(context, { trusted: false });
  await assert.rejects(blocked.service.inspect(blocked.root), /Trust/);
  assert.deepEqual(blocked.state.calls, []);
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

test('actual local Docker starts image, Dockerfile and Compose Dev Containers and stops only verified IDs', {
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
  const {root}=await tempFixture(context,'compose');
  const sessions=new Map();
  const service=createDevContainers({trusted:()=>true,settings:()=>({nodePath:process.execPath,cliPath,dockerPath}),
    readSession:key=>sessions.get(key),writeSession:(key,value)=>value?sessions.set(key,value):sessions.delete(key),
    run:runWithFixtureTrace});
  const docker=async args=>(await executeFile(dockerPath||'docker',args,{cwd:root,windowsHide:true,timeout:60000,maxBuffer:1024*1024})).stdout.trim();
  const marker=randomUUID();
  const unrelatedLabel='rocketbrain.devcontainer.fixture-isolation='+marker;
  const unrelated=await docker(['run','--detach','--label',unrelatedLabel,'ubuntu:24.04','sleep','infinity']);
  assert.match(unrelated,/^[a-f0-9]{64}$/u);
  let started, recorded;
  try {
    await fs.writeFile(path.join(root,'.env'),'ROCKETBRAIN_COMPOSE_VALUE=fixture-secret-'+marker+'\n');
    const plan=await service.inspect(root);
    assert.equal(plan.kind,'compose');
    assert.deepEqual(plan.compose.files,['compose.yaml','compose.workspace.yaml']);
    assert.deepEqual(plan.compose.services,['workspace','dependency']);
    assert.ok(!JSON.stringify(plan).includes('fixture-secret-'+marker));
    assert.equal(plan.compose.signature,undefined);
    started=await service.start(root,approved(plan));
    recorded=[...sessions.values()][0];
    assert.equal(started.kind,'compose');
    assert.equal(started.workspaceFolder,'/workspaces/compose');
    assert.equal(started.services[0].id,started.id);
    assert.equal(started.project,plan.compose.project);
    assert.equal((await service.status(root)).state,'running');
    const file=await service.execute(root,['cat','fixture.txt']);
    assert.equal(file.code,0);
    assert.equal(file.stdout.trim(),'Rocketbrain mounted workspace');
    const lifecycle=await service.execute(root,['cat','/tmp/rocketbrain-devcontainer-ready']);
    assert.equal(lifecycle.code,0);
    assert.equal(lifecycle.stdout.trim(),'ready-compose');
    const dependency=await service.execute(root,['bash','-c',
      "exec 3<>/dev/tcp/dependency/8080; printf 'GET /ready HTTP/1.0\\r\\n\\r\\n' >&3; cat <&3"]);
    assert.equal(dependency.code,0);
    assert.match(dependency.stdout,/ready-dependency/u);
    for(const row of started.services){
      const labels=JSON.parse(await docker(['inspect','--format','{{json .Config.Labels}}',row.id]));
      assert.equal(labels[composeLabel],started.project);
      assert.equal(labels['com.docker.compose.service'],row.service);
      if(row.service==='workspace')assert.equal(labels[sessionLabel],recorded.session);
      else assert.equal(labels[sessionLabel],undefined);
    }
    const dockerPublishedPorts = JSON.parse(await docker(['inspect','--format','{{json .HostConfig.PortBindings}}',started.id]));
    assert.equal(Object.keys(dockerPublishedPorts ?? {}).length, 0);
    const http = await openFixtureForward(service, root, 8787);
    const jdwp = await openFixtureForward(service, root, 5005);
    assert.equal((await service.status(root)).forwards.length, 2);
    await checkHttp(http);
    const debuggerClient = await attachJdwp(jdwp);
    await service.closePort(root, jdwp.id);
    await debuggerClient.close;
    await waitForReleasedPort(jdwp);
    await checkHttp(http);
    const interrupted = await openFixtureForward(service, root, 5005);
    const interruptedClient = await attachJdwp(interrupted);
    await docker(['container','stop','--time','1',started.id]);
    await interruptedClient.close;
    await Promise.all([waitForReleasedPort(http), waitForReleasedPort(interrupted)]);
    assert.deepEqual(await service.forwardedPorts(root), []);
    await docker(['container','start',started.id]);
    const resumed = await openFixtureForward(service, root, 8787);
    await checkHttp(resumed);
    await fs.appendFile(path.join(root,'compose.workspace.yaml'),'\n# changed after start\n');
    await assert.rejects(service.execute(root,['cat','fixture.txt']),/resolved configuration changed/);
    await assert.rejects(service.inspectPort(root,{containerPort:8787}),/reviewed Compose workspace or configuration changed/);
    const stopped=await service.stop(root);
    assert.equal(stopped.state,'stopped');
    assert.ok(stopped.services.every(row=>!row.running));
    await waitForReleasedPort(resumed);
    assert.equal(await docker(['inspect','--format','{{.State.Running}}',unrelated]),'true');
    proof.compose={cliVersion,files:plan.compose.files,appService:plan.compose.service,services:plan.compose.services,
      projectIsolated:true,labelsVerified:true,exactContainerCount:stopped.services.length,
      mountedFile:true,lifecycle: lifecycle.stdout.trim(),dependencyRead:true,sourceDriftRefused:true,stopPreservedUnrelated:true,secretsOmitted:true,
      portForwarding:{ realHttp:true, realJdwpVersion:true, ipv4LoopbackOnly:true, dockerPublishedPorts:false, concurrentForwards:2,
        individualClose:true, releaseOnContainerExit:true, freshReviewAfterRestart:true, releaseOnManagedStop:true, changedComposeRefused:true }};
  } finally {
    try {
      await service.stop(root);
      if(started)for(const row of started.services){
        const actual=JSON.parse(await docker(['inspect','--format','{{json .}}',row.id]));
        assert.equal(actual.Id,row.id);
        assert.equal(actual.Config.Labels[composeLabel],started.project);
        assert.equal(actual.Config.Labels['com.docker.compose.service'],row.service);
        if(row.service==='workspace')assert.equal(actual.Config.Labels[sessionLabel],recorded.session);
        assert.equal(actual.State.Running,false);
        await docker(['container','rm',row.id]);
      }
    } finally {
      service.dispose();
      const unrelatedActual=JSON.parse(await docker(['inspect','--format','{{json .}}',unrelated]));
      assert.equal(unrelatedActual.Id,unrelated);
      assert.equal(unrelatedActual.Config.Labels['rocketbrain.devcontainer.fixture-isolation'],marker);
      await docker(['container','rm','-f',unrelated]);
    }
  }
  if (receipt) await fs.writeFile(receipt, JSON.stringify(proof, null, 2) + '\n');
});
