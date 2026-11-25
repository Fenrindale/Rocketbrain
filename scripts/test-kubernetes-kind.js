'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { executable, prepareKubernetesConfig } = require('../src/infra/kubernetes');

const run = promisify(execFile);
const namespace = 'rocketbrain-observed';
const otherNamespace = 'rocketbrain-other';
const chosen = 'reviewed-read-only';
const ambient = 'wrong-ambient';

async function verifyKindFixture() {
  assert.equal(process.env.ROCKETBRAIN_KUBE_KIND_NAME, 'rocketbrain-explorer');
  const admin = await fs.realpath(process.env.ROCKETBRAIN_KUBE_ADMIN_CONFIG);
  const folder = path.dirname(admin);
  assert.match(path.basename(folder), /^rb-kube-fixture-[A-Za-z0-9]{6}$/);
  assert.equal(path.dirname(folder), await fs.realpath(process.env.RUNNER_TEMP));
  assert.equal(path.basename(admin), 'admin.kubeconfig');
  const [kubectl, helm] = await Promise.all([executable('kubectl', process.env.ROCKETBRAIN_KUBECTL),
    executable('helm', process.env.ROCKETBRAIN_HELM)]);
  assert.ok(helm);
  const adminBytes = await fs.readFile(admin);
  const command = (args, file = admin, context = 'kind-rocketbrain-explorer') =>
    run(kubectl, ['--kubeconfig=' + file, '--context=' + context, '--request-timeout=10s', ...args],
      { timeout: 16000, maxBuffer: 512 * 1024 }).then(result => result.stdout, error => {
      if (args[0] === 'auth' && error.code === 1 && error.stdout.trim() === 'no') return 'no';
      throw Error('The disposable cluster command did not complete.');
    });
  const { clusters, contexts } = JSON.parse(await command(['config', 'view', '--raw', '--minify', '-o=json']));
  assert.equal(contexts[0].name, 'kind-rocketbrain-explorer');
  const route = clusters[0].cluster;
  assert.match(route.server, /^https:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
  assert.ok(route['certificate-authority-data']);
  const version = JSON.parse(await command(['version', '-o=json']));
  assert.equal(version.serverVersion.gitVersion, 'v1.36.4');
  const token = (await command(['--namespace=' + namespace, 'create', 'token', 'rocketbrain-reader', '--duration=20m'])).trim();
  assert.ok(/^[A-Za-z0-9_.-]{40,4096}$/.test(token));
  const observed = { name: 'owned-cluster', cluster: route };
  const dead = { name: 'unreachable-cluster', cluster: { ...route, server: 'https://127.0.0.1:1' } };
  const auth = { name: 'owned-reader', user: { token } };
  const context = (name, cluster) => ({ name, context: { cluster: cluster.name, user: auth.name, namespace } });
  const selectedFile = path.join(folder, 'selected-kubeconfig.json');
  const ambientFile = path.join(folder, 'ambient-kubeconfig.json');
  const config = (clusters, contexts) => JSON.stringify({ apiVersion: 'v1', kind: 'Config',
    'current-context': ambient, users: [auth], clusters, contexts });
  const oldAmbient = process.env.KUBECONFIG;
  let staged;
  try {
    await fs.writeFile(selectedFile, config([observed, dead], [context(chosen, observed), context(ambient, dead)]), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(ambientFile, config([dead], [context(ambient, dead)]), { mode: 0o600, flag: 'wx' });
    process.env.KUBECONFIG = ambientFile;
    assert.equal((await command(['--namespace=' + namespace, 'auth', 'can-i', 'delete', 'pods'], selectedFile, chosen)).trim(), 'no');
    staged = await prepareKubernetesConfig({ file: selectedFile, kubectl, helm });
    assert.deepEqual(staged.choices().map(row => row.name).sort(), [chosen, ambient]);
    assert.ok(!JSON.stringify(staged.choices()).includes(token));
    const session = await staged.select(chosen);
    assert.equal(session.scope.server, route.server);
    await fs.writeFile(selectedFile, '{}');
    const [namespaces, pods, services, deployments, releases] = await Promise.all([
      session.namespaces(), session.resources('pods', namespace), session.resources('services', namespace),
      session.resources('deployments', namespace), session.releases(namespace)
    ]);
    assert.ok(namespaces.rows.some(row => row.name === namespace));
    assert.ok(namespaces.rows.some(row => row.name === otherNamespace));
    const deployment = deployments.rows.find(row => row.name === 'rocketbrain-workload');
    assert.equal(deployment?.ready, 1);
    assert.equal(deployment.desired, 1);
    assert.deepEqual(services.rows.find(row => row.name === 'rocketbrain-service')?.ports, [{ port: 8080, protocol: 'TCP' }]);
    const pod = pods.rows.find(row => row.name.startsWith('rocketbrain-workload-'));
    assert.equal(pod?.phase, 'Running');
    assert.deepEqual([...pod.containers].sort(), ['main', 'sidecar']);
    const release = releases.rows.find(row => row.name === 'rocketbrain-fixture');
    assert.equal(release?.status, 'deployed');
    assert.equal(release.revision, '1');
    assert.equal(release.chart, 'rocketbrain-explorer-fixture-1.0.0');
    const primaryLogs = await session.podLogs(namespace, pod, 'main');
    const sidecarLogs = await session.podLogs(namespace, pod, 'sidecar');
    assert.match(primaryLogs.text, /rocketbrain-primary-log-ready/);
    assert.match(sidecarLogs.text, /rocketbrain-sidecar-log-ready/);
    assert.doesNotMatch(primaryLogs.text, /rocketbrain-sidecar-log-ready/);
    assert.doesNotMatch(sidecarLogs.text, /rocketbrain-primary-log-ready/);
    await assert.rejects(session.resources('pods', otherNamespace), /lacks permission/);
    await assert.rejects(session.podLogs(namespace, { ...pod, uid: 'stale-uid' }, 'main'), /pod or container changed/);
    assert.ok((await fs.readFile(admin)).equals(adminBytes), 'The fixture admin kubeconfig must remain unchanged.');
    return { kubernetes: version.serverVersion.gitVersion, kubectl: version.clientVersion.gitVersion,
      pinnedContext: true, wrongAmbientIgnored: true, sourceChangeIgnored: true, namespaceRows: namespaces.rows.length,
      deploymentReady: true, servicePorts: true, podContainers: 2, scopedLogSnapshots: true,
      stalePodRejected: true, helmReleaseRevision: release.revision, otherNamespaceDenied: true,
      readerDeleteDenied: true, adminConfigUnchanged: true };
  } finally {
    try { await staged?.close(); }
    finally {
      if (oldAmbient === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = oldAmbient;
      for (const file of [selectedFile, ambientFile]) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

if (require.main === module) verifyKindFixture().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { verifyKindFixture };
