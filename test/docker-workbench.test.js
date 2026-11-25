'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDockerWorkbench, dockerEnvironment } = require('../src/docker/workbench');

const id = 'a'.repeat(64);

function fixture() {
  const calls = [];
  const data = { endpoint: 'unix:///var/run/docker.sock', daemon: 'docker-fixture-daemon', state: 'running', trusted: true, compose: true };
  const response = value => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const workbench = createDockerWorkbench({ trusted: () => data.trusted, async run(args, options) {
    calls.push({ args, options });
    if (args[0] === 'context') return response(args[1] === 'ls' ? { Name: 'owned' } : { Name: 'owned', Endpoints: { docker: { Host: data.endpoint } } });
    assert.deepEqual(args.slice(0, 2), ['--context', 'owned']);
    const [area, action] = args.slice(2);
    if (area === 'info') return response(data.daemon);
    if (area === 'image') return response({ ID: 'sha256:image', Repository: 'docker.io/library/busybox', Tag: '1.37.0', Size: '1MB' });
    if (area === 'compose') {
      if (!data.compose) throw Object.assign(Error('plugin unavailable'), { code: 'DOCKER_COMMAND_FAILED' });
      return response([{ Name: 'owned-project', Status: 'running(1)', ConfigFiles: 'ignored-local-config.yml' }]);
    }
    if (area === 'manifest') return response({ schemaVersion: 2, manifests: [] });
    if (action === 'ls') return response({ ID: id, Names: 'owned-service-1', Image: 'busybox:1.37.0', Status: 'Up', State: data.state });
    if (action === 'inspect') return response(JSON.stringify(data.state));
    if (action === 'logs') return { stdout: 'ready\n', stderr: 'container stderr\n' };
    assert.equal(args.at(-1), id);
    data.state = action === 'stop' ? 'exited' : 'running';
    return response(id);
  } });
  const select = async () => workbench.selectContext(await workbench.inspectContext('owned'));
  return { workbench, data, calls, select };
}

test('Docker inventory checks trust and pins all daemon commands to the chosen context and identity', async () => {
  const { workbench, data, calls, select } = fixture();
  data.trusted = false;
  await assert.rejects(workbench.contexts(), /Trust the workspace/);
  assert.equal(calls.length, 0);
  data.trusted = true;
  await assert.rejects(workbench.inventory(), /Choose a Docker context/);
  assert.deepEqual(await workbench.contexts(), [{ name: 'owned' }]);
  await select();
  const snapshot = await workbench.inventory();
  assert.equal(snapshot.context.daemon, data.daemon);
  assert.equal(snapshot.containers[0].id, id);
  assert.equal(snapshot.images[0].tag, '1.37.0');
  assert.equal(snapshot.compose[0].name, 'owned-project');
  assert.equal(Object.hasOwn(snapshot.compose[0], 'ConfigFiles'), false);
  assert.equal((await workbench.composeContainers('owned-project'))[0].id, id);
  assert.ok(calls.some(call => call.args.includes('label=com.docker.compose.project=owned-project')));
  await assert.rejects(workbench.composeContainers('--other-context'), /select a Compose project/);
  assert.deepEqual(dockerEnvironment({ Docker_Host: 'other', DOCKER_CONTEXT: 'mixed', DOCKER_TLS: '1', PATH: 'tools', DOCKER_CONFIG: 'config' }),
    { PATH: 'tools', DOCKER_CONFIG: 'config' });
  data.endpoint = 'unix:///different.sock';
  await assert.rejects(workbench.inventory(), /context changed/);
});

test('Docker lifecycle requires current approved review and rejects endpoint or daemon changes', async () => {
  const { workbench, data, select } = fixture();
  await select();
  await workbench.inventory();
  await assert.rejects(workbench.review(id.slice(0, 12), 'stop'), /exact container/);
  await assert.rejects(workbench.review(id, 'rm'), /does not allow/);
  const review = await workbench.review(id, 'stop');
  await assert.rejects(workbench.apply(review.token), /Approve/);
  await workbench.apply(review.token, { approved: true });
  assert.equal(data.state, 'exited');
  await assert.rejects(workbench.apply(review.token, { approved: true }), /Approve/);
  await workbench.inventory();
  const restart = await workbench.review(id, 'start');
  data.state = 'running';
  await assert.rejects(workbench.apply(restart.token, { approved: true }), /state changed/);
  await workbench.inventory();
  const stop = await workbench.review(id, 'stop');
  data.daemon = 'docker-another-daemon';
  await assert.rejects(workbench.apply(stop.token, { approved: true }), /daemon changed/);
  assert.equal(data.state, 'running');
});

test('Docker logs and registry manifests are bounded and Compose can be absent', async () => {
  const { workbench, data, calls, select } = fixture();
  await select();
  data.compose = false;
  const inventory = await workbench.inventory();
  assert.match(inventory.composeError, /unavailable/);
  const { stdout, stderr } = await workbench.logs(id);
  assert.equal(stdout, 'ready\n');
  assert.equal(stderr, 'container stderr\n');
  const call = calls.find(item => item.args[3] === 'logs');
  assert.ok(call.args.includes('200') && !call.args.includes('--follow'));
  assert.equal(call.options.maxBuffer, 128 * 1024);
  for (const ref of ['--insecure', 'busybox:latest', 'reg.example/app:tag\nwrong']) {
    await assert.rejects(workbench.manifest(ref, { approved: true }), /registry-qualified/);
  }
  await assert.rejects(workbench.manifest('reg.example/app:stable'), /approved/);
  assert.equal((await workbench.manifest('reg.example/app:stable', { approved: true })).schemaVersion, 2);
});
