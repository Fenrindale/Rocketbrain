'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { createTransferHistory, historyLimits } = require('../src/db/table-transfer-history');
const { createTableTransfer } = require('../src/db/table-transfer');

async function fixture(t) {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-table-copy-history-'));
  const directory = path.join(storagePath, 'table-copy-verification-history');
  let trusted = true;
  const open = () => createTransferHistory({ storagePath, isTrusted: () => trusted });
  t.after(async () => {
    const names = await fs.readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (names) {
      for (const name of names) await fs.unlink(path.join(directory, name));
      await fs.rmdir(directory);
    }
    await fs.rmdir(storagePath);
  });
  return { directory, open, block: () => { trusted = false; } };
}

const observation = {
  status: 'mismatch', coverage: 'sampled-reviewed-keys', rows: 144, sampledKeys: 128, checkedKeys: 128,
  keyLimit: 128, matching: 126, missing: 1, mismatch: 1, comparedMappedColumns: 5, historicalCommitConfirmed: true,
  replayBlocked: false, destination: { database: 'private_db', table: 'private_table', host: 'private_host' },
  values: ['private_value'], samples: [{ key: ['private_key'], hash: 'private_hash' }], sql: 'private_stmt'
};

test('verification history reopens without a DB or saved snapshot and persists only redacted observation fields', async t => {
  const { directory, open, block } = await fixture(t);
  const captureId = randomUUID();
  const recorded = await open().append(captureId, observation);
  const [filename] = await fs.readdir(directory);
  assert.doesNotMatch(await fs.readFile(path.join(directory, filename), 'utf8'), /private_/);
  const core = createTableTransfer({}, { history: open() });
  const reopened = await core.listTransferVerificationHistory({ captureId });
  assert.deepEqual(reopened, [recorded]);
  assert.equal(reopened[0].historicalCommitConfirmed, false);
  assert.equal(reopened[0].replayBlocked, true);
  assert.equal(reopened[0].checkedKeys, 128);
  assert.deepEqual(await core.listTransferVerificationHistory({ captureId: randomUUID() }), []);
  await assert.rejects(core.listTransferVerificationHistory({ captureId: '../outside' }), /saved table snapshot/);
  block();
  await assert.rejects(core.listTransferVerificationHistory(), /trusted workspace/);
  await core.dispose();
});

test('verification history preserves concurrent records and bounds age and count', async t => {
  const { directory, open } = await fixture(t);
  const expiredCapture = randomUUID();
  const initial = await open().append(expiredCapture, observation);
  const [filename] = await fs.readdir(directory);
  const prior = Date.now() - historyLimits.ageMs - 1000;
  await fs.unlink(path.join(directory, filename));
  const expired = String(prior) + '-' + randomUUID() + '.json';
  await fs.writeFile(path.join(directory, expired), JSON.stringify({ ...initial, recordedAt: new Date(prior).toISOString() }));
  const captures = Array.from({ length: 8 }, () => randomUUID());
  await Promise.all(captures.map(captureId => open().append(captureId, observation)));
  assert.deepEqual((await open().list()).map(item => item.captureId).sort(), captures.sort());
  await assert.rejects(fs.stat(path.join(directory, expired)), { code: 'ENOENT' });
  for (let index = 0; index < historyLimits.entries; index++) await open().append(randomUUID(), observation);
  assert.equal((await open().list()).length, historyLimits.entries);
  assert.equal((await fs.readdir(directory)).length, historyLimits.entries);
});
