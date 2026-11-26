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

function authorizationDenied(args, error) {
  const words = args.filter(item => !item.startsWith('--'));
  return words[0] === 'auth' && words[1] === 'can-i' && error.code === 1 && /^no(?: - [^\r\n]+)?$/.test(error.stdout?.trim() ?? '');
}

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
  const command = (args, file = admin, context = 'kind-rocketbrain-explorer') => {
    const operation = args.find(item => !item.startsWith('--'));
    return run(kubectl, ['--kubeconfig=' + file, '--context=' + context, '--request-timeout=10s', ...args],
      { timeout: 16000, maxBuffer: 512 * 1024 }).then(result => result.stdout, error => {
      if (authorizationDenied(args, error)) return 'no';
      throw Error('The disposable cluster operation ' + operation + ' did not complete.');
    });
  };
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
  const scalerFile = path.join(folder, 'scaler-kubeconfig.json');
  const providerConfig = path.join(folder, 'provider-kubeconfig.json');
  const provider = path.join(folder, 'reviewed-credential-helper');
  const providerResponse = path.join(folder, 'credential-response.json');
  const providerCalls = path.join(folder, 'credential-calls');
  const config = (clusters, contexts) => JSON.stringify({ apiVersion: 'v1', kind: 'Config',
    'current-context': ambient, users: [auth], clusters, contexts });
  const oldAmbient = process.env.KUBECONFIG;
  let staged, scaler, helmFixture, execFixture;
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
    assert.equal(release.revision, '2');
    assert.equal(release.chart, 'rocketbrain-explorer-fixture-1.0.0');
    const primaryLogs = await session.podLogs(namespace, pod, 'main');
    const sidecarLogs = await session.podLogs(namespace, pod, 'sidecar');
    assert.match(primaryLogs.text, /rocketbrain-primary-log-ready/);
    assert.match(sidecarLogs.text, /rocketbrain-sidecar-log-ready/);
    assert.doesNotMatch(primaryLogs.text, /rocketbrain-sidecar-log-ready/);
    assert.doesNotMatch(sidecarLogs.text, /rocketbrain-primary-log-ready/);
    await assert.rejects(session.resources('pods', otherNamespace), /lacks permission/);
    await assert.rejects(session.podLogs(namespace, { ...pod, uid: 'stale-uid' }, 'main'), /pod or container changed/);
    const deploymentName = 'rocketbrain-workload';
    await assert.rejects(session.reviewDeploymentScale(namespace, deploymentName, 0), /lacks permission/);
    const scalerToken = (await command(['--namespace=' + namespace, 'create', 'token', 'rocketbrain-scaler', '--duration=20m'])).trim();
    assert.ok(/^[A-Za-z0-9_.-]{40,4096}$/.test(scalerToken));
    const scaleContext = 'reviewed-scaler';
    await fs.writeFile(scalerFile, JSON.stringify({
      apiVersion: 'v1', kind: 'Config', 'current-context': scaleContext, clusters: [observed],
      users: [{ name: 'scaler', user: { token: scalerToken } }],
      contexts: [{ name: scaleContext, context: { cluster: observed.name, user: 'scaler', namespace } }]
    }), { flag: 'wx', mode: 0o600 });
    scaler = await prepareKubernetesConfig({ file: scalerFile, kubectl, helm });
    const scaleSession = await scaler.select(scaleContext);
    const readDesired = async () => Number((await command(['--namespace=' + namespace, 'get', 'deployment', deploymentName,
      '-o=jsonpath={.spec.replicas}'])).trim());
    const stale = await scaleSession.reviewDeploymentScale(namespace, deploymentName, 0);
    assert.equal(await readDesired(), 1);
    await command(['--namespace=' + namespace, 'annotate', 'deployment', deploymentName, 'rocketbrain/scale-fixture=changed']);
    await assert.rejects(scaleSession.applyDeploymentScale(stale, { approved: true }), /Deployment changed/);
    assert.equal(await readDesired(), 1);
    const reviewed = await scaleSession.reviewDeploymentScale(namespace, deploymentName, 0);
    await assert.rejects(scaleSession.applyDeploymentScale({ ...reviewed }, { approved: true }), /Approve a current/);
    await assert.rejects(scaleSession.applyDeploymentScale(reviewed), /Approve a current/);
    assert.equal(await readDesired(), 1);
    assert.deepEqual(await scaleSession.applyDeploymentScale(reviewed, { approved: true }), {
      namespace, name: deploymentName, desired: 0, observed: 0
    });
    assert.equal(await readDesired(), 0);
    await assert.rejects(scaleSession.applyDeploymentScale(reviewed, { approved: true }), /Approve a current/);
    await command(['--namespace=' + namespace, 'rollout', 'status', 'deployment/' + deploymentName, '--timeout=8s']);
    const restore = await scaleSession.reviewDeploymentScale(namespace, deploymentName, 1);
    assert.equal((await scaleSession.applyDeploymentScale(restore, { approved: true })).observed, 1);
    assert.equal(await readDesired(), 1);
    helmFixture = await prepareKubernetesConfig({ file: admin, kubectl, helm });
    const helmSession = await helmFixture.select('kind-rocketbrain-explorer');
    const releaseName = 'rocketbrain-fixture';
    const history = () => helmSession.helm.history(namespace, releaseName);
    assert.deepEqual((await history()).map(row => [row.revision, row.status]), [[2, 'deployed'], [1, 'superseded']]);
    const readMarker = async () => JSON.parse(await command(['--namespace=' + namespace, 'get', 'deployment', deploymentName,
      '-o=json'])).metadata.annotations['rocketbrain/revision-fixture'];
    assert.equal(await readMarker(), 'second');
    const rollback = await helmSession.helm.review(namespace, releaseName, 1);
    assert.deepEqual(rollback.resources.find(item => item.name === deploymentName),
      { kind: 'Deployment', name: deploymentName, changed: true });
    assert.equal(await readMarker(), 'second');
    assert.equal((await history())[0].revision, 2);
    await assert.rejects(helmSession.helm.apply(rollback), /Approve a current/);
    await assert.rejects(helmSession.helm.apply({ ...rollback }, { approved: true }), /Approve a current/);
    const restored = await helmSession.helm.apply(rollback, { approved: true });
    assert.deepEqual(restored, { namespace, release: releaseName, previousRevision: 2, restoredFrom: 1, recordedRevision: 3 });
    await assert.rejects(helmSession.helm.apply(rollback, { approved: true }), /Approve a current/);
    assert.equal(await readMarker(), 'first');
    assert.deepEqual((await history()).map(row => [row.revision, row.status]), [[3, 'deployed'], [2, 'superseded'], [1, 'superseded']]);
    const baseProvider = await fs.realpath(process.env.ROCKETBRAIN_KUBE_EXEC_PROVIDER);
    assert.equal(baseProvider, path.join(folder, 'credential-helper'));
    await fs.writeFile(provider, await fs.readFile(baseProvider), { flag: 'wx', mode: 0o500 });
    const versionName = 'client.authentication.k8s.io/v1';
    await fs.writeFile(providerResponse, JSON.stringify({ apiVersion: versionName, kind: 'ExecCredential',
      status: { token, expirationTimestamp: new Date(Date.now() + 5 * 60000).toISOString() } }), { flag: 'wx', mode: 0o600 });
    const providerContext = 'reviewed-provider';
    await fs.writeFile(providerConfig, JSON.stringify({
      apiVersion: 'v1', kind: 'Config', 'current-context': providerContext, clusters: [observed],
      users: [{ name: 'provider', user: { exec: { apiVersion: versionName, command: provider,
        args: [providerResponse, providerCalls], interactiveMode: 'Never', provideClusterInfo: false } } }],
      contexts: [{ name: providerContext, context: { cluster: observed.name, user: 'provider', namespace } }]
    }), { flag: 'wx', mode: 0o600 });
    execFixture = await prepareKubernetesConfig({ file: providerConfig, kubectl, helm });
    assert.equal(execFixture.choices()[0].credential, 'reviewed-executable');
    const providerReview = await execFixture.reviewCredential(providerContext);
    assert.equal(providerReview.file, provider);
    assert.match(providerReview.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(execFixture.select(providerContext), /Approve the reviewed credential executable/);
    await assert.rejects(fs.stat(providerCalls), { code: 'ENOENT' });
    const providerSession = await execFixture.select(providerContext, {
      credentialReview: providerReview, approvedExecutable: true
    });
    await assert.rejects(fs.stat(providerCalls), { code: 'ENOENT' });
    await fs.chmod(provider, 0o700);
    await fs.writeFile(provider, 'changed after the reviewed bytes were staged');
    assert.ok((await providerSession.resources('deployments', namespace)).rows.some(row => row.name === deploymentName));
    assert.ok((await providerSession.releases(namespace)).rows.some(row => row.name === releaseName && row.revision === '3'));
    assert.ok((await fs.readFile(providerCalls)).length >= 2);
    await assert.rejects(providerSession.resources('pods', otherNamespace), /lacks permission/);
    assert.ok(!JSON.stringify(providerSession.scope).includes(token));
    assert.ok((await fs.readFile(admin)).equals(adminBytes), 'The fixture admin kubeconfig must remain unchanged.');
    return { sourceCommit: process.env.GITHUB_SHA, kubernetes: version.serverVersion.gitVersion, kubectl: version.clientVersion.gitVersion,
      pinnedContext: true, wrongAmbientIgnored: true, sourceChangeIgnored: true, namespaceRows: namespaces.rows.length,
      deploymentReady: true, servicePorts: true, podContainers: 2, scopedLogSnapshots: true,
      stalePodRejected: true, helmReleaseRevision: release.revision, otherNamespaceDenied: true,
      readerDeleteDenied: true, adminConfigUnchanged: true,
      scale: { dryRunPreserved: true, staleRejected: true, approvalRequired: true, changedAndRestored: [1, 0, 1],
        replayRejected: true, readerDenied: true, singleResourceAccount: true },
      helmRollback: { approvedRevision: 1, previousRevision: 2, recordedRevision: 3,
        serverDryRunPreserved: true, changedResourceRestored: true, approvalRequired: true,
        forgedRejected: true, replayRejected: true },
      execCredential: { kubectlAccepted: true, helmAccepted: true, authVersion: versionName, approvalRequired: true,
        noExecutionWhileReviewing: true, reviewedSnapshotStayedActive: true, otherNamespaceDenied: true } };
  } finally {
    try { await Promise.all([staged?.close(), scaler?.close(), helmFixture?.close(), execFixture?.close()]); }
    finally {
      if (oldAmbient === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = oldAmbient;
      for (const file of [selectedFile, ambientFile, scalerFile, providerConfig, provider, providerResponse, providerCalls]) {
        await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
}

if (require.main === module) verifyKindFixture().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { verifyKindFixture, authorizationDenied };
