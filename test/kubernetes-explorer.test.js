'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { approvedContexts, prepareKubernetesConfig } = require('../src/infra/kubernetes');
const { createHelmReleaseActions } = require('../src/infra/kubernetes-helm');
const { authorizationDenied } = require('../scripts/test-kubernetes-kind');

const token = 'fixture-embedded-token';
const selected = { name: 'selected', context: { cluster: 'owned', user: 'reader', namespace: 'journal' } };
const cluster = { name: 'owned', cluster: { server: 'https://127.0.0.1:6443', 'certificate-authority-data': 'Y2E=' } };
const reader = { name: 'reader', user: { token } };
const config = { apiVersion: 'v1', kind: 'Config', 'current-context': 'ambient',
  clusters: [cluster], contexts: [selected], users: [reader] };
const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'app-1', namespace: 'journal', uid: 'fixture-uid' },
  spec: { containers: [{ name: 'main', env: [{ name: 'PRIVATE', value: 'not-for-product' }] }, { name: 'sidecar' }] },
  status: { phase: 'Running' } };

test('kind fixture distinguishes an actual kubectl access denial from a failed command', () => {
  const probe = ['--namespace=journal', 'auth', 'can-i', 'delete', 'pods'];
  assert.equal(authorizationDenied(probe, { code: 1, stdout: 'no\n' }), true);
  assert.equal(authorizationDenied(probe, { code: 1, stdout: 'no - no RBAC policy matched\n' }), true);
  for (const failure of [{ code: 1, stdout: '' }, { code: 1, stdout: 'no connection' }, { code: 2, stdout: 'no' }]) {
    assert.equal(authorizationDenied(probe, failure), false);
  }
  assert.equal(authorizationDenied(['--namespace=journal', 'get', 'pods'], { code: 1, stdout: 'no' }), false);
});

test('context projection allows only verified HTTPS with embedded token or certificate authentication', () => {
  const entries = approvedContexts(config);
  assert.equal(entries.size, 1);
  assert.equal(entries.get('selected').config['current-context'], 'selected');
  assert.equal(entries.get('selected').display.server, 'https://127.0.0.1:6443');
  assert.ok(!JSON.stringify(entries.get('selected').display).includes(token));
  const auth = { 'client-certificate-data': 'Y2E=', 'client-key-data': 'a2V5' };
  assert.equal(approvedContexts({ ...config, users: [{ ...reader, user: auth }] }).size, 1);
  for (const field of [{ exec: { command: 'unreviewed' } }, { 'auth-provider': {} }, { tokenFile: '/another/file' },
    { 'client-certificate': '/another/file' }]) {
    assert.equal(approvedContexts({ ...config, users: [{ ...reader, user: { ...reader.user, ...field } }] }).size, 0);
  }
  for (const field of [{ 'insecure-skip-tls-verify': true }, { 'proxy-url': 'http://127.0.0.1:15555' },
    { 'certificate-authority': '/another/file' }, { server: 'http://127.0.0.1:6443' },
    { server: 'https://name:password@127.0.0.1:6443' }, { server: 'https://127.0.0.1:6443/not-shown' }]) {
    assert.equal(approvedContexts({ ...config, clusters: [{ ...cluster, cluster: { ...cluster.cluster, ...field } }] }).size, 0);
  }
  assert.throws(() => approvedContexts({ ...config, contexts: [selected, selected] }), /duplicate/);
});

