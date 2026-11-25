'use strict';

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const TYPE = /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:\[\]){0,8}$/;
const MAX_TEMPLATE = 4096;

function structuralQuery(value = {}) {
  const { mode = 'expression', pattern, replacement, constraints = [] } = value;
  if (!['expression', 'statement'].includes(mode)) throw Error('Choose an expression or statement template.');
  const template = (text, title) => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEMPLATE || text.includes('\0')) {
      throw Error(title + ' must contain 1–4096 characters of Java source.');
    }
    return text.trim();
  };
  if (!Array.isArray(constraints) || constraints.length > 16) throw Error('Set up to 16 capture type constraints.');
  const names = new Set();
  const typed = constraints.map(({ name, type, relation = 'exact' } = {}) => {
    if (typeof name !== 'string' || !NAME.test(name) || names.has(name) ||
        typeof type !== 'string' || type.length > 200 || !TYPE.test(type) ||
        !['exact', 'assignable'].includes(relation)) throw Error('Use distinct Java capture names and class, primitive or array types.');
    names.add(name);
    return { name, type, relation };
  });
  return { mode, pattern:template(pattern, 'Search template'),
    ...(replacement !== undefined && { replacement:template(replacement, 'Replacement template') }),
    constraints:typed };
}

function parseCaptureConstraints(input) {
  if (!input.trim()) return [];
  return input.split(',').map(text => {
    const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*(=|<:)\s*(\S+)\s*$/.exec(text);
    if (!match) throw Error('Use name=Type for an exact type or name<:Type for an assignable type.');
    return { name:match[1], type:match[3], relation:match[2] === '=' ? 'exact' : 'assignable' };
  });
}

function sourcePosition(text, offset) {
  const before = text.slice(0, offset), last = before.lastIndexOf('\n');
  return { line:before.split('\n').length - 1, character:offset - last - 1 };
}

function reviewedStructuralMatches(result, sources) {
  if (!result || !Array.isArray(result.matches) || typeof result.truncated !== 'boolean') {
    throw Error('The Java compiler did not return structural matches.');
  }
  if (result.error) throw Error(result.error);
  const byUri = new Map(sources.map(source => [source.uri, source.text]));
  return {
    truncated:result.truncated,
    matches:result.matches.map((match, index) => {
      const { uri, start, end, replacement, blocked, captures } = match, text = byUri.get(uri);
      if (text === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || end <= start || end > text.length || !Array.isArray(captures) ||
          (replacement !== undefined && typeof replacement !== 'string') ||
          (blocked !== undefined && typeof blocked !== 'string')) throw Error('Invalid structural match returned by the Java compiler.');
      const before = text.slice(start, end);
      return { id:index + 1, uri, start, end,
        range:{ start:sourcePosition(text,start),end:sourcePosition(text,end) },
        snippet:before.slice(0, 240), captures, ...(blocked && { blocked }),
        ...(replacement !== undefined && replacement !== before && { replacement }) };
    })
  };
}

function structuralEdits(matches, ids, sources) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || ids.length > 500) {
    throw Error('Select distinct matches to replace.');
  }
  const chosen = matches.filter(match => ids.includes(match.id));
  if (chosen.length !== ids.length || chosen.some(match => match.replacement === undefined)) {
    throw Error('Choose replaceable matches from this search.');
  }
  const changes = Object.create(null), after = new Map();
  const affected = new Set(chosen.map(match => match.uri));
  if (affected.size > 30) throw Error('Review at most 30 Java files per replacement.');
  for (const source of sources) {
    if (!affected.has(source.uri)) continue;
    const ordered = chosen.filter(match => match.uri === source.uri).sort((a,b) => b.start - a.start);
    let text = source.text, boundary = text.length;
    for (const match of ordered) {
      if (match.end > boundary) throw Error('Overlapping structural matches require separate reviews.');
      text = text.slice(0,match.start) + match.replacement + text.slice(match.end);
      boundary = match.start;
    }
    if (Buffer.byteLength(text) > 512 * 1024) throw Error('A replacement extends a Java source past 512 KiB.');
    after.set(source.uri, text);
    changes[source.uri] = ordered.map(({ range, replacement }) => ({ range, newText:replacement }));
  }
  return { changes, sources:sources.map(source => ({ ...source, text:after.get(source.uri) ?? source.text })) };
}

module.exports = { structuralQuery, parseCaptureConstraints, reviewedStructuralMatches, structuralEdits };
