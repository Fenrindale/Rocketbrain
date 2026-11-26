'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectSequence, sequenceDetailsText } = require('../src/db/sequence-details');

const object = { kind: 'sequence', schema: 'orders', name: 'batch`number' };
const context = version => ({ dialect: 'mariadb', mariaExtended: true, version });
const state = ['18446744073709551000', '1', '18446744073709551614', '5', '7', '0', '18446744073709551035', '1'];
const statement = 'CREATE SEQUENCE `batch``number` as bigint unsigned start with 18446744073709551000';

function observer({ current = state, observedType = ['bigint unsigned', 64, ...state.slice(0, 4), '1'], replaced = false } = {}) {
  const calls = [];
  let shows = 0;
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT TABLE_NAME')) return { rows: [[object.name]] };
      if (sql.startsWith('SHOW CREATE SEQUENCE')) {
        shows++;
        return { columns: ['Table', 'Create Table'], rows: [[object.name, statement + (replaced && shows === 2 ? ' nocache' : '')]] };
      }
      if (sql.includes('FROM information_schema.SEQUENCES')) return { rows: [observedType] };
      return { rows: current ? [current] : [] };
    }
  };
}

test('modern sequences report an exact typed snapshot and never issue a next-value expression', async () => {
  const { calls, query } = observer();
  const details = await inspectSequence(query, context('12.3.4-MariaDB'), object);
  assert.deepEqual(details.type, { name: 'BIGINT', unsigned: true, precision: 64 });
  assert.equal(details.maximum, '18446744073709551614');
  assert.equal(details.nextNotCached, '18446744073709551035');
  assert.equal(details.provenance, 'INFORMATION_SCHEMA.SEQUENCES and sequence state');
  const actual = calls.find(({ sql }) => sql.includes('next_not_cached_value'));
  assert.match(actual.sql, /FROM `orders`\.`batch``number` WHERE EXISTS/);
  assert.deepEqual(actual.values, ['orders', 'batch`number']);
  assert.ok(calls.every(({ sql }) => /^(SELECT|SHOW CREATE SEQUENCE) /i.test(sql) && !/NEXT (?:VALUE FOR|VAL)/i.test(sql)));
  assert.match(sequenceDetailsText(details), /Next non-cached boundary 18446744073709551035/);
});

test('legacy sequence inspection uses its signed BIGINT type without probing the absent modern catalog', async () => {
  const { calls, query } = observer({ current: ['-11', '-99', '-2', '-2', '0', '0', '-13', '0'] });
  const details = await inspectSequence(query, context('5.5.5-10.11.20-MariaDB'), object);
  assert.deepEqual(details.type, { name: 'BIGINT', unsigned: false, precision: 64 });
  assert.equal(details.increment, '-2');
  assert.equal(details.cycle, false);
  assert.equal(details.provenance, 'SHOW CREATE SEQUENCE and sequence state');
  assert.ok(!calls.some(({ sql }) => sql.includes('information_schema.SEQUENCES')));
});

test('inspection refuses changed definitions, conflicting metadata and lossy state', async () => {
  const v12 = context('12.3.4-MariaDB');
  for (const variation of [
    { replaced: true }, { observedType: ['bigint unsigned', 64, ...state.slice(0, 4), '0'] }, { current: null }
  ]) {
    await assert.rejects(inspectSequence(observer(variation).query, v12, object), { code: 'ROCKETBRAIN_SEQUENCE_CHANGED' });
  }
  for (const value of [18446744073709551000, '18446744073709551616', '2e2']) {
    const current = [...state]; current[6] = value;
    await assert.rejects(inspectSequence(observer({current}).query, v12, object), { code: 'ROCKETBRAIN_SEQUENCE_VALUES' });
  }
});

test('unsupported engines and non-sequences never issue metadata requests', async () => {
  const never = () => assert.fail('Unexpected metadata query');
  await assert.rejects(inspectSequence(never, { dialect: 'mysql', version: '8.4.13' }, object), { code: 'ROCKETBRAIN_SEQUENCE_ENGINE' });
  await assert.rejects(inspectSequence(never, context('12.3.4-MariaDB'), { ...object, kind: 'table' }), { code: 'ROCKETBRAIN_SEQUENCE_ENGINE' });
});