test('uses a private frozen context, bounded projections and current pod UID for each log snapshot', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-kube-unit-'));
  const file = path.join(root, 'test.kubeconfig');
  await fs.writeFile(file, JSON.stringify(config));
  t.after(async () => { await fs.unlink(file); await fs.rmdir(root); });
  const calls = [];
  let privateRoot, replaceAfterLogs = false, afterLogs = false;
  const prepared = await prepareKubernetesConfig({ file, kubectl: 'kubectl', helm: 'helm' }, async (tool, argv, options) => {
    const input = argv.find(item => item.startsWith('--kubeconfig=')).slice('--kubeconfig='.length);
    privateRoot = options.folder;
    assert.ok(!argv.join(' ').includes(token));
    assert.notEqual(input, file);
    const cfg = JSON.parse(await fs.readFile(input, 'utf8'));
    if (argv.includes('view')) return JSON.stringify(cfg);
    assert.equal(cfg['current-context'], 'selected');
    assert.equal(cfg.users.length, 1);
    calls.push({ tool, argv, limit: options.limit });
    if (tool === 'helm') {
      assert.ok(argv.includes('--kube-context=selected'));
      return JSON.stringify([{ name: 'chart', namespace: 'journal', status: 'deployed', revision: 1, chart: 'example-1.0.0' },
        { name: 'unexpected', namespace: 'other' }]);
    }
    assert.ok(argv.includes('--context=selected'));
    if (argv.includes('logs')) { afterLogs = true; return 'only-app-log\x1b[31m!\x1b[0m'; }
    if (argv.includes('namespaces')) return JSON.stringify({ items: [{ kind: 'Namespace', metadata: { name: 'journal' } }] });
    if (argv.includes('pod')) return JSON.stringify(replaceAfterLogs && afterLogs ? { ...pod, metadata: { ...pod.metadata, uid: 'replaced' } } : pod);
    return JSON.stringify({ items: [pod, { ...pod, metadata: { ...pod.metadata, namespace: 'other' } }] });
  });
  t.after(() => prepared.close());
  assert.deepEqual(prepared.choices().map(value => value.name), ['selected']);
  const session = await prepared.select('selected');
  await fs.writeFile(file, 'changed original');
  assert.equal((await session.namespaces()).rows[0].name, 'journal');
  const rows = await session.resources('pods', 'journal');
  assert.deepEqual(rows, { rows: [{ name: 'app-1', uid: 'fixture-uid', phase: 'Running', containers: ['main', 'sidecar'] }], omitted: 1 });
  assert.ok(!JSON.stringify(rows).includes('not-for-product'));
  assert.equal((await session.releases('journal')).rows[0].name, 'chart');
  await assert.rejects(session.resources('secrets', 'journal'), /supported resource kind/);
  await assert.rejects(session.resources('pods', '--all-namespaces'), /supported resource kind/);
  await assert.rejects(session.podLogs('journal', rows.rows[0], 'unlisted'), /pod or container changed/);
  const logs = await session.podLogs('journal', rows.rows[0], 'main');
  assert.equal(logs.text, 'only-app-log!');
  assert.equal(logs.maxLines, 200);
  const invocation = calls.find(call => call.argv.includes('logs'));
  assert.ok(invocation.argv.includes('--tail=200'));
  assert.ok(invocation.argv.includes('--limit-bytes=65536'));
  assert.equal(invocation.limit, 65536);
  afterLogs = false;
  replaceAfterLogs = true;
  await assert.rejects(session.podLogs('journal', rows.rows[0], 'main'), /pod or container changed/);
  await prepared.close();
  await assert.rejects(fs.stat(privateRoot), error => error.code === 'ENOENT');
});

