'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transferable, assertMappedValues, tableIdentity } = require('../src/db/table-transfer');
const { StreamImporter } = require('../src/db/import-stream');

const column = (name, type, extra = {}) => ({ name, type, nullable: false, ...extra });
const scope = { dialect: 'mysql', serverUniqueId: 'fixture-a', database: 'Sample', tableNameCaseSensitive: false };

test('table copy identity binds the actual server, database and identifier case', () => {
  const first = tableIdentity(scope, 'Ledger');
  assert.equal(tableIdentity({ ...scope, database: 'sample' }, 'ledger'), first);
  assert.notEqual(tableIdentity({ ...scope, database: 'another' }, 'ledger'), first);
  assert.notEqual(tableIdentity({ ...scope, serverUniqueId: 'fixture-b' }, 'ledger'), first);
  assert.notEqual(tableIdentity({ ...scope, tableNameCaseSensitive: true }, 'Ledger'),
    tableIdentity({ ...scope, tableNameCaseSensitive: true }, 'ledger'));
});

test('mapped values preserve exact numeric precision, UTF-8 and binary bytes in supported columns', () => {
  const origin = { columns: [
    column('id', 'BIGINT UNSIGNED'), column('value', 'DECIMAL(20,6)'),
    column('text', 'VARCHAR(64)', { charset: 'utf8mb4' }),
    column('bytes', 'VARBINARY(16)', { nullable: true })
  ], rows: [['9007199254740993', '12345678901234.000001', '값 🍀', '0xffaabb00'],
    ['9007199254740994', '0.001000', 'X', null]] };
  const destinations = [
    column('key', 'BIGINT UNSIGNED'), column('amount', 'DECIMAL(24,6)'),
    column('memo', 'TEXT', { charset: 'utf8mb4' }), column('payload', 'BLOB', { nullable: true })
  ];
  assert.doesNotThrow(() => assertMappedValues(origin, destinations.map((target, source) => ({ column: target, source }))));
  assert.throws(() => assertMappedValues(origin, [{ source: 0, column: column('too_small', 'INT') }]), /row 1 cannot enter/);
  assert.throws(() => assertMappedValues(origin, [{ source: 1, column: column('too_rounded', 'DECIMAL(20,2)') }]), /row 1 cannot enter/);
  assert.throws(() => assertMappedValues(origin, [{ source: 0, column: destinations[2] }]), /compatible exact types/);
  assert.throws(() => assertMappedValues(origin, [{ source: 3, column: column('non_null', 'VARBINARY(16)') }]), /row 2 cannot enter/);
  assert.equal(transferable(column('seen', 'TIMESTAMP(6)')), null);
  assert.equal(transferable(column('shape', 'POINT')), null);
  assert.equal(transferable(column('text', 'VARCHAR(64)', { charset: 'latin1' })), null);
});

test('disposing an idle source-provider importer preserves another owner’s lock', async () => {
  const db = {};
  const released = [];
  const first = new StreamImporter(db, { onStateChange: state => released.push(state) });
  const second = new StreamImporter(db, { source: {}, onStateChange: state => released.push(state) });
  first._mark({ running: true });
  await second.dispose();
  assert.equal(db._streamImportState.running, true);
  assert.equal(released.length, 1);
  await first.dispose();
  assert.equal(db._streamImportState, undefined);
  assert.deepEqual(released, [{ running: true }, null]);
});
