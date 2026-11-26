'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { jdbcReadback } = require('../java-source-analysis-host');
const { startSshProcessFixture } = require('./ssh-process-fixture');

async function stageBatchFixture(registerCleanup) {
  const { ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON: python, ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH: pythonPackage } = process.env;
  assert.ok(python && pythonPackage, 'Provide the owned Python and AsyncSSH fixtures.');
  const fixture = await startSshProcessFixture({ python, pythonPackage, batchFaults: true }, registerCleanup);
  const root = fixture.profile.root, container = path.dirname(root);
  const names = ['Alpha.java', 'Blocked.java', 'Last.java'];
  const remotes = names.map(name => path.join(root, 'batch', name));
  const locals = names.map(name => path.join(container, 'local', name));
  await fs.mkdir(path.dirname(remotes[0]));
  await fs.mkdir(path.dirname(locals[0]));
  const original = names.map((_, index) => 'final class Example { int value() { return ' + index + '; } }\n');
  const replacement = names.map((_, index) => 'final class Example { int value() { return ' + (42 + index) + '; } } // 새 값\n');
  await Promise.all(remotes.map((file, index) => fs.writeFile(file, original[index], { flag: 'wx' })));
  await Promise.all(locals.map((file, index) => fs.writeFile(file, replacement[index], { flag: 'wx' })));
  const snapshot = () => Promise.all(remotes.map(file => fs.readFile(file, 'utf8')));
  const stages = async () => (await fs.readdir(path.dirname(remotes[0]))).filter(file => file.startsWith('.rocketbrain-batch-'));
  return { ...fixture, remotes, locals, original, replacement, names, snapshot, stages };
}

async function exerciseBatch(service, fixture, attach, pairFor) {
  const preimage = await jdbcReadback();
  if (preimage) assert.equal(preimage.people, 2);
  const pairs = () => fixture.names.map((name, index) => pairFor('/batch/' + name, fixture.locals[index]));
  const allow = { allowReplacement: true };
  const localDrift = await service.reviewBatch(pairs());
  await assert.rejects(service.applyBatch(localDrift.id), /Approve.*explicitly/u);
  await fs.writeFile(fixture.locals[2], 'unapproved local contents\n');
  await assert.rejects(service.applyBatch(localDrift.id, allow), /changed after review/u);
  assert.deepEqual(await fixture.snapshot(), fixture.original);
  await fs.writeFile(fixture.locals[2], fixture.replacement[2]);

  const stale = await service.reviewBatch(pairs());
  await fs.writeFile(fixture.remotes[2], 'external remote contents\n');
  const refusal = await service.applyBatch(stale.id, allow);
  assert.equal(refusal.state, 'refused');
  assert.equal(refusal.reason, 'preimage-changed');
  assert.deepEqual(refusal.rows.map(row => row.state), ['not-written', 'not-written', 'not-written']);
  assert.deepEqual(await fixture.snapshot(), [...fixture.original.slice(0, 2), 'external remote contents\n']);
  assert.deepEqual(await fixture.stages(), []);
  await fs.writeFile(fixture.remotes[2], fixture.original[2]);

  const partialReview = await service.reviewBatch(pairs());
  await fixture.armBatchFault('reject-second');
  const partial = await service.applyBatch(partialReview.id, allow);
  assert.equal(partial.state, 'partial');
  assert.equal(partial.reason, 'replace-interrupted');
  assert.deepEqual(partial.rows.map(row => row.state), ['confirmed', 'unconfirmed', 'not-written']);
  assert.deepEqual(await fixture.snapshot(), [fixture.replacement[0], ...fixture.original.slice(1)]);
  assert.deepEqual(await fixture.stages(), []);
  await assert.rejects(service.applyBatch(partialReview.id, allow), /review/i);
  const partialReadback = await service.readbackBatch(partial.id);
  assert.deepEqual(partialReadback.rows.map(row => row.state), ['replacement-bytes', 'preimage', 'preimage']);

  const remaining = pairs().slice(1);
  const disconnectReview = await service.reviewBatch(remaining);
  await fixture.armBatchFault('drop-reply');
  const lost = await service.applyBatch(disconnectReview.id, allow);
  assert.equal(lost.state, 'unconfirmed');
  assert.equal(lost.reason, 'connection-interrupted');
  assert.deepEqual(lost.rows.map(row => row.state), ['unconfirmed', 'unconfirmed']);
  assert.deepEqual(await fixture.snapshot(), fixture.replacement);
  assert.deepEqual(await fixture.stages(), []);
  await attach({ ...fixture.profile, id: 'rb-other-workspace' });
  await assert.rejects(service.readbackBatch(lost.id), /same pinned SSH workspace/u);
  await attach(fixture.profile);
  const checked = await service.readbackBatch(lost.id);
  assert.deepEqual(checked.rows.map(row => row.state), ['replacement-bytes', 'replacement-bytes']);
  await fs.writeFile(fixture.remotes[2], 'new independent remote edit\n');
  const diverged = await service.readbackBatch(lost.id);
  assert.deepEqual(diverged.rows.map(row => row.state), ['replacement-bytes', 'different']);
  assert.equal((await fixture.snapshot())[2], 'new independent remote edit\n');

  // A clean reviewed batch confirms both writes. The sibling's unrelated change remains untouched.
  await Promise.all(fixture.locals.slice(0, 2).map((file, index) => fs.writeFile(file, fixture.original[index])));
  const cleanReview = await service.reviewBatch(pairs().slice(0, 2));
  const clean = await service.applyBatch(cleanReview.id, allow);
  assert.equal(clean.state, 'applied');
  assert.deepEqual(clean.rows.map(row => row.state), ['confirmed', 'confirmed']);
  assert.deepEqual(await fixture.snapshot(), [...fixture.original.slice(0, 2), 'new independent remote edit\n']);
  assert.deepEqual(await fixture.stages(), []);
  assert.deepEqual(await jdbcReadback(), preimage);
  return { matches: clean.rows.length, wholeBatchRefusal: true, partialConfirmed: true,
    channelLossUnconfirmed: true, reconnectReadback: true, unrelatedDriftKept: true,
    newProfileRejected: true, localDriftRejected: true, replayRejected: true, noStages: true,
    jdbcUnchanged: Boolean(preimage) };
}

module.exports = { stageBatchFixture, exerciseBatch };
