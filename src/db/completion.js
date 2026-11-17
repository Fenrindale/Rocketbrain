'use strict';

const { tokenize } = require('./sql-policy');
const QUOTE = String.fromCharCode(96);
const RESERVED = new Set(['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'ON', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'SET', 'VALUES', 'FOR']);
const quote = name => QUOTE + name.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;

/**
 * Scope-aware CTE/derived/correlated completion, with the older catalog fallback
 * for incomplete/unsupported statements. It never executes SQL.
 */
function completeSql(text, offset, schema, options = {}) {
  const tables = Array.isArray(schema) ? schema : [...(schema?.tables || []), ...(schema?.views || [])];
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const match = /(?:([\p{L}_$][\p{L}\p{N}_$]*)\.)?([\p{L}\p{N}_$]*)$/u.exec(before);
  if (!match) return [];
  const qualifier = match[1], prefix = match[2].toLocaleLowerCase();
  let tokens;
  try { tokens = tokenize(text); } catch { return []; }
  if (tokens.some(token => token.kind === 'string' && offset > token.start && offset < token.end)) return [];
  const prior = tokens.filter(token => token.end <= offset).at(-1);
  if (prior && /^\s*(?:#|--\s|\/\*)/.test(before.slice(prior.end))) return [];
  const semantic=require('./sql-analysis');
  const scoped=semantic.completionsAt(semantic.analyzeSql(text,schema,options),offset);
  if(scoped.length)return scoped;
  const aliases = new Map(tables.map(table => [table.name, table]));
  let depth = 0, flat = true;
  for (const token of tokens) {
    if (token.value === '(') depth++;
    if (token.value === ')') depth--;
    if (depth && token.upper === 'SELECT' || token.upper === 'WITH') flat = false;
  }
  if (flat) {
    for (let i = 0; i < tokens.length; i++) {
      if (!['FROM', 'JOIN'].includes(tokens[i].upper)) continue;
      const nameToken = tokens[i + 1];
      if (!nameToken || !['word', 'identifier'].includes(nameToken.kind)) continue;
      const table = tables.find(item => item.name === nameToken.value);
      if (!table) continue;
      let alias = tokens[i + 2];
      if (alias?.upper === 'AS') alias = tokens[i + 3];
      if (alias && ['word', 'identifier'].includes(alias.kind) && !RESERVED.has(alias.upper)) aliases.set(alias.value, table);
    }
  }
  const selected = qualifier ? (flat && aliases.has(qualifier) ? [aliases.get(qualifier)] : []) : tables;
  const items = [];
  if (!qualifier) for (const table of tables) {
    if (table.name.toLocaleLowerCase().startsWith(prefix)) items.push({ label: table.name, kind: 'table', detail: (table.kind || 'table') + ' · current database metadata', insertText: quote(table.name) });
  }
  for (const table of selected) for (const column of table.columns || []) {
    if (column.name.toLocaleLowerCase().startsWith(prefix)) items.push({ label: column.name, kind: 'column', detail: table.name + ' · ' + column.type, insertText: quote(column.name), table: table.name });
  }
  return items;
}
module.exports = { completeSql };
