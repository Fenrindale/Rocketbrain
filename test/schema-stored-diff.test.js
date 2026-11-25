'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, addColumn } = require('./helpers/schema-diff-fixture');
const { normalizeSnapshot, compareSnapshots, planMigration } = require('../src/db/schema-diff');

const coverage = { procedure: 'loaded', function: 'loaded', trigger: 'loaded', event: 'loaded' };
const settings = { sql_mode: 'STRICT_TRANS_TABLES', character_set_client: 'utf8mb4',
  collation_connection: 'utf8mb4_bin', 'database collation': 'utf8mb4_bin' };
const proc = (name, definition) => ({ kind: 'procedure', name, state: 'observed', definition, settings });
const wrap = (snapshot, objects, availability = coverage) => normalizeSnapshot({ ...snapshot,
  storedObjects: { formatVersion: 1, scope: 'account-visible', coverage: availability, objects }
}, { verifyFingerprint: false });

test('only exact observable source and context count as same, and old snapshots retain their structural fingerprint', () => {
  const base = fixture(), prior = proc('visible', 'CREATE PROCEDURE visible() SELECT 1');
  const before = wrap(base, [prior, proc('only', 'CREATE PROCEDURE only() SELECT 9')]);
  const after = wrap(base, [{ ...prior, settings: { ...settings, sql_mode: 'NO_BACKSLASH_ESCAPES' } },
    { kind: 'procedure', name: 'withheld', state: 'withheld' }]);
  assert.equal(before.fingerprint, base.fingerprint);
  assert.equal(compareSnapshots(before, base).storedObjects.state, 'not-compared');
  assert.equal(compareSnapshots(before, before).storedObjects.matchedExact, 2);
  const report = compareSnapshots(before, after);
  assert.equal(report.summary.changes, 0);
  assert.deepEqual(report.storedObjects.differences.map(({ name, state, aspects }) => [name, state, aspects]), [
    ['only', 'seen-current-only', []], ['visible', 'changed-source-or-context', ['settings']], ['withheld', 'seen-desired-only', []]
  ]);
  const both = compareSnapshots(wrap(base, [prior]), wrap(base, [{ ...prior, state: 'withheld' }]));
  assert.equal(both.storedObjects.differences[0].state, 'definition-unavailable');
  assert.equal(both.storedObjects.differences[0].after.definition, undefined);
});

test('unobserved inventory, cross-dialect text and tampered captures remain explicit', () => {
  const left = fixture(), right = fixture({ dialect: 'mariadb' });
  const raw = proc('visible', 'CREATE PROCEDURE visible() SELECT 1');
  const archived = wrap(left, [raw]);
  const limited = wrap(right, [], { ...coverage, procedure: 'over-bound' });
  assert.equal(compareSnapshots(archived, limited).storedObjects.differences[0].state, 'inventory-unavailable');
  assert.equal(compareSnapshots(archived, wrap(right, [raw])).storedObjects.differences[0].state, 'same-text-cross-dialect');
  const wrong = structuredClone(archived);
  wrong.storedObjects.objects[0].definition += ' ';
  assert.throws(() => normalizeSnapshot(wrong), /stored-object snapshot content or server/);
  const wrongScope = structuredClone(archived);
  wrongScope.scope = { kind: 'selected-tables', tables: ['people'] };
  assert.throws(() => normalizeSnapshot(wrongScope, { verifyFingerprint: false }), /full visible database scope/);
});

test('stored differences can never be selected for migration while a supported structural addition still works', () => {
  const baseline = fixture(), expanded = addColumn(fixture());
  const first = wrap(baseline, [proc('p', 'CREATE PROCEDURE p() SELECT 1')]);
  const second = wrap(expanded, [proc('p', 'CREATE PROCEDURE p() SELECT 2')]);
  const report = compareSnapshots(first, second);
  const stored = report.storedObjects.differences[0];
  assert.equal(stored.selectable, false);
  assert.throws(() => planMigration(first, second, { changeIds: [stored.id] }), /missing or not supported/);
  const valid = report.changes.find(change => change.kind === 'add-column');
  assert.equal(planMigration(first, second, { changeIds: [valid.id] }).steps.length, 1);
});
