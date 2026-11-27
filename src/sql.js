'use strict';
// Delimit SQL using visible editor syntax; execution is additionally checked by each backend.
function statementAt(text, offset, { dialect = 'mysql' } = {}) {
  const ranges = [];
  let start = 0, quote = '', lineComment = false, blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === '\\' && dialect === 'mysql') { i++; continue; }
      if (c === quote) { if (n === quote && quote !== ']') i++; else quote = ''; }
      continue;
    }
    if (c === '-' && n === '-' && (dialect === 'sqlite' || i + 2 === text.length || /\s/.test(text[i + 2]))) { lineComment = true; i++; }
    else if (c === '#' && dialect === 'mysql') lineComment = true;
    else if (c === '/' && n === '*') { blockComment = true; i++; }
    else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '[' && dialect === 'sqlite') quote = ']';
    else if (c === ';') { ranges.push({ start, end: i + 1, sql: text.slice(start, i + 1).trim() }); start = i + 1; }
  }
  ranges.push({ start, end: text.length, sql: text.slice(start).trim() });
  const bounded = Math.max(0, Math.min(offset, text.length));
  const index = ranges.findIndex(r => bounded >= r.start && bounded < r.end);
  const previous = ranges[index - 1];
  if (previous?.sql && /^[\t ]*$/.test(text.slice(ranges[index].start, bounded)) &&
      /^[\t ]*(?:\r|\n|$)/.test(text.slice(bounded))) {
    return previous.sql;
  }
  if (index >= 0 && ranges[index].sql) return ranges[index].sql;
  return ranges.filter(r => r.end <= bounded && r.sql).at(-1)?.sql || ranges.find(r => r.sql)?.sql || '';
}
function spreadsheetText(value) {
  let text = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  // Spreadsheet programs can interpret these prefixes as formulas, even inside CSV quotes.
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return text;
}
function csvCell(value) {
  return '"' + spreadsheetText(value).replace(/"/g, '""') + '"';
}
function toCsv(result) {
  return '\uFEFF' + [result.columns, ...result.rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}
module.exports = { statementAt, toCsv, spreadsheetText };
