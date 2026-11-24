'use strict';

const MAX_SQL_BYTES = 128 * 1024;
const FORBIDDEN_FUNCTIONS = new Set(['LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'MASTER_POS_WAIT', 'SOURCE_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET']);
const READ_FORBIDDEN = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'SET', 'RESET', 'CALL', 'DO', 'LOAD', 'INSTALL', 'UNINSTALL', 'LOCK', 'UNLOCK', 'FLUSH', 'KILL', 'HANDLER', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'START', 'BEGIN', 'REPAIR', 'OPTIMIZE', 'INTO', 'OUTFILE', 'DUMPFILE', ...FORBIDDEN_FUNCTIONS]);
const WRITE_STARTS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'SET']);
const WRITE_FORBIDDEN = new Set(['OUTFILE', 'DUMPFILE', 'LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'MASTER_POS_WAIT', 'SOURCE_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET']);
const TRANSACTION_STARTS = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);

function policyError(message, readOnly = true) {
  return Object.assign(new Error(message), { code: readOnly ? 'ROCKETBRAIN_READ_ONLY' : 'ROCKETBRAIN_SQL_POLICY' });
}

/**
 * A bounded lexer for the execution policy, not a SQL parser/semantic analyzer.
 * Ambiguous SQL_MODE escaping and executable comments are intentionally refused.
 * The server's READ ONLY setting remains the read-only enforcement boundary.
 */
function tokenize(sql, readOnly = true, { sqlMode, allowOptimizerHints = true } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw policyError('Enter a SQL statement.', readOnly);
  if (sql.includes('\0') || Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) throw policyError('SQL must not contain NUL and must be at most 128 KiB.', readOnly);
  const tokens = [];
  const knownMode=Array.isArray(sqlMode),modes=new Set(knownMode?sqlMode:[]),backslashEscapes=knownMode&&!modes.has('NO_BACKSLASH_ESCAPES');
  let ended = false;
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s|\uFEFF/.test(c)) { i++; continue; }
    if (c === '#' || (sql.startsWith('--', i) && /\s/.test(sql[i + 2] || ' '))) {
      const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith('/*', i)) {
      if (/^\/\*(?:!|[mM]!)/.test(sql.slice(i))) throw policyError('Executable SQL comments are not supported.', readOnly);
      if (!allowOptimizerHints && sql.startsWith('/*+', i)) throw policyError('Remove optimizer hints before measuring this read-only SQL.', readOnly);
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw policyError('The SQL comment is not closed.', readOnly);
      i = end + 2; continue;
    }
    if (ended) throw policyError('Run one statement at a time.', readOnly);
    if (c === ';') { ended = true; i++; continue; }
    if (c === "'" || c === '"' || c === String.fromCharCode(96)) {
      const start = i, quote = c;
      const stringQuote=quote==="'"||(quote==='"'&&knownMode&&!modes.has('ANSI_QUOTES'));
      let value = '', closed = false;
      for (i++; i < sql.length;) {
        if (sql[i] === '\\') {
          if(!knownMode||!stringQuote)throw policyError('Use doubled quotes instead of ambiguous backslash escapes.', readOnly);
          if(backslashEscapes){if(i+1>=sql.length)throw policyError('The SQL quote is not closed.',readOnly);value+=sql[i]+sql[i+1];i+=2;continue;}
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += quote; i += 2; continue; }
          i++; closed = true; break;
        }
        value += sql[i++];
      }
      if (!closed) throw policyError('The SQL quote is not closed.', readOnly);
      tokens.push({ kind: stringQuote ? 'string' : 'identifier', value, upper: value.toUpperCase(), start, end: i });
      continue;
    }
    if (c === '@') {
      const start = i++;
      let system = false;
      if (sql[i] === '@') { system = true; i++; }
      while (i < sql.length && /[A-Za-z0-9_$.]/.test(sql[i])) i++;
      tokens.push({ kind: 'variable', value: sql.slice(start, i), system, start, end: i });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      const value = sql.slice(start, i);
      tokens.push({ kind: 'word', value, upper: value.toUpperCase(), start, end: i });
      continue;
    }
    tokens.push({ kind: 'symbol', value: c, start: i, end: ++i });
  }
  return tokens;
}

