'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerJavaWorkbench } = require('../src/java/workbench');
const { parseSharedRun } = require('../src/java/shared-run');
const F = require('./java-workbench-fixture');

async function setup(t) {
  const fixture = F.fixture(t), transport = F.fakeVscode(fixture);
  const api = registerJavaWorkbench(transport.context, transport.vscode, transport.java, transport.output, { runner: transport.runner });
  t.after(() => api.dispose());
  await api.refresh();
  return { fixture, transport, api };
}

test('shared Java runs omit private values and rebind exact local values after a fresh review', async t => {
  const { fixture, transport, api } = await setup(t);
  const local = {
    projectUri: fixture.uri, name: 'Shareable Spring run', mainClass: 'demo.Main',
    args: ['private program value'], vmArgs: ['-Dsample.private=local-private-jvm'],
    env: { LOCAL_SECRET: 'value-private-env' },
    springBoot: { profiles: ['local-db'], profileSource: 'jvm',
      properties: [{ key: 'sample.setting', source: 'arguments', value: 'private spring value' }] }
  };
  const saved = await api.saveRunConfiguration(local);
  const file = path.join(fixture.root, 'local.rocketbrain-run.json');
  const source = { rootUri: pathToFileURL(fixture.root).href, fileUri: pathToFileURL(file).href };
  const exported = await api.exportSharedRun({ ...source, configurationId: saved.id });
  assert.equal(exported.privateValuesIncluded, false);
  const bytes = await fs.readFile(file);
  const shape = parseSharedRun(bytes);
  assert.equal(shape.project, '.');
  assert.equal(shape.arguments, 1);
  assert.equal(shape.jvmOptions, 1);
  assert.deepEqual(shape.environment, ['LOCAL_SECRET']);
  assert.deepEqual(shape.spring.properties, [{ key: 'sample.setting', source: 'arguments' }]);
  for (const value of [...local.args, ...local.vmArgs, ...Object.values(local.env), 'private spring value', fixture.javaHome]) {
    assert.equal(bytes.includes(value), false);
  }
  await assert.rejects(api.exportSharedRun({ ...source, configurationId: saved.id }), { code: 'EEXIST' });

  const stale = await api.reviewSharedRun(source);
  assert.equal(stale.sha256, exported.sha256);
  assert.equal(stale.executesProjectCode, false);
  const input = { args: ['new application input'], vmArgs: ['-Dsample.private=bound'],
    env: { LOCAL_SECRET: 'new local secret' }, springValues: ['새 속성'] };
  await fs.appendFile(file, '\n');
  await assert.rejects(api.applySharedRun({ reviewId: stale.reviewId, approved: true, bindings: input }), /changed.*review/i);
  await fs.writeFile(file, bytes);
  const review = await api.reviewSharedRun(source);
  await assert.rejects(api.applySharedRun({ reviewId: review.reviewId, bindings: input }), /approve/i);
  await assert.rejects(api.applySharedRun({ reviewId: review.reviewId, approved: true, bindings: { ...input, env: {} } }), /exact.*values/i);
  const imported = await api.applySharedRun({ reviewId: review.reviewId, approved: true, bindings: input });
  assert.notEqual(imported.id, saved.id);
  assert.deepEqual(imported.args, input.args);
  assert.deepEqual(imported.springBoot, saved.springBoot);
  assert.equal(transport.starts.length, 0);
  await assert.rejects(api.applySharedRun({ reviewId: review.reviewId, approved: true, bindings: input }), /expired/i);
  const run = await api.start({ configurationId: imported.id, debug: true });
  assert.equal(run.configurationId, imported.id);
  assert.deepEqual(transport.starts[0].configuration.env, input.env);
  await api.stop({ runId: run.runId });
});

test('shared Java runs reject escaping project paths, supplied values and launcher overrides', async t => {
  const { fixture, api } = await setup(t);
  const saved = await api.saveRunConfiguration({ projectUri: fixture.uri, name: 'Safe', mainClass: 'demo.Main', vmArgs: ['-Dtest=value'] });
  const file = path.join(fixture.root, 'settings.rocketbrain-run.json');
  const source = { rootUri: fixture.root, fileUri: file };
  await api.exportSharedRun({ ...source, configurationId: saved.id });
  const body = JSON.parse(await fs.readFile(file));
  for (const changed of [{ ...body, project: '../elsewhere' }, { ...body, project: 'C:/other' },
    { ...body, project: 'some\\path' }, { ...body, javaHome: 'private path' }, { ...body, environment: ['A','a'] }]) {
    assert.throws(() => parseSharedRun(Buffer.from(JSON.stringify(changed))), /shared Java run|workspace project/);
  }
  const review = await api.reviewSharedRun(source);
  await assert.rejects(api.applySharedRun({ reviewId: review.reviewId, approved: true, bindings: { vmArgs: ['-cpother'] } }),
    /owns classpaths/);
});

test('Java run groups start saved configurations in order and stop only their prior sessions on a failed start', async t => {
  const { fixture, transport, api } = await setup(t);
  const configurations = [];
  for (const name of ['First', 'Second']) {
    const saved = await api.saveRunConfiguration({ projectUri: fixture.uri, name, mainClass: 'demo.Main' });
    configurations.push({ configurationId: saved.id, debug: name === 'Second' });
  }
  await assert.rejects(api.startRunGroup({ configurations: [configurations[0], configurations[0]] }), /distinct/);
  const started = await api.startRunGroup({ configurations });
  assert.deepEqual(started.runs.map(({ configurationId, debug }) => ({ configurationId, debug })), configurations);
  assert.equal(api.getSnapshot().runs.length, 2);
  await assert.rejects(api.start({ configurationId: configurations[0].configurationId }), /current managed run/);
  await api.stop({ runId: started.runs[0].runId });
  assert.equal(api.getSnapshot().runs.length, 1);
  await api.stop();
  const start = transport.vscode.debug.startDebugging;
  transport.vscode.debug.startDebugging = (...args) => args[1].name === 'Second' ? false : start(...args);
  await assert.rejects(api.startRunGroup({ configurations }), /did not start/);
  assert.equal(api.getSnapshot().runs.length, 0);
});
