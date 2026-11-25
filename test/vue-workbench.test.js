'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { inspectVueProject, selectNode, parseVueDiagnostics } = require('../src/web/vue-tools');

async function emptyFixture() {
  return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-vue-unit-'));
}

test('selection uses the nearest local Vue manifest and prefers the application tsconfig', async t => {
  const workspace = await emptyFixture();
  const project = path.join(workspace, 'project');
  await fs.mkdir(project);
  const paths = ['package.json', 'App.vue', 'tsconfig.json', 'tsconfig.app.json'].map(name => path.join(project, name));
  await Promise.all(paths.map((file, index) => fs.writeFile(file, index === 0 ? JSON.stringify({ dependencies: { vue: '^3.5' } }) : '{}')));
  t.after(async () => { for (const file of paths) await fs.unlink(file); await fs.rmdir(project); await fs.rmdir(workspace); });
  const result = await inspectVueProject(workspace, paths[1]);
  assert.equal(result.root, project);
  assert.equal(result.config, paths[3]);
  assert.deepEqual(result.installed, {});
  await assert.rejects(inspectVueProject(project, workspace), /inside its VS Code workspace/);
  await assert.rejects(inspectVueProject(workspace, workspace), /No local Vue project/);
});

test('matches the exact compiler coordinates and rejects external links and excess diagnostics', async t => {
  const root = await emptyFixture();
  const outside = await emptyFixture();
  const name = 'App (fixture).vue';
  const file = path.join(root, name);
  await fs.writeFile(file, '');
  const external = path.join(root, 'alias');
  const outFile = path.join(outside, name);
  await fs.writeFile(outFile, '');
  await fs.symlink(outside, external, 'junction');
  t.after(async () => {
    await fs.unlink(external);
    await fs.unlink(file);
    await fs.unlink(outFile);
    await fs.rmdir(root);
    await fs.rmdir(outside);
  });
  const usable = name + '(8,16): error TS2322: Wrong type.\n  Type string is incompatible.\n';
  const externalPath = path.join('alias', name);
  const report = await parseVueDiagnostics({ root }, { code: 2, output:
    usable + `${externalPath}(1,1): error TS9999: Alias.\nerror TS9998: Global.\n` });
  assert.deepEqual(report.diagnostics, [{ file, line: 7, column: 15, severity: 'error', code: 'TS2322',
    message: 'Wrong type.\nType string is incompatible.' }]);
  assert.equal(report.projectDiagnostics.length, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.clean, false);
  const bounded = await parseVueDiagnostics({ root }, { code: 2,
    output: 'unknown.vue(1,1): error TS1234: Missing.\n'.repeat(250) + usable });
  assert.equal(bounded.diagnostics.length, 0);
  assert.equal(bounded.skipped, 251);
  await assert.rejects(parseVueDiagnostics({ root }, { code: 1, output: 'unstructured Node failure' }), /without recognised diagnostics/);
});

test('requires a standalone local Node executable rather than a shell command', async () => {
  assert.equal(await selectNode(process.execPath), await fs.realpath(process.execPath));
  await assert.rejects(selectNode('node --require arbitrary'), /absolute path/);
});
