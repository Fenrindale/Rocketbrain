'use strict';

const { createHash } = require('node:crypto');

const limits = Object.freeze({ cells: 64, fileBytes: 2 * 1024 * 1024, sourceBytes: 128 * 1024,
  columns: 64, rows: 128, displayBytes: 64 * 1024, fieldLength: 1024 });
const bytes = value => Buffer.byteLength(value, 'utf8');
const fail = message => new Error(message);
const sourceDigest = source => createHash('sha256').update(source).digest('hex');
const hash = /^[a-f0-9]{64}$/;

function validatePinnedResult(result) {
  if (!result || typeof result.sourceDigest !== 'string' || !hash.test(result.sourceDigest) ||
      !Number.isSafeInteger(result.capturedAt) ||
      result.capturedAt < 0 || result.capturedAt > 8640000000000000 ||
      typeof result.truncated !== 'boolean' || !Array.isArray(result.columns) ||
      !result.columns.length || result.columns.length > limits.columns || !Array.isArray(result.rows) ||
      result.rows.length > limits.rows) throw fail('The notebook contains an invalid saved result.');
  const isField = value => typeof value === 'string' && value.length <= limits.fieldLength;
  if (!result.columns.every(isField) || !result.rows.every(row => Array.isArray(row) &&
      row.length === result.columns.length && row.every(value => value === null || isField(value)))) {
    throw fail('The notebook contains an invalid saved result table.');
  }
  const { sourceDigest, capturedAt, truncated, columns, rows } = result;
  const clean = { sourceDigest, capturedAt, truncated, columns, rows };
  if (bytes(JSON.stringify(clean)) > limits.displayBytes) throw fail('The saved notebook result exceeds 64 KiB.');
  return clean;
}

function notebookRecords(cells) {
  if (!Array.isArray(cells) || cells.length > limits.cells) throw fail('A SQL notebook can contain at most 64 cells.');
  return cells.map(cell => {
    if (!cell || !['markdown', 'sql'].includes(cell.type) || typeof cell.source !== 'string' ||
        cell.source.includes('\0') || bytes(cell.source) > limits.sourceBytes) {
      throw fail('A SQL notebook cell must be SQL or Markdown text of at most 128 KiB.');
    }
    if (cell.result !== undefined && cell.type !== 'sql') throw fail('Only SQL cells can contain saved results.');
    const { type, source } = cell;
    return { type, source, ...(cell.result !== undefined && { result:validatePinnedResult(cell.result) }) };
  });
}

function encodeNotebook(cells) {
  const payload = Buffer.from(JSON.stringify({ version:1, cells:notebookRecords(cells) }, null, 2) + '\n', 'utf8');
  if (payload.length > limits.fileBytes) throw fail('The SQL notebook exceeds 2 MiB. Remove saved results or split the notebook.');
  return payload;
}

function decodeNotebook(data) {
  if (!data.length) return [];
  if (data.length > limits.fileBytes) throw fail('SQL notebooks must be at most 2 MiB.');
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(data)); }
  catch { throw fail('Open a UTF-8 Rocketbrain SQL notebook.'); }
  if (document?.version !== 1) throw fail('This SQL notebook format version is unsupported.');
  return notebookRecords(document.cells);
}

function cellText(value) {
  if (value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function captureResult({ columns, rows, truncated }, source) {
  if (!columns.length) throw fail('This statement did not return a table.');
  const width = Math.min(columns.length, limits.columns);
  let clipped = truncated || width < columns.length || rows.length > limits.rows;
  const field = (value, length = limits.fieldLength) => {
    const text = cellText(value);
    if (text === null || text.length <= length) return text;
    clipped = true;
    return text.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
  };
  const sample = { sourceDigest:sourceDigest(source), capturedAt:Date.now(), truncated:false,
    columns:columns.slice(0, width).map(name => field(name, 256)), rows:[] };
  let totalBytes = bytes(JSON.stringify(sample));
  for (const row of rows.slice(0, limits.rows)) {
    const values = row.slice(0, width).map(value => field(value));
    totalBytes += bytes(JSON.stringify(values)) + 1;
    if (totalBytes > limits.displayBytes) {
      clipped = true;
      break;
    }
    sample.rows.push(values);
  }
  return validatePinnedResult({ ...sample, truncated:Boolean(clipped) });
}

const escapeHtml = text => text.replace(/[&<>"']/g, character =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);

function renderResult(result) {
  const caption = 'Captured ' + new Date(result.capturedAt).toISOString() + ' · ' +
    result.rows.length + ' displayed row(s)' + (result.truncated ? ' · Preview limited' : '');
  const column = name => '<th scope="col">' + escapeHtml(name) + '</th>';
  const entry = value => '<td>' + (value === null ? '<em>NULL</em>' : escapeHtml(value)) + '</td>';
  return {
    html:'<table><caption>' + caption + '</caption><thead><tr>' + result.columns.map(column).join('') +
      '</tr></thead><tbody>' + result.rows.map(row => '<tr>' + row.map(entry).join('') + '</tr>').join('') + '</tbody></table>',
    text:[caption, result.columns.map(value => JSON.stringify(value)).join('\t'),
      ...result.rows.map(row => row.map(value => value === null ? 'NULL' : JSON.stringify(value)).join('\t'))].join('\n')
  };
}

module.exports = { captureResult, decodeNotebook, encodeNotebook, limits, renderResult, sourceDigest };
