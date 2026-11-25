'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { observeProcedure, bindProcedure, sessionArguments, readProcedureOutputs } = require('../src/db/routine-call');
const { collectRoutineResults } = require('../src/db/routine-call-stream');

const context = { database: 'db', dialect: 'mysql', version: '8.4.13' };
const target = { schema: 'db', name: 'routine`name', kind: 'procedure' };
const signature = [[1, 'i', 'IN', 'bigint unsigned', null, null], [2, 'a', 'IN', 'decimal(30,6)', null, null]];
const signatureQuery = (source, parameters = signature, account = 'fixture@localhost') => async (sql, values) => {
  if (/^SHOW GLOBAL VARIABLES/.test(sql)) return { rows: [['server_uuid', 'fixture-identity']] };
  if (/^SELECT CURRENT_USER/.test(sql)) return { rows: [[account, null, 'database-host', 3306, 1, 'SYSTEM', 'utf8mb4', 'ANSI_QUOTES']] };
  if (/^SELECT ROUTINE_NAME/.test(sql)) {
    assert.deepEqual(values, ['db', target.name]);
    return { rows: [[target.name]] };
  }
  if (sql.startsWith('SHOW CREATE')) {
    assert.equal(sql, 'SHOW CREATE PROCEDURE `db`.`routine``name`');
    return { columns: ['Procedure', 'Create Procedure', 'sql_mode'], rows: [[target.name, source, 'ANSI_QUOTES']] };
  }
  if (sql.includes('information_schema.PARAMETERS')) return { rows: parameters };
  assert.fail('Unexpected query ' + sql);
};

test('routine review signs the exact visible object, definition, signature and authenticated account', async () => {
  const create = 'CREATE PROCEDURE p(IN i BIGINT, IN a DECIMAL(30,6)) SELECT i, a';
  const first = await observeProcedure(signatureQuery(create), context, target);
  assert.equal(first.sql, 'CALL `db`.`routine``name`(?, ?)');
  assert.deepEqual(first.parameters.map(input => input.kind), ['integer', 'decimal']);
  for (const query of [signatureQuery(create + ' '), signatureQuery(create, [[...signature[0].slice(0, 3), 'int', null, null], signature[1]]),
    signatureQuery(create, signature, 'other@localhost')]) {
    assert.notEqual((await observeProcedure(query, context, target)).fingerprint, first.fingerprint);
  }
  await assert.rejects(observeProcedure(signatureQuery(create), context, { ...target, schema: 'outside' }), /connected database/);
  await assert.rejects(observeProcedure(signatureQuery(null), context, target), /withheld/);
  await assert.rejects(observeProcedure(signatureQuery(create, [[1, 'i', 'invalid', 'bigint']]), context, target), /ambiguous parameters/);
  assert.deepEqual(bindProcedure(first.parameters, [{ kind: 'integer', value: '9007199254740993' }, { kind: 'null' }]).values,
    ['9007199254740993', null]);
  assert.throws(() => bindProcedure(first.parameters, [{ kind: 'text', value: '9007199254740993' }, { kind: 'null' }]), /requires integer/);
  assert.throws(() => bindProcedure(first.parameters, [{ kind: 'integer', value: '1' }]), /one typed value/);
});