test('previews Deployment scale on the server and uses the exact approved replica count and resource version once', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-kube-scale-'));
  const file = path.join(root, 'scale.kubeconfig');
  await fs.writeFile(file, JSON.stringify(config), { flag: 'wx' });
  t.after(async () => { await fs.unlink(file); await fs.rmdir(root); });
  let uid = 'uid-original', resourceVersion = 'version-1', replicas = 1, dryRuns = 0, writes = 0;
  const prepared = await prepareKubernetesConfig({ file, kubectl: 'kubectl' }, async (_tool, argv) => {
    if (argv.includes('view')) return JSON.stringify(config);
    assert.ok(argv.includes('--namespace=journal'));
    if (argv.includes('get')) return JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'app', namespace: 'journal', uid, resourceVersion }, spec: { replicas } });
    assert.ok(argv.includes('scale'));
    assert.ok(argv.includes('--resource-version=' + resourceVersion));
    assert.ok(argv.includes('--current-replicas=' + replicas));
    if (argv.includes('--dry-run=server')) dryRuns += 1;
    else { writes += 1; replicas = Number(argv.find(value => value.startsWith('--replicas=')).slice(11)); }
    return 'deployment.apps/app\n';
  });
  t.after(() => prepared.close());
  const session = await prepared.select('selected');
  await assert.rejects(session.reviewDeploymentScale('journal', '--all', 3), /listed Deployment/);
  await assert.rejects(session.reviewDeploymentScale('journal', 'app', -1), /replica count/);
  const stale = await session.reviewDeploymentScale('journal', 'app', 3);
  assert.equal(dryRuns, 1);
  assert.equal(writes, 0);
  await assert.rejects(session.applyDeploymentScale(stale), /Approve a current/);
  await assert.rejects(session.applyDeploymentScale({ ...stale }, { approved: true }), /Approve a current/);
  uid = 'uid-replacement';
  resourceVersion = 'version-2';
  await assert.rejects(session.applyDeploymentScale(stale, { approved: true }), /Deployment changed/);
  assert.equal(writes, 0);
  const next = await session.reviewDeploymentScale('journal', 'app', 3);
  assert.deepEqual(await session.applyDeploymentScale(next, { approved: true }),
    { namespace: 'journal', name: 'app', desired: 3, observed: 3 });
  await assert.rejects(session.applyDeploymentScale(next, { approved: true }), /Approve a current/);
  assert.equal(writes, 1);
  assert.equal(dryRuns, 2);
});

test('Helm rollback compares exact manifests, refuses changed reviews, and verifies the recorded revision', async () => {
  let current = 2, writes = 0, dryRuns = 0;
  const document = (marker, kind = 'ConfigMap', namespace = 'journal') =>
    JSON.stringify({ apiVersion: 'v1', kind, metadata: { name: 'fixture', namespace }, data: { marker } });
  const revisions = new Map([[1, document('owned-first')], [2, document('owned-second')]]);
  const operations = createHelmReleaseActions(async (namespace, args) => {
    assert.equal(namespace, 'journal');
    if (args[0] === 'history') return JSON.stringify([...revisions.keys()].map(revision =>
      ({ revision, status: revision === current ? 'deployed' : 'superseded', description: 'excluded-value', chart: 'sample-1.0.0' })));
    if (args[0] === 'get') return revisions.get(Number(args[3].slice('--revision='.length)));
    assert.deepEqual(args.slice(0, 5), ['rollback', 'release', '1', '--no-hooks', '--timeout=8s']);
    if (args.includes('--dry-run=server')) dryRuns += 1;
    else { writes += 1; revisions.set(++current, revisions.get(1)); }
    return 'fixture response';
  });
  await assert.rejects(operations.history('journal', '--all'), /listed Helm release/);
  assert.deepEqual((await operations.history('journal', 'release')).map(row => row.revision), [2, 1]);
  revisions.set(1, document('owned-first', 'ConfigMap', 'another-namespace'));
  await assert.rejects(operations.review('journal', 'release', 1), /selected namespace/);
  revisions.set(1, document('owned-first', 'Secret'));
  await assert.rejects(operations.review('journal', 'release', 1), /supported resources/);
  revisions.set(1, document('owned-first'));
  const stale = await operations.review('journal', 'release', 1);
  assert.equal(dryRuns, 1);
  assert.equal(writes, 0);
  assert.deepEqual(stale.resources, [{ kind: 'ConfigMap', name: 'fixture', changed: true }]);
  assert.doesNotMatch(JSON.stringify(stale), /owned-first|owned-second|excluded-value/);
  revisions.set(2, document('changed-current'));
  await assert.rejects(operations.apply(stale, { approved: true }), /Helm release changed/);
  assert.equal(writes, 0);
  const valid = await operations.review('journal', 'release', 1);
  await assert.rejects(operations.apply({ ...valid }, { approved: true }), /Approve a current/);
  await assert.rejects(operations.apply(valid), /Approve a current/);
  assert.deepEqual(await operations.apply(valid, { approved: true }),
    { namespace: 'journal', release: 'release', previousRevision: 2, restoredFrom: 1, recordedRevision: 3 });
  await assert.rejects(operations.apply(valid, { approved: true }), /Approve a current/);
  assert.equal(writes, 1);
});

