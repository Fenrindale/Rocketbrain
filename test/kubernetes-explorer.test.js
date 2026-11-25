'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { approvedContexts, prepareKubernetesConfig } = require('../src/infra/kubernetes');
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