test('routine binding allocates only internal writable variables and preserves output positions and exact values', async () => {
  const create = 'CREATE PROCEDURE p(OUT i BIGINT, IN a DECIMAL(30,6), INOUT b BIGINT, OUT note VARCHAR(20)) SELECT a, b';
  const rows = [[1, 'i', 'OUT', 'bigint'], [2, 'a', 'IN', 'decimal(30,6)'], [3, 'b', 'INOUT', 'bigint'], [4, 'note', 'OUT', 'varchar(20)']];
  const review = await observeProcedure(signatureQuery(create, rows), context, target);
  const stem = '@rb_proc_' + review.fingerprint.slice(0, 24) + '_';
  assert.equal(review.sql, 'CALL `db`.`routine``name`(' + stem + '1, ?, ' + stem + '3, ' + stem + '4)');
  const amount = '1234567890123456789.123456';
  const types = [{ kind: 'decimal', value: amount }, { kind: 'null' }];
  const plan = sessionArguments(review, types);
  assert.deepEqual(plan.callValues, [amount]);
  assert.deepEqual(plan.variableValues, [null]);
  assert.equal(plan.initializeSql, 'SET ' + stem + '1 = NULL, ' + stem + '3 = ?, ' + stem + '4 = NULL');
  assert.deepEqual(plan.outputs.map(output => output.ordinal), [1, 3, 4]);
  assert.throws(() => sessionArguments(review, [...types, { kind: 'null' }]), /one typed value/);
  const result = await readProcedureOutputs(async sql => {
    assert.equal(sql, 'SELECT ' + stem + '1, ' + stem + '3, ' + stem + '4');
    return { rows: [['9007199254740993', 12, null]] };
  }, plan.outputs);
  assert.deepEqual(result.map(({ ordinal, mode, value }) => [ordinal, mode, value]), [
    [1, 'OUT', '9007199254740993'], [3, 'INOUT', '12'], [4, 'OUT', null]
  ]);
  assert.equal(result.some(item => Object.hasOwn(item, 'variable')), false);
  await assert.rejects(readProcedureOutputs(async () => ({ rows: [[9007199254740992, 12, null]] }), plan.outputs), /exact procedure output/);
  await assert.rejects(readProcedureOutputs(async () => ({ rows: [[12]] }), plan.outputs), /could not be read/);
});

function driverPreview(options = {}) {
  const command = new EventEmitter();
  const status = { affectedRows: 1, warningStatus: 2, serverStatus: 3 };
  let report, stopped, failure;
  collectRoutineResults(command, { maxRows: 8, convertCell: value => value, ...options,
    stop: error => stopped = error, finish: (error, result) => { failure = error; report = result; } });
  return { command, status, report: () => report, stopped: () => stopped, failure: () => failure };
}

test('prepared CALL separates result sets, duplicate columns and empty sets from final status', () => {
  const { command, status, report } = driverPreview();
  command.emit('fields', [{ name: 'dup' }, { name: 'dup' }], 0);
  command.emit('result', [1, 2], 0);
  command.emit('fields', [{ name: 'empty' }], 1);
  command.emit('fields', undefined);
  command.emit('result', status);
  command.emit('end');
  assert.deepEqual(report().resultSets.map(set => set.columns), [['dup', 'dup'], ['empty']]);
  assert.deepEqual(report().resultSets.map(set => set.rows), [[[1, 2]], []]);
  assert.equal(report().totalRows, 1);
  assert.equal(report().affectedRows, 1);
  assert.equal(report().warningCount, 2);
});

test('prepared CALL permits no set and stops on aggregate bounds or an ambiguous status packet', () => {
  const noData = driverPreview();
  noData.command.emit('result', noData.status);
  noData.command.emit('end');
  assert.deepEqual(noData.report().resultSets, []);
  const limited = driverPreview({ maxRows: 1 });
  limited.command.emit('fields', [{ name: 'first' }], 0);
  limited.command.emit('result', [1], 0);
  limited.command.emit('fields', [{ name: 'second' }], 1);
  limited.command.emit('result', [2], 1);
  limited.command.emit('end');
  assert.equal(limited.stopped().code, 'ROCKETBRAIN_ROUTINE_RESULT_LIMIT');
  assert.equal(limited.report(), undefined);
  const ambiguous = driverPreview();
  ambiguous.command.emit('result', ambiguous.status);
  ambiguous.command.emit('result', ambiguous.status);
  assert.equal(ambiguous.stopped().code, 'ROCKETBRAIN_ROUTINE_RESULT');
  const interrupted = driverPreview();
  interrupted.command.emit('error', Error('server failure'));
  interrupted.command.emit('end');
  assert.match(interrupted.failure().message, /server failure/);
  assert.equal(interrupted.report(), undefined);
});