test('redirects only the approved non-interactive credential executable to an owned byte-for-byte snapshot', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-kube-exec-'));
  const command = path.join(root, process.platform === 'win32' ? 'helper.exe' : 'helper');
  const file = path.join(root, 'provider.kubeconfig');
  const bytes = Buffer.from('mock executable bytes');
  await fs.writeFile(command, bytes, { flag: 'wx', mode: 0o700 });
  const exec = { apiVersion: 'client.authentication.k8s.io/v1', command, args: ['credential scope'], interactiveMode: 'Never' };
  const withExec = object => ({ ...config, users: [{ ...reader, user: { exec: object } }] });
  for (const change of [{ command: 'helper' }, { interactiveMode: 'IfAvailable' }, { env: [{ name: 'X', value: 'value' }] },
    { provideClusterInfo: true }, { apiVersion: 'client.authentication.k8s.io/v1beta1' }]) {
    assert.equal(approvedContexts(withExec({ ...exec, ...change })).size, 0);
  }
  await fs.writeFile(file, JSON.stringify(withExec({ ...exec, env: null, installHint: 'Tool metadata' })), { flag: 'wx' });
  t.after(async () => { await fs.unlink(file); await fs.unlink(command); await fs.rmdir(root); });
  let snapshot, calls = 0;
  const tool = async (_binary, argv, options) => {
    const pathArg = argv.find(arg => arg.startsWith('--kubeconfig='));
    const cfg = JSON.parse(await fs.readFile(pathArg.slice('--kubeconfig='.length), 'utf8'));
    if (argv.includes('view')) return JSON.stringify(cfg);
    calls++;
    const user = cfg.users[0].user;
    assert.deepEqual(Object.keys(user), ['exec']);
    snapshot = user.exec.command;
    assert.equal(path.relative(options.folder, path.dirname(path.dirname(snapshot))), '');
    assert.notEqual(snapshot, command);
    assert.deepEqual(await fs.readFile(snapshot), bytes);
    assert.deepEqual(user.exec.args, exec.args);
    return '{"items":[]}';
  };
  const stale = await prepareKubernetesConfig({ file, kubectl: 'kubectl' }, tool);
  t.after(() => stale.close());
  const oldReview = await stale.reviewCredential('selected');
  await fs.writeFile(command, 'updated');
  await assert.rejects(stale.select('selected', { credentialReview: oldReview, approvedExecutable: true }), /executable changed/);
  assert.equal(calls, 0);
  await fs.writeFile(command, bytes);
  const prepared = await prepareKubernetesConfig({ file, kubectl: 'kubectl' }, tool);
  t.after(() => prepared.close());
  const review = await prepared.reviewCredential('selected');
  await assert.rejects(prepared.select('selected', { credentialReview: review }), /Approve the reviewed credential/);
  const session = await prepared.select('selected', { credentialReview: review, approvedExecutable: true });
  assert.equal(calls, 0);
  assert.equal(session.scope.credential, 'reviewed-executable');
  assert.ok(!JSON.stringify(session.scope).includes('credential scope'));
  await fs.writeFile(command, 'updated after staging');
  await session.resources('deployments', 'journal');
  assert.equal(calls, 1);
  await session.close();
  await assert.rejects(fs.stat(snapshot), { code: 'ENOENT' });
});
