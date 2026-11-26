'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { createComposeEdit, inspectYaml } = require('../src/docker/compose-edit');
const { dockerEnvironment } = require('../src/docker/workbench');

const invoke = promisify(execFile);
const title = 'rocketbrain-compose-review';

async function fixture(context) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-test-compose-edit-'));
  context.after(async () => {
    const real = await fs.realpath(root);
    assert.equal(real, root);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-test-compose-edit-/u);
    await fs.rm(real, { recursive: true, force: true });
  });
  const files = ['compose.yaml', 'compose.staging.yaml', 'compose.final.yaml'].map(file => path.join(root, file));
  const source = [
    'services:\n  api:\n    image: example/api:base\n    environment:\n      ORDER_TEST: "${DELIBERATE_SOURCE_VALUE}"\n' +
      '    labels:\n      from-base: yes-value\n    ports: ["8090:8080"]\n  jobs:\n    image: example/jobs:base\n    profiles: [jobs]\n',
    '# Selected override with its comment.\nservices:\n  api:\n    image: example/api:staging\n    restart: always\n' +
      '    environment:\n      EDIT_TEST: one\n    ports: !override ["8190:8080"]\n',
    'services:\n  api:\n    restart: on-failure\n    labels:\n      from-later: final-value\n'
  ];
  for (const [index, file] of files.entries()) await fs.writeFile(file, source[index], { flag: 'wx' });
  await fs.writeFile(path.join(root, '.env'), 'DELIBERATE_SOURCE_VALUE=fixture-value-outside-reviewed-stack\n', { flag: 'wx' });
  const changed = source[1].replace(':staging', ':reviewed').replace('8190', '8290').replace('EDIT_TEST: one', 'EDIT_TEST: two');
  return { root, files, source, changed };
}

function assertArgs(args) {
  assert.deepEqual(args, ['compose', '--project-name', title, '--profile', '*', '--env-file', 'compose-empty.env',
    '-f', 'compose-0.yaml', '-f', 'compose-1.yaml', '-f', 'compose-2.yaml',
    'config', '--format', 'json', '--no-interpolate', '--no-env-resolution', '--no-path-resolution']);
}

test('Compose YAML gate admits merge tags and refuses indirection and complex keys', () => {
  inspectYaml('services:\n  api:\n    ports: !override ["8080:80"]\n');
  inspectYaml('services:\n  api:\n    ports: !reset []\n');
  for (const item of ['include: [private.yml]\n', 'services:\n  api:\n    extends: { file: ../outside.yaml }\n',
    'services:\n  api:\n    label_file: ../outside\n', 'services:\n  api:\n    env_file: ../../secret\n',
    'services:\n  api:\n    labels: &a {include: external.yml}\n']) {
    assert.throws(() => inspectYaml(item), /indirection/);
  }
  assert.throws(() => inspectYaml('services: !workflow {}\n'), /standard Compose/);
  assert.throws(() => inspectYaml('services:\n  api:\n    ? [other, key]\n    : data\n'), /literal text/);
});

