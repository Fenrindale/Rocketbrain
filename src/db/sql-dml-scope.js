'use strict';

const commands = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'VALUES', 'TABLE']);
const mutations = new Set(['UPDATE', 'DELETE']);

function topLevelWords(tokens) {
  const words = [];
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'symbol' && token.value === '(') depth++;
    else if (token.kind === 'symbol' && token.value === ')') depth--;
    else if (!depth && token.kind === 'word' && tokens[index - 1]?.value !== ':') words.push(token);
    if (depth < 0) return [];
  }
  return depth === 0 ? words : [];
}

function inspectDmlTokens(tokens) {
  const words = topLevelWords(tokens);
  const first = words[0];
  const command = first?.upper === 'WITH' ? words.slice(1).find(token => commands.has(token.upper)) : first;
  if (!command || !mutations.has(command.upper)) return;
  const clauses = words.filter(token => token.start > command.start);
  return {
    command:command.upper,
    start:command.start,
    end:command.end,
    hasWhere:clauses.some(token => token.upper === 'WHERE'),
    hasLimit:clauses.some(token => token.upper === 'LIMIT')
  };
}

function inspectDmlScope(sql, sqlMode) {
  return inspectDmlTokens(require('./sql-policy').tokenize(sql, false, { sqlMode }));
}

module.exports = { inspectDmlScope, inspectDmlTokens };
