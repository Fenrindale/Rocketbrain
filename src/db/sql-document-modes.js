'use strict';

const lexicalModes = ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES'];
const contextCommands = new Set(['CALL', 'DELIMITER', 'DO', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'USE', 'BEGIN']);
const bundledModes = new Set(['ANSI', 'ORACLE', 'TRADITIONAL', 'DB2', 'MSSQL', 'MAXDB', 'POSTGRESQL', 'MYSQL323', 'MYSQL40']);
const word = token => token?.kind === 'word' ? token.upper : '';

function literalModeChange(text, tokens, admitted) {
  if (tokens.length !== 5 || word(tokens[0]) !== 'SET' || !['SESSION', 'LOCAL'].includes(word(tokens[1])) ||
      word(tokens[2]) !== 'SQL_MODE' || tokens[3].value !== '=' || tokens[4].kind !== 'string') return;
  const raw = text.slice(tokens[4].start, tokens[4].end);
  if (!/^'(?:[A-Za-z0-9_]+(?:,[A-Za-z0-9_]+)*)?'$/u.test(raw)) return;
  const names = raw.slice(1, -1).toUpperCase().split(',').filter(Boolean);
  if (!names.every(name => admitted.has(name) && !bundledModes.has(name))) return;
  return [...new Set(names)].sort();
}

function documentModeTracker(text, initialMode, unknown, statements) {
  const admitted = new Set([...initialMode.map(mode => String(mode).toUpperCase()), ...lexicalModes]);
  let start = 0, tokenStart = 0, issueStart = 0, projected, blocked = false;
  return function endStatement(tokens, end, terminated) {
    const count = tokens.length - Number(terminated);
    const current = tokens.slice(tokenStart, count);
    const head = word(current[0]);
    const uncertain = blocked || unknown.length !== issueStart || contextCommands.has(head) ||
      (head === 'CREATE' && current.some(token => ['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT', 'PACKAGE'].includes(word(token))));
    const transition = !uncertain && terminated ? literalModeChange(text, current, admitted) : undefined;
    if (text.slice(start, end).trim()) {
      statements.push({ start, end, ...(projected && !blocked && { sqlMode: projected }),
        ...(transition && { modeTransition: transition, modeStart: current[0].start }) });
    }
    if (transition) projected = transition;
    if (uncertain || head === 'SET' && !transition) blocked = true;
    start = end;
    tokenStart = tokens.length;
    issueStart = unknown.length;
    return transition;
  };
}

module.exports = { documentModeTracker };
