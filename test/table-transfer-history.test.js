'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { createTransferHistory, historyLimits, publishNewJson } = require('../src/db/table-transfer-history');
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

test('operator reviews are bound to the observed revision and accept one concurrent decision', async t => {
  const { directory, open, block } = await fixture(t);
  const captureId = randomUUID();
  const history = open();
  const database = { withTableTransfer() { assert.fail('Operator review contacted the database'); } };
  const api = createTableTransfer(database, { history });
  const competing = createTableTransfer(database, { history: open() });
  await history.append(captureId, observation);
  const stale = await api.prepareTransferVerificationReview({ captureId });
  await history.append(captureId, { ...observation, matching: 128, missing: 0, mismatch: 0, status: 'matching' });
  await assert.rejects(api.recordTransferVerificationReview({ reviewId: stale.reviewId, decision: 'acknowledged' }), /evidence or its review changed/);
  await assert.rejects(api.recordTransferVerificationReview({ reviewId: stale.reviewId, decision: 'acknowledged' }), /expired/);

  const first = await api.prepareTransferVerificationReview({ captureId });
  const second = await competing.prepareTransferVerificationReview({ captureId });
  assert.equal(first.observation.observationId, second.observation.observationId);
  first.observation.captureId = randomUUID();
  first.observation.checkedKeys = 0;
  const results = await Promise.allSettled([
    api.recordTransferVerificationReview({ reviewId: first.reviewId, decision: 'follow-up-required' }),
    competing.recordTransferVerificationReview({ reviewId: second.reviewId, decision: 'external-resolution-recorded' })
  ]);
  const winners = results.filter(item => item.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.match(results.find(item => item.status === 'rejected').reason.message, /evidence or its review changed/);
  const reviewed = winners[0].value;
  assert.equal(reviewed.captureId, captureId);
  assert.equal(reviewed.checkedKeys, 128);
  assert.equal(reviewed.review.historicalCommitConfirmed, false);
  assert.equal(reviewed.review.replayBlocked, true);
  await assert.rejects(api.prepareTransferVerificationReview({ captureId }), /already has a review/);
  const reopened = createTableTransfer(database, { history: open() });
  const evidence = await reopened.listTransferVerificationEvidence({ captureId });
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence[0], reviewed);
  assert.equal(evidence[1].review, undefined);
  assert.ok((await reopened.listTransferVerificationHistory({ captureId })).every(item => !Object.hasOwn(item, 'review')));
  const files = await fs.readdir(directory);
  assert.equal(files.filter(file => file.startsWith('review-')).length, 1);
  assert.ok(!files.some(file => file.endsWith('.tmp')));

  const other = randomUUID();
  await history.append(other, observation);
  const invalid = await api.prepareTransferVerificationReview({ captureId: other });
  await assert.rejects(api.recordTransferVerificationReview({ reviewId: invalid.reviewId, decision: 'commit' }), /review decision/);
  const waiting = await api.prepareTransferVerificationReview({ captureId: other });
  block();
  await assert.rejects(api.recordTransferVerificationReview({ reviewId: waiting.reviewId, decision: 'acknowledged' }), /trusted workspace/);
  await assert.rejects(reopened.listTransferVerificationEvidence(), /trusted workspace/);
  await Promise.all([api.dispose(), competing.dispose(), reopened.dispose()]);
});

test('expired observations prune associated operator decisions and queued reviews', async t => {
  const { directory, open } = await fixture(t);
  const history = open(), captureId = randomUUID();
  await history.append(captureId, observation);
  const { revision } = await history.currentReview(captureId);
  await history.recordReview(captureId, revision, 'acknowledged');
  const [file] = (await fs.readdir(directory)).filter(name => !name.startsWith('review-'));
  const time = Date.now() - historyLimits.ageMs - 1000;
  const expired = time + file.slice(13);
  await fs.rename(path.join(directory, file), path.join(directory, expired));
  await fs.rename(path.join(directory, 'review-' + file), path.join(directory, 'review-' + expired));
  assert.deepEqual(await history.evidence(captureId), []);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(history.recordReview(captureId, revision, 'acknowledged'), /evidence or its review changed/);
});

test('verification JSON publishing preserves an existing file and drops a rejected staging file', async t => {
  const { directory, open } = await fixture(t);
  const captureId = randomUUID();
  const storage = open();
  await storage.append(captureId, observation);
  const target = path.join(directory, 'verification-export.json');
  await publishNewJson(target, { observations: await storage.evidence() }, () => {});
  const before = await fs.readFile(target, 'utf8');
  assert.doesNotMatch(before, /private_|"observationHash"/);
  await assert.rejects(publishNewJson(target, { fake: true }, () => {}), { code: 'EEXIST' });
  await assert.rejects(publishNewJson(path.join(directory, 'rejected.json'), { fake: true }, () => { throw Error('Review changed.'); }), /changed/);
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.ok(!(await fs.readdir(directory)).some(file => file.endsWith('.tmp') || file === 'rejected.json'));
});
