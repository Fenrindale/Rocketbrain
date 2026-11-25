'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseStatus, supportedPath } = require('../src/vcs/changelist-git');
const { createChangelistState } = require('../src/vcs/changelist-state');

test('Git changelist status keeps exact paths, rename direction and staged plus untracked states', () => {
  const { changes, omitted } = parseStatus(Buffer.from('R  new dir/공유.txt\0old dir/공유.txt\0D  another/path\0?? another/path\0 M left/x.txt\0?? right/x.txt\0?? bad\nlabel\0'));
  assert.deepEqual(changes, [
    { path: 'new dir/공유.txt', statuses: ['R '], previousPath: 'old dir/공유.txt' },
    { path: 'another/path', statuses: ['D ', '??'] },
    { path: 'left/x.txt', statuses: [' M'] },
    { path: 'right/x.txt', statuses: ['??'] }
  ]);
  assert.equal(omitted, 1);
  assert.throws(() => parseStatus(Buffer.from('R  new\0')), /incomplete rename/);
  assert.throws(() => parseStatus(Buffer.from('?? not terminated')), /incomplete status/);
  assert.throws(() => parseStatus(Buffer.from([0x90])), /UTF-8/);
  assert.ok(['/abs', '../outside', 'nested/../outside', '.git/config', 'C:x'].every(name => !supportedPath(name)));
});

test('workspace changelists persist exclusive exact membership and editor context across instances', async () => {
  let saved, failed = false;
  const storage = {
    get: (key, fallback) => saved ? structuredClone(saved) : fallback,
    update: async (key, value) => { if (failed) { failed = false; throw Error('Storage unavailable'); } saved = structuredClone(value); }
  };
  const repo = 'a'.repeat(64), another = 'b'.repeat(64), state = createChangelistState(storage);
  const first = await state.create(repo, 'First'), second = await state.create(repo, 'Second');
  const observed = new Set(['left/same.txt', 'right/same.txt']);
  const guard = () => {};
  await Promise.all([state.assign(repo, first.id, ['left/same.txt', 'right/same.txt'], observed, guard),
    state.assign(repo, second.id, ['left/same.txt'], observed, guard)]);
  assert.deepEqual((await state.list(repo, first.id)).paths, ['right/same.txt']);
  assert.deepEqual((await state.list(repo, second.id)).paths, ['left/same.txt']);
  await assert.rejects(state.assign(repo, first.id, ['new/same.txt'], observed, guard), /still changed/);
  const context = { editors: [{ path: 'left/same.txt', selection: { anchor: { line: 1, character: 5 },
    active: { line: 1, character: 0 }, hash: '6'.repeat(64) } }], activePath: 'left/same.txt',
    launch: { name: 'Run fixture', type: 'rocketbrain-java', request: 'launch' } };
  failed = true;
  await assert.rejects(state.capture(repo, second.id, context), /Storage unavailable/);
  assert.equal((await state.list(repo, second.id)).context, null);
  await state.capture(repo, second.id, context);
  const reopened = createChangelistState(storage);
  assert.deepEqual((await reopened.list(repo, second.id)).context, context);
  assert.deepEqual(await reopened.lists(another), []);
  await reopened.unassign(repo, second.id, ['left/same.txt']);
  assert.deepEqual((await reopened.list(repo, second.id)).paths, []);
  assert.equal((await reopened.rename(repo, second.id, 'Third')).name, 'Third');
  await reopened.remove(repo, second.id);
  assert.deepEqual((await reopened.lists(repo)).map(list => list.name), ['First']);
});
