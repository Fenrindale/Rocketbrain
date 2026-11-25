'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTransferRuns, transferRunLimits } = require('../src/db/table-transfer-runs');

async function fixture(t) {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-transfer-runs-'));
  t.after(() => fs.rm(storagePath, { recursive: true, force: true }));
  let trusted = true;
  const create = () => createTransferRuns({ storagePath, isTrusted: () => trusted });
  return { create, directory: path.join(storagePath, 'table-copy-verification-runs'), revokeTrust: () => { trusted = false; } };
}

test('transfer runs keep redacted checkpoints for an interrupted host and a separate fresh attempt', async t => {
  const { directory, create, revokeTrust } = await fixture(t);
  const captureId = randomUUID();
  const first = create(), interrupted = await first.begin(captureId, 40);
  const initial = (await first.list())[0];
  assert.equal(initial.state, 'running');
  assert.equal(initial.checkedKeys, 0);
  await interrupted.checkpoint({ rows: 40, checkedKeys: 16, pages: 1, password: 'never persist', key: 'never persist' });
  const restarted = create();
  const [checkpoint] = await restarted.list(captureId);
  assert.equal(checkpoint.state, 'last-checkpoint');
  assert.equal(checkpoint.runId, initial.runId);
  assert.equal(checkpoint.checkedKeys, 16);
  assert.equal(checkpoint.pages, 1);
  assert.doesNotMatch(await fs.readFile(path.join(directory, (await fs.readdir(directory))[0]), 'utf8'), /password|never persist/);

  const attempt = await restarted.begin(captureId, 40);
  await attempt.checkpoint({ rows: 40, checkedKeys: 40, pages: 3 });
  await attempt.finish('complete');
  const visible = await restarted.list(captureId);
  assert.deepEqual(visible.map(value => value.state).sort(), ['complete', 'last-checkpoint']);
  assert.notEqual(visible[0].runId, visible[1].runId);
  await interrupted.finish('cancelled');
  assert.deepEqual((await restarted.list(captureId)).map(value => value.state).sort(), ['cancelled', 'complete']);
  assert.deepEqual(await restarted.list(randomUUID()), []);
  await assert.rejects(restarted.list('../other-workspace'), /Choose a saved table snapshot/);
  revokeTrust();
  await assert.rejects(restarted.list(), /trusted workspace/);
  await assert.rejects(restarted.begin(captureId, 40), /trusted workspace/);
});

test('transfer run retention limits workspace files and ignores oversized records', async t => {
  const { directory, create } = await fixture(t);
  const journal = create(), captureId = randomUUID();
  const first = await journal.begin(captureId, 1);
  await first.finish('inconclusive');
  const stamp = Date.now() - (transferRunLimits.days + 1) * 86400000;
  const expired = stamp + '-' + randomUUID() + '.json';
  await fs.writeFile(path.join(directory, expired), '{}');
  for (let index = 0; index < transferRunLimits.entries + 1; index++) {
    const run = await journal.begin(captureId, 1);
    await run.finish('cancelled');
  }
  const files = await fs.readdir(directory);
  assert.equal(files.length, transferRunLimits.entries);
  assert.ok(!files.includes(expired));
  await fs.writeFile(path.join(directory, files[0]), 'x'.repeat(transferRunLimits.bytes + 1));
  assert.equal((await journal.list()).length, transferRunLimits.entries - 1);
});
