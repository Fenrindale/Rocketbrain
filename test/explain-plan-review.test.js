'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizePlan, comparePlans } = require('../src/db/explain-plan');
const { captureBinding, reviewKeyStore, serializePlanReview, readPlanReview, readSharedPlanReview,
  planReviewCandidates, applyPlanReview } = require('../src/db/explain-plan-review');

function measured(scans) {
  return normalizePlan({
    raw:'-> Append\n' + scans.map(name => '    -> Table scan on ' + name +
      ' (cost=2 rows=8) (actual time=0.001..0.017 rows=5 loops=1)\n').join(''),
    engine:'mysql', version:'fixture-version', database:'fixture-database', format:'tree', measured:true
  });
}

function fixture() {
  const baseline = { capturedAt:'2026-11-25T00:00:00.000Z', report:measured(['private_table','private_table','q','r']) };
  const candidate = { capturedAt:'2026-11-25T00:00:01.000Z', report:measured(['q','r','private_table','private_table']) };
  const compare = decisions => comparePlans(baseline.report, candidate.report, decisions);
  const pairs = compare().candidateReview.pairs;
  const binding = captureBinding('plan', baseline, candidate);
  const decisions = new Map([[pairs[1].id, 'ignored'], [pairs[0].id, 'accepted']]);
  return { baseline, candidate, compare, pairs, binding, decisions };
}

function secretStore() {
  const values = new Map();
  return { get:key => values.get(key), store:(key, value) => { values.set(key, value); } };
}

async function reviewFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-plan-review-'));
  const file = path.join(dir, 'review.json');
  t.after(async () => {
    await fs.unlink(file);
    await fs.rmdir(dir);
  });
  return file;
}

test('saved SQL plan reviews bind authenticated choices to the original ordered captures', async t => {
  const file = await reviewFile(t), secrets = secretStore(), signer = reviewKeyStore(secrets);
  const { baseline, candidate, compare, pairs, binding, decisions } = fixture();
  const text = await serializePlanReview(binding, pairs, decisions, signer);
  assert.doesNotMatch(text, /fixture-version|fixture-database|private_table|2026-11-25|SELECT/);
  assert.doesNotMatch(text, new RegExp((await signer.createOrGet()).key));
  await fs.writeFile(file, text);
  const payload = await readPlanReview(file, reviewKeyStore(secrets));
  const current = new Map([[pairs[1].id, 'ignored']]);
  const applied = applyPlanReview(payload, binding, pairs, current, compare);
  assert.deepEqual(applied.decisions, decisions);
  assert.deepEqual(applied.report, compare(decisions));
  assert.deepEqual([...current], [[pairs[1].id, 'ignored']]);
  assert.throws(() => applyPlanReview(payload, captureBinding('plan', candidate, baseline), pairs, current, compare), /original SQL plan captures/);
  const stale = { ...baseline, capturedAt:'2026-11-25T00:00:02.000Z' };
  assert.throws(() => applyPlanReview(payload, captureBinding('plan', stale, candidate), pairs, current, compare), /original SQL plan captures/);
  const series = { ...baseline, plans:[baseline.report, candidate.report] };
  assert.notDeepEqual(captureBinding('series', series, series), captureBinding('series', { ...series, plans:[...series.plans].reverse() }, series));
});

test('altered, foreign, conflicting and oversized review files fail without changing decisions', async t => {
  const file = await reviewFile(t), secrets = secretStore(), signer = reviewKeyStore(secrets);
  const { compare, pairs, binding, decisions } = fixture();
  const text = await serializePlanReview(binding, pairs, decisions, signer);
  await fs.writeFile(file, text);
  await assert.rejects(readPlanReview(file, reviewKeyStore(secretStore())), /same VS Code secret store/);
  const payload = await readPlanReview(file, signer);
  const conflict = new Map([[pairs[2].id, 'accepted']]);
  assert.throws(() => applyPlanReview(payload, binding, pairs, conflict, compare), /conflicts with another decision/);
  assert.deepEqual([...conflict], [[pairs[2].id, 'accepted']]);
  assert.throws(() => applyPlanReview(payload, binding, pairs, new Map([[pairs[0].id, 'ignored']]), compare), /existing decision/);
  const changed = pairs.map(pair => ({ ...pair, matching:'changed' }));
  assert.throws(() => applyPlanReview(payload, binding, changed, new Map(), compare), /candidates have changed/);
  await fs.writeFile(file, text.replace('"accepted"', '"ignored"'));
  await assert.rejects(readPlanReview(file, signer), /signature is invalid/);
  await fs.writeFile(file, text.replace('"version": 1', '"version": 2'));
  await assert.rejects(readPlanReview(file, signer), /invalid version/);
  await fs.writeFile(file, Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(readPlanReview(file, signer), /16 KiB/);
});

test('simultaneous first saves keep reviews readable through the same secret store', async t => {
  const file = await reviewFile(t), secrets = secretStore();
  const { pairs, binding, decisions } = fixture();
  const archives = await Promise.all([reviewKeyStore(secrets), reviewKeyStore(secrets)].map(signer =>
    serializePlanReview(binding, pairs, decisions, signer)));
  const restored = reviewKeyStore(secrets);
  for (const archive of archives) {
    await fs.writeFile(file, archive);
    assert.deepEqual(await readPlanReview(file, restored), JSON.parse(archive));
  }
});

test('shared plan reviews require reapproval and match the complete ordered capture and candidate evidence', async t => {
  const file = await reviewFile(t), signer = reviewKeyStore(secretStore()), receiver = reviewKeyStore(secretStore());
  const { compare, pairs, binding, decisions } = fixture();
  const archive = await serializePlanReview(binding, pairs, decisions, signer);
  await fs.writeFile(file, archive);
  await assert.rejects(readSharedPlanReview(file, signer), /verified by your VS Code secret store/);
  const payload = await readSharedPlanReview(file, receiver);
  assert.deepEqual(planReviewCandidates(payload, binding, pairs), [
    { pair:pairs[0], suggested:'accepted' }, { pair:pairs[1], suggested:'ignored' }
  ]);
  assert.throws(() => planReviewCandidates(payload, { ...binding, captures:[...binding.captures].reverse() }, pairs),
    /original SQL plan captures/);
  const [included, skipped] = payload.decisions;
  skipped[1] = '0'.repeat(64);
  assert.throws(() => planReviewCandidates(payload, binding, pairs), /original SQL plan candidates/);
  await fs.writeFile(file, JSON.stringify(payload));
  await assert.rejects(readSharedPlanReview(file, signer), /signature is invalid/);
  const existing = new Map([[pairs[2].id, 'accepted']]);
  assert.throws(() => applyPlanReview({ ...payload, decisions:[included] }, binding, pairs, existing, compare), /conflicts/);
  assert.deepEqual([...existing], [[pairs[2].id, 'accepted']]);
});
