'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { createCommitEvidence, verifyCommitEvidence } = require('../src/db/table-transfer-verification');
const { tableIdentity, transferable } = require('../src/db/table-transfer');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = { dialect: 'mysql', version: '8.4.0', hostname: 'fixture', port: '3306', serverId: '1', serverUniqueId: 'uuid',
  tableNameCaseSensitive: true, sqlMode: 'STRICT_TRANS_TABLES', currentUser: 'fixture@localhost', database: 'reviewed',
  endpoint: { host: '127.0.0.1', port: 43306 } };
const place = { engine: 'mysql', database: 'reviewed', table: 'Ledger', identityHash: digest(identity), scope: tableIdentity(identity, 'Ledger') };
const columns = [
  { name: 'id', type: 'BIGINT UNSIGNED', kind: 'integer', nullable: false, primaryKey: true },
  { name: 'unit', type: 'VARCHAR(254)', kind: 'text', charset: 'utf8mb4', nullable: false, primaryKey: true },
  { name: 'memo', type: 'VARBINARY(16)', kind: 'binary', nullable: true },
  { name: 'serial', type: 'BIT(64)', kind: 'binary', nullable: true }
];
const definition = { kind: 'BASE TABLE', engine: 'InnoDB', columns };
const target = { ...place, definitionHash: digest(definition) };
const data = Array.from({ length: 48 }, (_, index) => [(9007199254740993n + BigInt(index)).toString(), '키' + index,
  index % 2 ? '0x' : null, index % 3 ? '0xffffffffffffffff' : '0x00']);

function sampled(rows = data, selected = columns) {
  const sampler = createCommitEvidence({ destination: target, capture: { rowCount: rows.length, sourceHash: 'captured' }, definition,
    selected: selected.map(column => ({ column, index: columns.indexOf(column), into: transferable(column) })) });
  rows.forEach((row, index) => sampler.observe(row, index));
  return sampler.evidence();
}

function transport({ dataRows = data, connectedIdentity = identity, afterLockDefinition = definition, overflowKey, onSample } = {}) {
  const events = [];
  const byKey = new Map(dataRows.map(row => [JSON.stringify(row.slice(0, 2)), row]));
  let definitions = 0;
  const service = {
    _options: { database: connectedIdentity.database, ...connectedIdentity.endpoint },
    _assertOpen() {},
    async _ensureConnection(session) { assert.equal(session.readOnly, true); session.connected = true; },
    async _control(session, sql) {
      events.push(sql);
      if (sql === 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY') session.inTransaction = true;
      if (sql === 'ROLLBACK') session.inTransaction = false;
      assert.ok(!/^(?:COMMIT|UPDATE|INSERT|DELETE)\b/i.test(sql));
    },
    async _refreshState() {},
    _lose(session) { events.push('close'); session.connected = false; },
    async _stream(session, sql, params, bounds, mayWrite) {
      assert.equal(mayWrite, false);
      if (sql.startsWith('SELECT VERSION()')) {
        const { version, hostname, port, serverId, tableNameCaseSensitive, sqlMode, currentUser, database } = connectedIdentity;
        return { rows: [[version, hostname, port, serverId, tableNameCaseSensitive ? 0 : 1, sqlMode, currentUser, database]] };
      }
      if (sql === 'SELECT @@server_uuid') return { rows: [[connectedIdentity.serverUniqueId]] };
      assert.equal(session.inTransaction, true);
      if (sql.endsWith('LIMIT 0')) return { rows: [[0]] };
      assert.match(sql, /WHERE rb_destination\.`id` = \? AND rb_destination\.`unit` = \? LIMIT 2$/);
      assert.equal(bounds.maxRows, 2);
      assert.equal(bounds.timeoutMs, 5000);
      events.push('lookup');
      const row = byKey.get(JSON.stringify(params));
      onSample?.();
      return { rows: row ? [[...row, row[0] === overflowKey ? 1 : 0]] : [], columns: [...columns.map(column => column.name), '__rb_source_overflow'] };
    },
    _editor: { async definition() { return ++definitions === 1 ? definition : afterLockDefinition; } }
  };
  return { events, verify: (evidence, cancellation) => verifyCommitEvidence(evidence, { cancellation, transferable, tableIdentity,
    targetDefinition: value => value, withTableTransfer: action => action({ db: service, guard: () => true }) }) };
}

test('deterministic bounded sampling includes both ends and key values remain private', async () => {
  const evidence = sampled();
  assert.equal(evidence.samples.length, 32);
  assert.deepEqual(evidence.samples[0].key, data[0].slice(0, 2));
  assert.deepEqual(evidence.samples.at(-1).key, data.at(-1).slice(0, 2));
  const { events, verify } = transport();
  const report = await verify(evidence);
  assert.deepEqual([report.status, report.matching, report.missing, report.mismatch], ['matching', 32, 0, 0]);
  assert.equal(report.historicalCommitConfirmed, false);
  assert.equal(report.replayBlocked, true);
  assert.equal(report.coverage, 'sampled-reviewed-keys');
  assert.ok(!JSON.stringify(report).includes(data[0][0]));
  assert.equal(events.filter(action => action === 'lookup').length, 32);
  assert.ok(events.includes('ROLLBACK'));
});

test('changed typed values and absent primary keys are reported separately without replay eligibility', async () => {
  const updated = [...data];
  updated[0] = [...updated[0]];
  updated[0][2] = '0x';
  updated.pop();
  const report = await transport({ dataRows: updated }).verify(sampled());
  assert.deepEqual([report.status, report.matching, report.missing, report.mismatch], ['mismatch', 30, 1, 1]);
  const absent = await transport({ dataRows: [] }).verify(sampled());
  assert.deepEqual([absent.status, absent.matching, absent.missing, absent.mismatch], ['missing', 0, 32, 0]);
  assert.equal(absent.replayBlocked, true);
});

test('legacy records, incomplete keys, drift, overwide observations and cancellation report safely', async () => {
  const noDatabase = () => { throw new Error('before acquiring a lease'); };
  assert.equal((await verifyCommitEvidence(undefined, { withTableTransfer: noDatabase })).reason, 'missing-review-evidence');
  assert.equal((await verifyCommitEvidence(sampled(data, [columns[0], columns[2]]), { withTableTransfer: noDatabase })).reason, 'primary-key-not-mapped');
  const wide = [[data[0][0], '🍀'.repeat(128), null, '0x00']];
  assert.equal((await verifyCommitEvidence(sampled(wide), { withTableTransfer: noDatabase })).reason, 'no-bounded-keys');
  assert.equal((await transport({ connectedIdentity: { ...identity, hostname: 'replacement' } }).verify(sampled())).reason, 'destination-identity-changed');
  assert.equal((await transport({ afterLockDefinition: { ...definition, modified: true } }).verify(sampled())).reason, 'destination-definition-changed');
  assert.equal((await transport({ overflowKey: data[0][0] }).verify(sampled())).reason, 'sample-unreadable');
  const controller = new AbortController();
  const { verify } = transport({ onSample: () => controller.abort() });
  await assert.rejects(verify(sampled(), controller.signal), /verification cancelled/i);
});