function validateQuery(sql, { readOnly = true, sqlMode, allowOptimizerHints = true } = {}) {
  const tokens = tokenize(sql, readOnly,{sqlMode,allowOptimizerHints});
  const words = tokens.filter(t => t.kind === 'word').map(t => t.upper);
  const first = tokens[0]?.kind === 'word' ? tokens[0].upper : '';
  if (TRANSACTION_STARTS.has(first)) throw policyError('Use the transaction controls to begin, commit or roll back a console transaction.', readOnly);
  for (const token of tokens) {
    if ((token.kind === 'word' || token.kind === 'identifier') && FORBIDDEN_FUNCTIONS.has(token.upper)) throw policyError('This server-side file or lock operation is unavailable.', readOnly);
  }
  if (readOnly) {
    if (!['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'].includes(first)) throw policyError('This console is read-only. Enable read/write mode explicitly before changing data.');
    for (const word of words) if (READ_FORBIDDEN.has(word)) throw policyError('The ' + word + ' operation is unavailable in read-only mode.');
    if (tokens.some(t => t.kind === 'variable' && !t.system) || tokens.some((t,i)=>t.value===':'&&tokens[i+1]?.value==='=')) throw policyError('User variables and assignments require read/write mode.');
    if (words.includes('FOR') && words.includes('SHARE')) throw policyError('Locking reads require read/write mode.');
    if (first === 'EXPLAIN' && !words.includes('SELECT') && !words.includes('WITH')) throw policyError('Use EXPLAIN with a SELECT query in read-only mode.');
  } else {
    if (!WRITE_STARTS.has(first)) throw policyError('This statement is not supported. Administrative commands are unavailable.', false);
    for (const word of words) if (WRITE_FORBIDDEN.has(word)) throw policyError('Server-side file and lock operations are unavailable.', false);
    // Database structure and data changes are explicit in read/write mode;
    // account, server, plugin and arbitrary dynamic-SQL administration are not.
    if (['CREATE', 'ALTER', 'DROP'].includes(first)) {
      const type = words[1] === 'TEMPORARY' ? words[2] : words[1];
      if (!['TABLE', 'INDEX', 'VIEW'].includes(type)) throw policyError('Only table, index and view DDL is currently supported.', false);
    }
    if (first === 'SET') {
      if (tokens[1]?.kind !== 'variable' || tokens[1].system || tokens.some(t => t.kind === 'variable' && t.system) ||
          words.some(w => ['GLOBAL', 'SESSION', 'PERSIST', 'PASSWORD', 'TRANSACTION', 'AUTOCOMMIT', 'SQL_MODE'].includes(w))) {
        throw policyError('Use session controls for transaction settings. SQL SET is limited to user variables.', false);
      }
      let depth = 0;
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i].value === '(') depth++;
        if (tokens[i].value === ')') depth--;
        if (depth === 0 && tokens[i].value === ',' && (tokens[i + 1]?.kind !== 'variable' || tokens[i + 1].system)) {
          throw policyError('Every SQL SET target must be a user variable. Use the session controls for server settings.', false);
        }
      }
    }
  }
  const mayWrite = !['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first) || words.some(w => ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(w));
  return { sql, first, mayWrite, ddl: ['CREATE', 'ALTER', 'DROP', 'TRUNCATE'].includes(first) };
}

function validateReadQuery(sql) { validateQuery(sql); return sql; }

function parameters(values = []) {
  if (!Array.isArray(values) || values.length > 10000) throw new Error('Bound SQL values must be an array of at most 10000 parameters.');
  return values.map(value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || Buffer.isBuffer(value) || value instanceof Date) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return value.toString();
    throw new Error('SQL parameters support null, text, finite numbers, booleans, dates and binary buffers.');
  });
}

module.exports = { validateQuery, validateReadQuery, tokenize, parameters };
