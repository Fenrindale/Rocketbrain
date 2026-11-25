'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDockerWorkbench, dockerEnvironment } = require('../src/docker/workbench');

async function main() {
  assert.equal(process.platform, 'linux', 'Use the disposable Linux Docker verification environment.');
  assert.equal(process.env.ROCKETBRAIN_DOCKER_FIXTURE, '1', 'Enable the owned Docker fixture explicitly.');
  assert.ok((await fs.stat('/var/run/docker.sock')).isSocket());
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'rocketbrain-docker-fixture-'));
  const context = 'rb-fixture-' + randomUUID().replaceAll('-', '').slice(0, 12);
  const project = context;
  const reference = 'docker.io/library/busybox:1.37.0';
  const config = path.join(directory, 'config');
  const composeFile = path.join(directory, 'compose.yaml');
  const previous = process.env.DOCKER_CONFIG;
  const instance = createDockerWorkbench();
  let upAttempted = false;

  function docker(args) {
    return execFileSync('docker', args, { cwd: directory, env: dockerEnvironment(), encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  }
  const compose = ['--context', context, 'compose', '--file', composeFile, '--project-name', project];
  try {
    await fs.mkdir(config);
    process.env.DOCKER_CONFIG = config;
    await fs.writeFile(composeFile, JSON.stringify({ services: { worker: { image: reference,
      command: ['sh', '-c', 'echo rocketbrain-docker-ready; trap "exit 0" TERM INT; while :; do sleep 1; done'] } } }), { flag: 'wx' });
    docker(['context', 'create', context, '--docker', 'host=unix:///var/run/docker.sock']);
    assert.ok((await instance.contexts()).some(item => item.name === context));
    const selected = await instance.selectContext(await instance.inspectContext(context));
    const manifest = await instance.manifest(reference, { approved: true });
    assert.equal(manifest.schemaVersion, 2);
    assert.ok(Array.isArray(manifest.manifests) || Array.isArray(manifest.layers));
    upAttempted = true;
    docker([...compose, 'up', '-d']);

    const initial = await instance.inventory();
    const projectEntry = initial.compose.find(item => item.name === project);
    assert.ok(projectEntry);
    const containers = await instance.composeContainers(project);
    assert.equal(containers.length, 1);
    const [worker] = containers;
    assert.equal(worker.state, 'running');
    assert.ok(initial.images.some(item => item.repository.endsWith('busybox') && item.tag === '1.37.0'));
    const logs = await instance.logs(worker.id);
    assert.match(logs.stdout, /rocketbrain-docker-ready/);

    const reviewed = await instance.review(worker.id, 'stop');
    await assert.rejects(instance.apply(reviewed.token), /Approve/);
    await instance.apply(reviewed.token, { approved: true });
    assert.equal((await instance.inventory()).containers.find(item => item.id === worker.id).state, 'exited');
    await instance.apply((await instance.review(worker.id, 'start')).token, { approved: true });
    assert.equal((await instance.inventory()).containers.find(item => item.id === worker.id).state, 'running');
    const before = docker(['--context', context, 'container', 'inspect', '--format', '{{.State.StartedAt}}', worker.id]).trim();
    await instance.apply((await instance.review(worker.id, 'restart')).token, { approved: true });
    const after = docker(['--context', context, 'container', 'inspect', '--format', '{{.State.StartedAt}}', worker.id]).trim();
    assert.notEqual(before, after);
    assert.equal((await instance.inventory()).containers.find(item => item.id === worker.id).state, 'running');
    return { verified: true, docker: docker(['--context', context, 'version', '--format', '{{.Server.Version}}']).trim(),
      compose: docker(['--context', context, 'compose', 'version', '--short']).trim(), explicitDaemon: Boolean(selected.daemon),
      composeMembers: containers.length, approvedStopStartRestart: true, boundedLogs: true, registryManifest: true };
  } finally {
    instance.dispose();
    try { if (upAttempted) docker([...compose, 'down', '--remove-orphans']); }
    finally {
      if (previous === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = previous;
      const resolved = await fs.realpath(directory);
      assert.equal(path.dirname(resolved), parent);
      assert.match(path.basename(resolved), /^rocketbrain-docker-fixture-/);
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
}

main().then(proof => console.log(JSON.stringify(proof)), error => { console.error(error.message); process.exitCode = 1; });
