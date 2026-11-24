'use strict';

const measureKinds = new Set(['integer', 'decimal', 'float']);
const operations = new Set(['values', 'count', 'nonnull', 'sum', 'average', 'min', 'max']);
const numberPattern = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function numericColumns(result) {
  const protocols = result.fields;
  return result.columns.flatMap((_, index) => {
    const kind = result.edit?.columns?.[index]?.kind;
    if (kind) return measureKinds.has(kind) ? [index] : [];
    if (protocols?.length) {
      const type = protocols[index]?.type;
      return [0, 1, 2, 3, 4, 5, 8, 9, 13, 246].includes(type) ? [index] : [];
    }
    const values = result.rows.map(row => row[index]).filter(value => value !== null);
    return values.length && values.every(Number.isFinite) ? [index] : [];
  });
}

const pow10 = exponent => 10n ** BigInt(exponent);
const abs = number => number < 0n ? -number : number;

function decimal(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  const parsed = typeof text === 'string' && text.length <= 128 && numberPattern.exec(text);
  if (!parsed) throw Error('A selected numeric column contains a value that cannot be aggregated exactly.');
  const [, sign, whole, fractional = '', exponent = '0'] = parsed;
  const scale = fractional.length - Number(exponent);
  if (!Number.isInteger(scale) || Math.abs(scale) > 450) throw Error('A selected number exceeds the captured decimal range.');
  const units = BigInt(sign + whole + fractional);
  return scale < 0 ? { units: units * pow10(-scale), scale: 0 } : { units, scale };
}

function sum(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return { units: left.units * pow10(scale - left.scale) + right.units * pow10(scale - right.scale), scale };
}

function compareDecimals(left, right) {
  return sum(left, { units: -right.units, scale: right.scale }).units;
}

function fraction(numerator, denominator = 1n) {
  let a = abs(numerator), b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

function subtract(left, right) {
  return fraction(left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function rational(value, divisor = 1) {
  return fraction(value.units, pow10(value.scale) * BigInt(divisor));
}

function format(value) {
  if (!value) return null;
  const { numerator, denominator } = value;
  if (denominator === 1n) return numerator.toString();
  let remainder = denominator, twos = 0, fives = 0;
  while (remainder % 2n === 0n) { remainder /= 2n; twos++; }
  while (remainder % 5n === 0n) { remainder /= 5n; fives++; }
  if (remainder !== 1n) return numerator.toString() + '/' + denominator.toString();
  const scale = Math.max(twos, fives);
  const units = abs(numerator) * pow10(scale) / denominator;
  const digits = units.toString().padStart(scale + 1, '0');
  return (numerator < 0n ? '-' : '') + digits.slice(0, -scale) + '.' + digits.slice(-scale);
}

function groupKey(value) {
  return value === null ? 'null' : typeof value + ':' + (Object.is(value, -0) ? '-0' : String(value));
}

function summarizeGroup(group, operation) {
  if (operation === 'count') return fraction(BigInt(group.count));
  if (operation === 'nonnull') return fraction(BigInt(group.nonNull));
  if (!group.nonNull) return null;
  if (operation === 'min') return rational(group.min);
  if (operation === 'max') return rational(group.max);
  return rational(group.total, operation === 'average' ? group.nonNull : 1);
}

function analyzeResult(result, options = {}) {
  if (!result?.columns?.length || !Array.isArray(result.rows) || result.rows.length > 5000) {
    throw Error('Select a completed result of at most 5,000 captured rows.');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('Choose captured columns and a supported aggregation.');
  const { operation = 'count', category = null, measure = null } = options;
  const valid = value => Number.isInteger(value) && value >= 0 && value < result.columns.length;
  if (!operations.has(operation) || category !== null && !valid(category) ||
      (operation === 'nonnull' && !valid(measure)) ||
      (!['count', 'nonnull'].includes(operation) && !numericColumns(result).includes(measure))) {
    throw Error('Choose a captured column and a supported aggregation.');
  }
  const zero = { units: 0n, scale: 0 }, groups = new Map();
  const perRow = operation === 'values', countsOnly = operation === 'count' || operation === 'nonnull';
  const emptyGroup = categoryValue => ({ category: categoryValue, count: 0, nonNull: 0, total: zero, min: null, max: null });
  if (category === null && !perRow) groups.set(groupKey('All rows'), emptyGroup('All rows'));
  const start = (result.browse?.page ?? 0) * (result.browse?.pageSize ?? 0) + 1;
  for (const [index, row] of result.rows.entries()) {
    const label = category === null ? (perRow ? start + index : 'All rows') : row[category];
    const key = perRow ? index : groupKey(label);
    let group = groups.get(key);
    if (!group) {
      group = emptyGroup(label);
      groups.set(key, group);
    }
    group.count++;
    if (operation === 'count' || row[measure] === null) continue;
    group.nonNull++;
    if (countsOnly) continue;
    const value = decimal(row[measure]);
    group.total = sum(group.total, value);
    if (!group.min || compareDecimals(value, group.min) < 0n) group.min = value;
    if (!group.max || compareDecimals(value, group.max) > 0n) group.max = value;
  }
  const results = [...groups.values()].map(group => ({
    category: group.category,
    ...(Object.is(group.category, -0) && { negativeZero: true }),
    rows: group.count, nonNull: operation === 'count' ? undefined : group.nonNull, value: summarizeGroup(group, operation)
  }));
  let low = rational(zero), high = low;
  for (const { value } of results) {
    if (!value) continue;
    if (subtract(value, low).numerator < 0n) low = value;
    if (subtract(value, high).numerator > 0n) high = value;
  }
  const extent = subtract(high, low);
  function position(value) {
    if (!value) return null;
    if (extent.numerator === 0n) return 0.5;
    const offset = subtract(value, low);
    return Number(offset.numerator * extent.denominator * 1000000n / (offset.denominator * extent.numerator)) / 1000000;
  }
  return {
    scope: 'captured-result', operation, rows: result.rows.length,
    category: category === null ? perRow ? 'Row number' : 'All rows' : result.columns[category],
    measure: operation === 'count' ? null : result.columns[measure],
    truncated: Boolean(result.truncated),
    ...(result.browse && { page: result.browse.page + 1, hasPrevious: result.browse.hasPrevious, hasNext: result.browse.hasNext }),
    ...(result.state?.inTransaction && { uncommitted: true }),
    axis: { minimum: format(low), maximum: format(high), zero: position(rational(zero)) },
    groups: results.map(row => ({ ...row, value: format(row.value), position: position(row.value) }))
  };
}

const normalizeCapturedNumber = value => format(rational(decimal(value)));

function summarizeDecimalSamples(values) {
  const parsed = values.flatMap(value => {
    try { return [{ value, number: decimal(value.replace(/^([+-]?)\./, (_, sign) => sign + '0.')) }]; }
    catch { return []; }
  });
  parsed.sort((a, b) => {
    const order = compareDecimals(a.number, b.number);
    return order < 0n ? -1 : order > 0n ? 1 : 0;
  });
  const count = parsed.length, middle = Math.floor(count / 2);
  if (!count) return { count, omitted: values.length, min: null, median: null, max: null };
  const median = count % 2 ? parsed[middle].value : format(rational(sum(parsed[middle-1].number, parsed[middle].number), 2));
  return { count, omitted: values.length-count, min: parsed[0].value, median, max: parsed.at(-1).value };
}

module.exports = { analyzeResult, numericColumns, normalizeCapturedNumber, summarizeDecimalSamples };
