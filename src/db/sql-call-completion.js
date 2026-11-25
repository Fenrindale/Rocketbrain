'use strict';

const { sourceLayout, scopeAt } = require('./sql-analysis');
const { availableForms } = require('./sql-call-signatures');
const QUOTE = String.fromCharCode(96);
const quote = name => QUOTE + name.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;

const commands = new Set(['WITH', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const clauses = new Map(Object.entries({ FROM: 'relation', INTO: 'relation', JOIN: 'relation', STRAIGHT_JOIN: 'relation',
  USING: 'relation', WHERE: 'predicate', ON: 'predicate', HAVING: 'having', ORDER: 'order', GROUP: 'group',
  VALUES: 'values', VALUE: 'values', SET: 'assignment', RETURNING: 'projection', LIMIT: '', OFFSET: '', FOR: '',
  LOCK: '', WINDOW: '', UNION: '', INTERSECT: '', EXCEPT: '' }));
const starts = new Set(['SELECT', 'DISTINCT', 'DISTINCTROW', 'ALL', 'WHERE', 'HAVING', 'ON', 'BY', 'AND', 'OR', 'XOR', 'NOT',
  'WHEN', 'THEN', 'ELSE', 'BETWEEN', 'LIKE', 'REGEXP', 'RLIKE', 'RETURNING', 'IS']);
const operators = new Set(['(', ',', '=', '!=', '<>', '<', '>', '<=', '>=', '<=>', '+', '-', '*', '/', '%', '||', '&&', '|', '&', '^', '~']);
const word = token => token?.kind === 'word' ? token.upper : '';
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const named = token => token?.kind === 'word' || token?.kind === 'identifier';

function source(text, offset, options) {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return;
  let layout;
  try { layout = sourceLayout(text, options, { allowIncompleteParentheses: true }); }
  catch { return; }
  if (!commands.has(word(layout.tokens[0])) || layout.nonCode.some(({ start, end }) => start < offset &&
      (offset < end || offset === end && end === text.length && /^(?:#|--)/.test(text.slice(start, end))))) return;
  return layout.tokens;
}

function frameAt(tokens, offset, text) {
  const frames = [{ command: word(tokens[0]), mode: '', terms: [], assigned: false, by: false }];
  for (const [index, token] of tokens.entries()) {
    if (token.end > offset) break;
    let frame = frames.at(-1);
    const upper = word(token);
    if (symbol(token, '(')) {
      const head = tokens[index - 1], beforeHead = tokens[index - 2];
      const functionName = word(head);
      const call = functionName && !starts.has(functionName) && !commands.has(functionName) && !clauses.has(functionName) &&
        text.slice(head.end, token.start).trim() === '' ? { name: functionName, qualified: symbol(beforeHead, '.'),
          spaced: head.end !== token.start, expression: expressionFrame(frame, frames.length > 1) } : undefined;
      frames.push({ mode: frame.mode, assigned: frame.assigned, by: frame.by, terms: [], call });
      continue;
    }
    if (symbol(token, ')')) { if (frames.length > 1) frames.pop(); continue; }
    const first = frame.terms.length === 0;
    frame.terms.push(token);
    if (upper === 'SELECT' && (first || frame.command && (frame.command !== 'SELECT' || frame.mode === ''))) {
      frame.command = 'SELECT'; frame.mode = 'projection'; frame.by = false;
    } else if (first && upper === 'WITH') frame.command = 'WITH';
    else if (frame.command && clauses.has(upper)) {
      frame.mode = clauses.get(upper); frame.assigned = false; frame.by = false;
    } else if (frame.command && upper === 'BY' && ['order', 'group'].includes(frame.mode)) frame.by = true;
    else if (frame.command && frame.mode === 'assignment' && token.kind === 'symbol' && ['=', ','].includes(token.value)) {
      frame.assigned = token.value === '=';
    }
  }
  return frames;
}

function expressionFrame(frame, nested) {
  if (frame.mode === 'assignment') return frame.assigned;
  if (frame.mode === 'values') return nested;
  if (['group', 'order'].includes(frame.mode)) return frame.by;
  return ['projection', 'predicate', 'having'].includes(frame.mode);
}

function matchIdentifier(name, fragment) {
  const text = name.toLowerCase(), prefix = fragment.toLowerCase();
  if (text.startsWith(prefix)) return 0;
  if (prefix.length < 2) return -1;
  const words = name.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1_$2').toLowerCase().split('_').filter(Boolean);
  if (words.length < 2) return -1;
  const pieces = prefix.split('_');
  if (pieces.length > 1 && pieces.every((part, index) => part && words[index]?.startsWith(part))) return 1;
  if (words.map(part => Array.from(part)[0]).join('').startsWith(prefix)) return 1;
  if (words.join('').startsWith(prefix.replaceAll('_', ''))) return 2;
  return -1;
}

function slot(text, offset, options) {
  const tokens = source(text, offset, options);
  if (!tokens) return;
  const index = tokens.findIndex(token => token.kind === 'word' && token.start < offset && offset <= token.end);
  if (index < 0) return;
  const token = tokens[index], qualified = symbol(tokens[index - 1], '.'), qualifier = qualified ? tokens[index - 2] : undefined;
  if (qualified && (!named(qualifier) || symbol(tokens[index - 3], '.'))) return;
  const left = index - (qualified ? 3 : 1), previous = tokens[left];
  const frames = frameAt(tokens, qualified ? qualifier.start : token.start, text), frame = frames.at(-1);
  const keywordArgument = word(previous) === 'FROM' && ['EXTRACT', 'SUBSTRING', 'TRIM'].includes(frame.call?.name) ||
    word(previous) === 'FOR' && frame.call?.name === 'SUBSTRING';
  if (!expressionFrame(frame, frames.length > 1) ||
      !(starts.has(word(previous)) || keywordArgument || previous?.kind === 'symbol' && operators.has(previous.value))) return;
  return { token, prefix: text.slice(token.start, offset), qualifier: qualifier?.value, frame, hasCall: symbol(tokens[index + 1], '(') };
}

function builtinCompletion(position, options) {
  if (!position || position.qualifier) return [];
  const { token, prefix, hasCall } = position, emitted = new Set();
  return availableForms(options).flatMap(entry => {
    const rank = matchIdentifier(entry.name, prefix);
    if (rank < 0 || hasCall && emitted.has(entry.name)) return [];
    emitted.add(entry.name);
    const vendor = options.dialect === 'mysql' ? 'MySQL' : 'MariaDB';
    return [{ label: entry.name, kind: 'function', detail: `${vendor} function · ${entry.label}`,
      description: entry.extra, filterText: prefix, rank,
      start: token.start, end: token.end,
      ...(hasCall ? { insertText: entry.name } : { parts: [entry.name + '(', ...entry.parts, ')'] }) }];
  });
}

function scopedAbbreviations(position, model) {
  if (!position || !model) return [];
  const { token, prefix, qualifier, frame, hasCall } = position;
  if (hasCall) return [];
  const scope = scopeAt(model, token.start);
  if (!scope) return [];
  const relations = new Map();
  for (let current = scope; current; current = current.parent) {
    const unique = new Map();
    for (const relation of current.relations) if (relation.alias) {
      const key = relation.alias.toLowerCase();
      unique.set(key, unique.has(key) ? null : relation);
    }
    for (const [key, relation] of unique) if (!relations.has(key)) relations.set(key, relation);
  }
  const matching = qualifier ? [relations.get(qualifier.toLowerCase())] : [...relations.values()];
  const result = [], selected = new Set();
  function add(name, kind, detail, insertText, abbreviationOnly = false) {
    const rank = matchIdentifier(name, prefix), identity = kind + '\0' + detail + '\0' + name;
    if (rank < 0 || abbreviationOnly && rank === 0 || selected.has(identity)) return;
    selected.add(identity);
    result.push({ label: name, kind, detail, insertText, rank, filterText: prefix, start: token.start, end: token.end });
  }
  for (const relation of matching.filter(Boolean)) {
    if (!qualifier && relation.columns.length) add(relation.alias, 'alias', 'Relation alias · ' + relation.name, quote(relation.alias) + '.');
    for (const column of relation.columns) add(column.name, 'column', 'Abbreviated column · ' + relation.alias,
      qualifier ? quote(column.name) : quote(relation.alias) + '.' + quote(column.name), true);
  }
  if (!qualifier && ['order', 'group', 'having'].includes(frame.mode)) {
    const aliases = model.references.filter(item => item.kind === 'projection-definition' && item.scopeId === scope.id);
    const counts = new Map();
    for (const alias of aliases) counts.set(alias.name.toLowerCase(), (counts.get(alias.name.toLowerCase()) || 0) + 1);
    for (const alias of aliases) if (counts.get(alias.name.toLowerCase()) === 1) add(alias.name, 'alias', 'Projection alias', quote(alias.name));
  }
  return result;
}

function callCompletions(text, offset, options, model) {
  const position = slot(text, offset, options);
  return [...scopedAbbreviations(position, model), ...builtinCompletion(position, options)].slice(0, 100);
}

function activeFor(entry, terms) {
  const words = terms.map(word), commas = terms.filter(token => symbol(token, ',')).length;
  if (entry.typedJson) {
    const returning = words.indexOf('RETURNING');
    if (returning < 0) return -1;
    const exception = words.findIndex((value, index) => ['EMPTY', 'ERROR'].includes(value) && words[index - 1] === 'ON');
    if (exception > returning) return 4;
    return words.slice(returning + 1).some(value => ['NULL', 'ERROR', 'DEFAULT'].includes(value)) ? 3 : 2;
  }
  if (words.includes('RETURNING')) return -1;
  const markers = entry.separators ?? [];
  if (markers.length) {
    if (commas || entry.extra && !markers.some(marker => words.includes(marker)) && !words.includes('BOTH')) return -1;
    return markers.reduce((active, marker) => active + Number(words.includes(marker)), 0);
  }
  if (['SUBSTRING', 'TRIM'].includes(entry.name) && (words.includes('FROM') || words.includes('BOTH'))) return -1;
  if (commas < entry.parameters.length) return commas;
  if (entry.variadic) return entry.parameters.length - 1;
  if (entry.repeat) return entry.parameters.length - entry.repeat + (commas - entry.parameters.length) % entry.repeat;
  return -1;
}

function callSignature(text, offset, options) {
  const tokens = source(text, offset, options);
  if (!tokens) return;
  const frames = frameAt(tokens, offset, text);
  const frame = frames.slice(1).reverse().find(item => item.call);
  const call = frame?.call;
  if (!call?.expression || call.qualified || call.spaced && !options.sqlMode?.includes('IGNORE_SPACE')) return;
  const signatures = availableForms(options).filter(item => item.name === call.name).flatMap(entry => {
    const active = activeFor(entry, frame.terms);
    return active < 0 ? [] : [{ label: entry.label, parameters: entry.parameters, active }];
  });
  if (signatures.length) return signatures;
}

module.exports = { callCompletions, callSignature };
