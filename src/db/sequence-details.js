'use strict';

const { loadSource } = require('./object-source');

const legacyDetails = 'SHOW CREATE SEQUENCE and sequence state';
const nativeDetails = 'INFORMATION_SCHEMA.SEQUENCES and sequence state';
const failure = (code, message) => Object.assign(new Error(message), { code: 'ROCKETBRAIN_SEQUENCE_' + code });
const changed = () => failure('CHANGED', 'The sequence definition or its metadata changed while it was being read. Refresh the sequence details.');
const invalid = () => failure('VALUES', 'The server did not return a complete supported sequence snapshot.');
const qualify = ({ schema, name }) => [schema, name].map(value => '`' + value.replaceAll('`', '``') + '`').join('.');
const binaryMatch = column => 'CAST(' + column + ' AS BINARY) = CAST(? AS BINARY)';
const inSchema = [binaryMatch('TABLE_SCHEMA'), binaryMatch('TABLE_NAME'), "TABLE_TYPE = 'SEQUENCE'"].join(' AND ');
const integerTypes = new Map([['tinyint', 8], ['smallint', 16], ['mediumint', 24], ['int', 32], ['bigint', 64]]);

function integer(value) {
  // CAST AS CHAR keeps values beyond Number.MAX_SAFE_INTEGER exact through every driver.
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]{0,19})$/.test(value)) throw invalid();
  const exact = BigInt(value);
  if (exact < -(2n ** 63n) || exact > 2n ** 64n - 1n) throw invalid();
  return value;
}

function cycling(value) {
  if (value === '1') return true;
  if (value === '0') return false;
  throw invalid();
}

function typeOf(dataType, precision) {
  const match = typeof dataType === 'string' && /^(tinyint|smallint|mediumint|int|bigint)( unsigned)?$/i.exec(dataType);
  if (!match || integerTypes.get(match[1].toLowerCase()) !== Number(precision)) throw invalid();
  return { name: match[1].toUpperCase(), unsigned: Boolean(match[2]), precision: Number(precision) };
}

function readSequenceState(row) {
  if (!Array.isArray(row) || row.length !== 8) throw changed();
  const [start, minimum, maximum, increment, cacheSize, cycleCount, nextNotCached, cycle] = row;
  const exact = { start: integer(start), minimum: integer(minimum), maximum: integer(maximum), increment: integer(increment),
    cacheSize: integer(cacheSize), cycleCount: integer(cycleCount), nextNotCached: integer(nextNotCached), cycle: cycling(cycle) };
  if (BigInt(exact.minimum) >= BigInt(exact.maximum) || BigInt(exact.cacheSize) < 0n || BigInt(exact.cycleCount) < 0n) throw invalid();
  return exact;
}

async function readNativeType(query, object, state) {
  const { rows } = await query('SELECT DATA_TYPE,NUMERIC_PRECISION,CAST(START_VALUE AS CHAR),CAST(MINIMUM_VALUE AS CHAR),' +
    'CAST(MAXIMUM_VALUE AS CHAR),CAST(INCREMENT AS CHAR),CAST(CYCLE_OPTION AS CHAR) FROM information_schema.SEQUENCES WHERE ' +
    [binaryMatch('SEQUENCE_SCHEMA'), binaryMatch('SEQUENCE_NAME')].join(' AND ') + ' LIMIT 2', [object.schema, object.name]);
  if (rows.length !== 1 || rows[0].length !== 7) throw changed();
  const [dataType, precision, start, minimum, maximum, increment, cycle] = rows[0];
  if (integer(start) !== state.start || integer(minimum) !== state.minimum || integer(maximum) !== state.maximum ||
      integer(increment) !== state.increment || cycling(cycle) !== state.cycle) throw changed();
  return typeOf(dataType, precision);
}

async function inspectSequence(query, context, object) {
  const version = /^(?:5\.5\.5-)?(\d+)\.(\d+)\./.exec(context.version);
  if (context.dialect !== 'mariadb' || !context.mariaExtended || !version || object?.kind !== 'sequence') {
    throw failure('ENGINE', 'Open a native MariaDB sequence to inspect its details.');
  }
  const before = await loadSource(query, context, object);
  const target = before.object;
  const stateFields = ['start_value', 'minimum_value', 'maximum_value', 'increment', 'cache_size', 'cycle_count',
    'next_not_cached_value', 'cycle_option'].map(name => 'CAST(`' + name + '` AS CHAR)').join(',');
  const { rows } = await query('SELECT ' + stateFields + ' FROM ' + qualify(target) +
    ' WHERE EXISTS (SELECT 1 FROM information_schema.TABLES WHERE ' + inSchema + ') LIMIT 2', [target.schema, target.name]);
  if (rows.length !== 1) throw changed();
  const state = readSequenceState(rows[0]);
  const modern = +version[1] > 11 || +version[1] === 11 && +version[2] >= 5;
  const type = modern ? await readNativeType(query, target, state) : typeOf('bigint', 64);
  const after = await loadSource(query, context, target);
  if (after.source !== before.source) throw changed();

  return { object: target, version: context.version, provenance: modern ? nativeDetails : legacyDetails, type,
    ...state, observedAt: new Date().toISOString() };
}

function sequenceDetailsText(report) {
  const { object, type } = report;
  const increment = report.increment === '0' ? '0 (uses server auto-increment settings)' : report.increment;
  return [
    object.schema + '.' + object.name,
    'MariaDB sequence details',
    '',
    'Server                   ' + report.version,
    'Observed at              ' + report.observedAt,
    'Evidence                 ' + report.provenance,
    '',
    'Type                     ' + type.name + (type.unsigned ? ' UNSIGNED' : '') + ' (' + type.precision + ' bits)',
    'Configured start         ' + report.start,
    'Minimum                  ' + report.minimum,
    'Maximum                  ' + report.maximum,
    'Configured increment     ' + increment,
    'Cache size               ' + report.cacheSize,
    'Cycle                    ' + (report.cycle ? 'Yes' : 'No'),
    'Cycle count              ' + report.cycleCount,
    'Next non-cached boundary ' + report.nextNotCached,
    '',
    'The server may still return values from its active cache before reaching this boundary.',
    'Inspecting the sequence does not consume a value.'
  ].join('\n') + '\n';
}

module.exports = { inspectSequence, sequenceDetailsText };
