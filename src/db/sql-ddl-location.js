'use strict';

const { sourceTokens } = require('./sql-analysis');

const names = new Set(['table', 'view', 'procedure', 'function']);
const isName = token => token?.kind === 'word' || token?.kind === 'identifier';
const keyword = (token, value) => token?.kind === 'word' && token.upper === value;
const span = token => ({ start: token.start, end: token.end });

function header(tokens, object) {
  if (!names.has(object.kind) || !keyword(tokens[0], 'CREATE')) return null;
  const kind = object.kind.toUpperCase();
  let at = tokens.findIndex((token, index) => index > 0 && keyword(token, kind));
  if (at < 0) return null;
  at++;
  if (keyword(tokens[at], 'IF') && keyword(tokens[at + 1], 'NOT') && keyword(tokens[at + 2], 'EXISTS')) at += 3;
  if (!isName(tokens[at])) return null;
  if (tokens[at + 1]?.value === '.') {
    if ((object.schema !== undefined && tokens[at].value !== object.schema) || !isName(tokens[at + 2])) return null;
    at += 2;
  }
  return object.name === undefined || tokens[at].value === object.name ? at : null;
}

function parts(tokens, start, end, boundary) {
  let first = start;
  const values = [];
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (token.kind === 'symbol' && token.value === '(' && token.close < end) {
      i = token.close;
      continue;
    }
    if (boundary(token)) { values.push([first, i]); first = i + 1; }
  }
  values.push([first, end]);
  return values;
}

function unique(tokens, name) {
  const matches = tokens.filter(token => isName(token) && token.value === name);
  return matches.length === 1 ? span(matches[0]) : undefined;
}

function tableColumn(tokens, nameIndex, name) {
  const open = tokens[nameIndex + 1];
  if (open?.value !== '(' || !Number.isInteger(open.close)) return undefined;
  // Only a token at the start of a top-level column declaration can be its definition.
  // A matching string, indexed column, generated expression or constraint is never an anchor.
  const constraints = new Set(['PRIMARY', 'KEY', 'UNIQUE', 'INDEX', 'FOREIGN', 'CONSTRAINT', 'CHECK', 'FULLTEXT', 'SPATIAL', 'PERIOD']);
  const columns = parts(tokens, nameIndex + 2, open.close, token => token.kind === 'symbol' && token.value === ',').flatMap(([start, end]) => {
    const token = tokens[start];
    return end > start + 1 && (token.kind === 'identifier' || token.kind === 'word' && !constraints.has(token.upper)) ? [token] : [];
  });
  return unique(columns, name);
}

function viewColumn(tokens, nameIndex, name) {
  let at = nameIndex + 1;
  const list = tokens[at];
  if (list?.value === '(' && Number.isInteger(list.close)) {
    const labels = parts(tokens, at + 1, list.close, token => token.kind === 'symbol' && token.value === ',');
    return labels.every(([a, b]) => b === a + 1 && isName(tokens[a])) ? unique(labels.map(([a]) => tokens[a]), name) : undefined;
  }
  if (!keyword(tokens[at], 'AS')) return undefined;
  at++;
  let end = tokens.length;
  while (tokens[at]?.value === '(' && Number.isInteger(tokens[at].close)) {
    end = tokens[at].close;
    at++;
  }
  if (keyword(tokens[at], 'WITH')) {
    // Consume the WITH list first. A SELECT inside a CTE is not the view's output.
    while (at < end && !keyword(tokens[at], 'SELECT')) {
      const token = tokens[at];
      at = token.value === '(' && token.close < end ? token.close + 1 : at + 1;
    }
  }
  if (!keyword(tokens[at], 'SELECT')) return undefined;
  at++;
  while (['ALL', 'DISTINCT', 'DISTINCTROW'].includes(tokens[at]?.upper) && tokens[at].kind === 'word') at++;
  const clauses = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'FOR']);
  for (let i = at; i < end; i++) {
    const token = tokens[i];
    if (token.value === '(' && token.close < end) i = token.close;
    else if (token.kind === 'word' && clauses.has(token.upper)) { end = i; break; }
  }
  const output = parts(tokens, at, end, token => token.kind === 'symbol' && token.value === ',').flatMap(([first, next]) => {
    const label = tokens[next - 1];
    if (!isName(label)) return [];
    if (next > first + 2 && keyword(tokens[next - 2], 'AS')) return [label];
    // An unaliased identifier path exposes its terminal identifier, including a quoted column name.
    const path = tokens.slice(first, next);
    return path.length % 2 === 1 && path.every((token, index) => index % 2 === 0 ? isName(token) : token.value === '.') ? [label] : [];
  });
  return unique(output, name);
}

function ddlDefinitionLocation(loaded, member, observedMode = []) {
  try {
    const creationMode = loaded.settings?.sql_mode;
    const sqlMode = typeof creationMode === 'string' ? creationMode.split(',').filter(Boolean) : observedMode;
    const tokens = sourceTokens(loaded.source, { dialect: loaded.dialect, sqlMode });
    const nameIndex = header(tokens, loaded.object);
    if (nameIndex === null) return undefined;
    if (!member) return span(tokens[nameIndex]);
    if (member.kind !== 'column') return undefined;
    if (loaded.object.kind === 'table') return tableColumn(tokens, nameIndex, member.name);
    if (loaded.object.kind === 'view') return viewColumn(tokens, nameIndex, member.name);
  } catch { /* An unsupported or incomplete source does not prove a target. */ }
  return undefined;
}

module.exports = { ddlDefinitionLocation };