test('Compose editor stages exact ordered inputs, rejects change conflicts and applies one selected source once', async context => {
  const { root, files, source, changed } = await fixture(context);
  const stages = [];
  const service = createComposeEdit({ workspaceRoots: () => [root], async run(args, { cwd }) {
    assertArgs(args);
    assert.notEqual(cwd, root);
    assert.deepEqual((await fs.readdir(cwd)).sort(), ['compose-0.yaml', 'compose-1.yaml', 'compose-2.yaml', 'compose-empty.env']);
    assert.equal(await fs.readFile(path.join(cwd, 'compose-empty.env'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(cwd, 'compose-0.yaml'), 'utf8'), source[0]);
    assert.equal(await fs.readFile(path.join(cwd, 'compose-2.yaml'), 'utf8'), source[2]);
    const input = await fs.readFile(path.join(cwd, 'compose-1.yaml'), 'utf8');
    assert.ok([source[1], changed].includes(input));
    stages.push(cwd);
    return JSON.stringify({ name: title, services: { api: {
      image: input === source[1] ? 'old-image' : 'new-image', environment: { sample: input === source[1] ? 'private-one' : 'private-two' }
    } } });
  } });
  context.after(() => service.dispose());
  await assert.rejects(service.prepare([files[0], files[0]], 1), /once/);
  await assert.rejects(service.prepare(files, 0), /one override/);
  const draft = await service.prepare(files, 1);
  assert.equal(draft.selected, files[1]);
  await assert.rejects(service.review(draft.id, source[1]), /Edit the selected/);
  const review = await service.review(draft.id, changed);
  assert.deepEqual(review.changes, [['services', 'api', 'environment'], ['services', 'api', 'image']]);
  assert.equal(review.after.services.api.environment, '[redacted]');
  assert.ok(!JSON.stringify(review).includes('private-two'));
  await assert.rejects(service.apply(review.token, { approved: false }), /Approve a current/);
  const editor = async ({ file, beforeText, text }) => {
    assert.equal(file, files[1]);
    assert.equal(beforeText, source[1]);
    assert.equal(text, changed);
    return true;
  };
  assert.deepEqual(await service.apply(review.token, { approved: true, edit: editor }), { state: 'applied-to-editor', selected: files[1] });
  await assert.rejects(service.apply(review.token, { approved: true, edit: editor }), /Approve a current/);
  assert.equal(await fs.readFile(files[1], 'utf8'), source[1], 'the product backend does not directly write its inputs');
  assert.equal(stages.length, 2);
  for (const stage of stages) await assert.rejects(fs.stat(stage), { code: 'ENOENT' });

  const again = await service.prepare(files, 1);
  const stale = await service.review(again.id, changed);
  await fs.appendFile(files[2], '# External edit\n');
  let invoked = false;
  await assert.rejects(service.apply(stale.token, { approved: true, edit() { invoked = true; } }), /source changed/);
  assert.equal(invoked, false);
  assert.match(await fs.readFile(files[2], 'utf8'), /External edit/u);
  await assert.rejects(service.apply(stale.token, { approved: true, edit: editor }), /Approve a current/);
});

test('actual Compose resolves an edited middle override without environment expansion or Docker changes', {
  skip: process.env.ROCKETBRAIN_DOCKER_COMPOSE_EDIT_TEST !== '1', timeout: 75000
}, async context => {
  assert.equal(process.platform, 'linux');
  const { root, files, source, changed } = await fixture(context);
  const docker = (args, options = {}) => invoke('docker', args, {
    cwd: options.cwd || root, env: { ...dockerEnvironment(), DELIBERATE_SOURCE_VALUE: 'host-process-fixture-value' },
    timeout: 20000, maxBuffer: 1024 * 1024
  });
  const beforeContainers = await docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + title]);
  const calls = [];
  const service = createComposeEdit({ workspaceRoots: () => [root], async run(args, options) {
    assertArgs(args);
    const result = await docker(args, options);
    calls.push({ staged: options.cwd, model: JSON.parse(result.stdout) });
    return result.stdout;
  } });
  context.after(() => service.dispose());
  const draft = await service.prepare(files, 1);
  const review = await service.review(draft.id, changed);
  const original = calls[0].model, proposed = calls[1].model;
  assert.equal(original.services.api.image, 'example/api:staging');
  assert.equal(proposed.services.api.image, 'example/api:reviewed');
  assert.equal(String(original.services.api.ports[0].published), '8190');
  assert.equal(String(proposed.services.api.ports[0].published), '8290');
  assert.equal(proposed.services.api.ports.length, 1);
  assert.equal(proposed.services.api.restart, 'on-failure');
  assert.deepEqual(proposed.services.api.labels, { 'from-base': 'yes-value', 'from-later': 'final-value' });
  assert.deepEqual(proposed.services.jobs.profiles, ['jobs']);
  assert.equal(proposed.services.api.environment.ORDER_TEST, '${DELIBERATE_SOURCE_VALUE}');
  assert.equal(proposed.services.api.environment.EDIT_TEST, 'two');
  assert.equal(review.after.services.api.environment, '[redacted]');
  assert.ok(review.changes.some(entry => entry.join('/') === 'services/api/environment'));
  await service.apply(review.token, { approved: true, async edit({ file, beforeText, text }) {
    assert.equal(file, files[1]);
    assert.equal(beforeText, source[1]);
    await fs.writeFile(file, text);
    return true;
  } });
  assert.equal(await fs.readFile(files[0], 'utf8'), source[0]);
  assert.equal(await fs.readFile(files[1], 'utf8'), changed);
  assert.equal(await fs.readFile(files[2], 'utf8'), source[2]);
  assert.ok((await fs.readFile(files[1], 'utf8')).startsWith('# Selected override'));
  const saved = await service.prepare(files, 1);
  const redundant = await service.review(saved.id, '# Recheck saved model\n' + changed);
  assert.deepEqual(calls[2].model, proposed);
  assert.equal(redundant.changes.length, 0);
  const afterContainers = await docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + title]);
  assert.equal(afterContainers.stdout, beforeContainers.stdout);
  for (const { staged } of calls) await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  const receipt = process.env.ROCKETBRAIN_DOCKER_COMPOSE_EDIT_RECEIPT;
  const details = { sourceCommit: process.env.GITHUB_SHA || null, compose: (await docker(['compose', 'version', '--short'])).stdout.trim(),
    orderedInputFiles: 3, reviewedSingleOverride: true, savedSourceFilesPreserved: true, sourceCommentPreserved: true,
    laterOverridesPreserved: true, appliedModelMatchesReview: true, modelMergeTagApplied: true, profileIncluded: true, environmentInterpolationDisabled: true,
    changedEnvironmentRedacted: true, resolvedImageChanged: true, exactPublishedPort: 8290, privateStagesRemoved: true, daemonObjectsUnchanged: true };
  if (receipt) await fs.writeFile(receipt, JSON.stringify(details, null, 2) + '\n', { flag: 'wx' });
  context.diagnostic(JSON.stringify(details));
});
