'use strict';

const { performance } = require('node:perf_hooks');
const { fail } = require('./routine-call');

const maxSets = 8;
const maxFields = 256;
const maxBytes = 4 * 1024 * 1024;

function collectRoutineResults(command, { maxRows, convertCell, stop, finish }) {
  const started = performance.now();
  const resultSets = [];
  let active, receipt, bytes = 0, totalRows = 0, stopped = false;
  function failOnce(error) {
    if (stopped) return;
    stopped = true;
    stop(error);
  }
  function spend(value) {
    bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > maxBytes) failOnce(fail('RESULT_LIMIT', 'The procedure returned more than 4 MiB. Inspect its effects before retrying.'));
    return !stopped;
  }
  command.on('fields', (fields, index) => {
    active = undefined;
    if (stopped || fields === undefined) return;
    if (!Array.isArray(fields) || !fields.length || !Number.isInteger(index) || index !== resultSets.length) {
      failOnce(fail('RESULT', 'The server returned an unexpected procedure result sequence.')); return;
    }
    if (fields.length > maxFields || resultSets.length >= maxSets) {
      failOnce(fail('RESULT_LIMIT', 'The procedure exceeded 8 result sets or 256 columns in one set. Inspect its effects before retrying.')); return;
    }
    const metadata = fields.map(field => ({ name: String(field.name), schema: field.schema || '', table: field.table || '',
      originalTable: field.orgTable || '', originalName: field.orgName || '', type: field.columnType ?? null,
      flags: field.flags ?? 0, characterSet: field.characterSet ?? null }));
    if (!spend(metadata)) return;
    active = { columns: metadata.map(field => field.name), fields: metadata, rows: [], rowCount: 0,
      durationMs: 0, affectedRows: 0, warningCount: 0, truncated: false };
    resultSets.push(active);
  });
  command.on('result', (row, index) => {
    if (stopped) return;
    if (!Array.isArray(row)) {
      if (!row || !Number.isInteger(row.affectedRows) || receipt) {
        failOnce(fail('RESULT', 'The server did not return a single procedure completion status.')); return;
      }
      receipt = row;
      return;
    }
    if (!active || index !== resultSets.length - 1 || active.columns.length !== row.length || receipt) {
      failOnce(fail('RESULT', 'The server returned incompatible procedure result columns.')); return;
    }
    if (totalRows >= maxRows) {
      failOnce(fail('RESULT_LIMIT', 'The procedure exceeded its combined row limit. Inspect its effects before retrying.')); return;
    }
    try {
      const normalized = row.map(convertCell);
      if (spend(normalized)) {
        active.rows.push(normalized);
        active.rowCount++;
        totalRows++;
      }
    } catch { failOnce(fail('RESULT', 'A procedure result cell could not be represented.')); }
  });
  command.once('error', error => { stopped = true; finish(error); });
  command.once('end', () => {
    if (stopped) return;
    if (!receipt) { failOnce(fail('RESULT', 'The server did not confirm procedure completion.')); return; }
    stopped = true;
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    finish(null, { durationMs, resultSets, totalRows, resultBytes: bytes, affectedRows: receipt.affectedRows,
      warningCount: receipt.warningStatus || 0, serverStatus: receipt.serverStatus });
  });
}

module.exports = { collectRoutineResults, maxBytes };
