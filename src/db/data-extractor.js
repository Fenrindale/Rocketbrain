'use strict';

const { columnKind } = require('./result-export');
const { spreadsheetText } = require('../sql');

const limits = Object.freeze({ scriptBytes: 64 * 1024, outputBytes: 32 * 1024 * 1024, rowBytes: 256 * 1024,
  columns: 256, rows: 5000, instructions: 192, previewBytes: 8192 });
const extensions = new Set(['txt', 'csv', 'tsv', 'jsonl', 'ndjson', 'md', 'xml', 'html', 'sql']);
const formats = new Set(['raw', 'json', 'csv', 'tsv', 'xml', 'base64']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_DATA_EXTRACTOR' });

function describeCapture(result) {
  if (!Array.isArray(result?.columns) || !result.columns.length || result.columns.length > limits.columns ||
      !Array.isArray(result.rows) || result.rows.length > limits.rows) throw fail('Choose captured result rows and between one and 256 columns.');
  const columns = result.columns.map((name, index) => {
    const field = result.fields?.[index];
    if (typeof name !== 'string' || Buffer.byteLength(name) > 4096) throw fail('The captured result contains an unsupported column name.');
    const origin = value => typeof value === 'string' && Buffer.byteLength(value) <= 4096 ? value : '';
    return { name, ordinal: index + 1, kind: columnKind(field), protocolType: Number.isInteger(field?.type) ? field.type : null,
      schema: origin(field?.schema), table: origin(field?.originalTable), originalName: origin(field?.originalName) };
  });
  const one = key => columns[0][key] && columns.every(column => column[key] === columns[0][key]) ? columns[0][key] : null;
  return { columns, schema: one('schema'), table: one('table'), rowCount: result.rows.length,
    partial: Boolean(result.truncated || result.browse?.hasPrevious || result.browse?.hasNext) };
}

function allowed(object, keys) {
  return plain(object) && Object.keys(object).every(key => keys.includes(key));
}

function encoded(value, format) {
  if (format === 'json') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (format === 'csv') return '"' + spreadsheetText(value).replace(/"/g, '""') + '"';
  if (format === 'tsv') return spreadsheetText(value).replace(/[\t\r\n]/g, ' ');
  const text = value === null ? '' : Object.is(value, -0) ? '-0' : String(value);
  if (format === 'base64') return Buffer.from(text).toString('base64');
  if (format === 'xml') return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&apos;' }[character]));
  return text;
}

function exactNumber(value) {
  const text = Object.is(value, -0) ? '-0' : String(value);
  if (text.length > 96 || !/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw fail('The selected sum column contains a value without an exact decimal representation.');
  const [integer, fraction = ''] = text.split('.');
  return { value: BigInt(integer + fraction), scale: fraction.length };
}

function addDecimal(sum, next) {
  if (next.scale > sum.scale) {
    sum.value *= 10n ** BigInt(next.scale - sum.scale);
    sum.scale = next.scale;
  }
  sum.value += next.value * 10n ** BigInt(sum.scale - next.scale);
}

function printDecimal({ value, scale, count }) {
  if (!count) return null;
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  return (value < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}

function compileExtractor(source, catalog) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > limits.scriptBytes) throw fail('Choose a UTF-8 extractor script up to 64 KiB.');
  let script;
  try { script = JSON.parse(source); } catch { throw fail('The extractor script is not valid JSON.'); }
  if (!allowed(script, ['version', 'name', 'extension', 'header', 'row', 'footer', 'filter']) || script.version !== 1 ||
      typeof script.name !== 'string' || !script.name.trim() || script.name.length > 80 || /[\x00-\x1f\x7f]/.test(script.name) ||
      !extensions.has(script.extension)) throw fail('Use an extractor script with version 1, a name and a supported output extension.');
  let nodes = 0;
  const aggregates = new Map();
  function indexFor(selector) {
    if (Number.isInteger(selector) && selector >= 1 && selector <= catalog.columns.length) return selector - 1;
    const matches = catalog.columns.filter(column => column.name === selector);
    if (matches.length !== 1) throw fail('Choose a unique result column name or its 1-based position.');
    return matches[0].ordinal - 1;
  }
  function compileTemplate(source, phase) {
    if (!Array.isArray(source) || source.length > 64) throw fail('Use an array of at most 64 instructions per extractor template.');
    return source.map(atom => {
      if (++nodes > limits.instructions) throw fail('The extractor script exceeds its instruction limit.');
      if (typeof atom === 'string' && Buffer.byteLength(atom) <= 4096) return () => atom;
      if (!plain(atom)) throw fail('Extractor instructions must be strings or supported objects.');
      const format = atom.as ?? 'raw';
      if (!formats.has(format)) throw fail('Choose a supported extractor value encoding.');
      if (Object.hasOwn(atom, 'cell') && allowed(atom, ['cell', 'as']) && phase === 'row') {
        const index = indexFor(atom.cell);
        return context => encoded(context.row[index], format);
      }
      if (Object.hasOwn(atom, 'meta') && allowed(atom, ['meta', 'as'])) {
        if (typeof atom.meta !== 'string') throw fail('Choose an extractor metadata field.');
        const sourceKeys = ['schema', 'table', 'rowCount', 'partial'];
        if (atom.meta.startsWith('source.') && sourceKeys.includes(atom.meta.slice(7))) return () => encoded(catalog[atom.meta.slice(7)], format);
        const fields = ['name', 'ordinal', 'kind', 'protocolType', 'schema', 'table', 'originalName'];
        if (phase === 'column' && atom.meta.startsWith('column.') && fields.includes(atom.meta.slice(7))) return context => encoded(context.column[atom.meta.slice(7)], format);
        if (phase === 'row' && atom.meta === 'row.number') return context => encoded(context.number, format);
        if (phase === 'footer' && atom.meta === 'rows.emitted') return context => encoded(context.emitted, format);
        throw fail('The extractor metadata field is unavailable in this template.');
      }
      if (Object.hasOwn(atom, 'columns') && allowed(atom, ['columns']) && phase === 'header') {
        const value = atom.columns;
        if (!allowed(value, ['template', 'separator']) || typeof value.separator !== 'string' || Buffer.byteLength(value.separator) > 64) {
          throw fail('Provide a column template and bounded separator.');
        }
        const renderColumn = compileTemplate(value.template, 'column');
        return () => {
          let bytes = 0;
          return catalog.columns.map((column, index) => {
            const output = (index ? value.separator : '') + render(renderColumn, { column });
            if ((bytes += Buffer.byteLength(output)) > limits.rowBytes) throw fail('A generated extractor header exceeds 256 KiB.');
            return output;
          }).join('');
        };
      }
      if (Object.hasOwn(atom, 'aggregate') && allowed(atom, ['aggregate', 'as']) && phase === 'footer') {
        const value = atom.aggregate;
        if (!allowed(value, ['operation', 'cell']) || !['count', 'sum'].includes(value.operation)) throw fail('Choose a count or sum aggregate.');
        const index = indexFor(value.cell), key = value.operation + ':' + index;
        if (value.operation === 'sum' && !['integer', 'decimal'].includes(catalog.columns[index].kind)) {
          throw fail('An exact sum requires an observed database integer or decimal result column.');
        }
        aggregates.set(key, { index, operation: value.operation });
        return context => encoded(value.operation === 'count' ? context.aggregates.get(key).count : printDecimal(context.aggregates.get(key)), format);
      }
      throw fail('Unknown or misplaced extractor instruction.');
    });
  }

  const header = compileTemplate(script.header ?? [], 'header');
  const row = compileTemplate(script.row, 'row');
  const footer = compileTemplate(script.footer ?? [], 'footer');
  if (!row.length) throw fail('Provide a nonempty extractor row template.');
  function compileFilter(filter) {
    if (filter === undefined) return () => true;
    if (!allowed(filter, ['cell', 'equals']) || !Object.hasOwn(filter, 'equals') || !scalar(filter.equals) ||
        typeof filter.equals === 'string' && Buffer.byteLength(filter.equals) > 4096) throw fail('Use a typed scalar equality filter.');
    const index = indexFor(filter.cell);
    return cells => Object.is(cells[index], filter.equals);
  }
  return { name: script.name.trim(), extension: script.extension, columns: catalog.columns.length, header, row, footer,
    include: compileFilter(script.filter), aggregates };
}

function render(template, context) {
  let bytes = 0;
  const parts = [];
  for (const item of template) {
    const output = item(context);
    bytes += Buffer.byteLength(output);
    if (bytes > limits.rowBytes) throw fail('A generated extractor chunk exceeds 256 KiB.');
    parts.push(output);
  }
  return parts.join('');
}

async function* extract(program, input, { guard = () => true, signal } = {}) {
  let number = 0, emitted = 0, bytes = 0;
  const aggregateState = new Map([...program.aggregates].map(([key, aggregate]) => [key, { ...aggregate, count: 0, value: 0n, scale: 0 }]));
  const check = () => {
    if (signal?.aborted || !guard()) throw fail('The captured result changed or the extractor was cancelled. Review it again.');
  };
  const write = (template, context) => {
    check();
    const chunk = Buffer.from(render(template, context));
    if ((bytes += chunk.length) > limits.outputBytes) throw fail('The extracted output exceeds 32 MiB. Export a smaller result.');
    return chunk;
  };
  yield write(program.header, undefined);
  for await (const cells of input) {
    check();
    if (++number > limits.rows || !Array.isArray(cells) || cells.length !== program.columns || [...cells].some(value => !scalar(value) ||
        typeof value === 'string' && Buffer.byteLength(value) > limits.rowBytes)) throw fail('A captured row exceeds the extractor input limits.');
    if (number % 128 === 0) {
      await new Promise(resolve => setImmediate(resolve));
      check();
    }
    if (!program.include(cells)) continue;
    emitted++;
    for (const total of aggregateState.values()) {
      const cell = cells[total.index];
      if (cell === null) continue;
      total.count++;
      if (total.operation === 'sum') addDecimal(total, exactNumber(cell));
    }
    yield write(program.row, { row: cells, number });
  }
  yield write(program.footer, { emitted, aggregates: aggregateState });
}

module.exports = { compileExtractor, describeCapture, extract, limits };
