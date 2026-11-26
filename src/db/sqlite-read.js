'use strict';

function skipTrivia(sql, allowSemicolons = false) {
  let offset = 0;
  while (offset < sql.length) {
    if (/\s|\uFEFF/u.test(sql[offset]) || allowSemicolons && sql[offset] === ';') offset++;
    else if (sql.startsWith('--', offset)) {
      const end = sql.indexOf('\n', offset + 2);
      offset = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', offset)) {
      const end = sql.indexOf('*/', offset + 2);
      offset = end === -1 ? sql.length : end + 2;
    } else break;
  }
  return sql.slice(offset);
}

function prepareOne(db, sql, message) {
  const statement = db.prepare(sql);
  const source = statement.getSQL();
  if (!sql.startsWith(source) || skipTrivia(sql.slice(source.length), true).length) {
    statement.free();
    throw Error(message);
  }
  return statement;
}

// Only the outer read verb of a WITH query counts. SQLite still parses the whole statement.
function sqliteReadQuery(sql) {
  const source = skipTrivia(sql);
  const first = /^[A-Za-z]+/u.exec(source)?.[0]?.toUpperCase();
  if (first === 'SELECT' || first === 'VALUES') return;
  if (first === 'WITH') {
    let depth = 0, quote = '', completedCTE = false;
    for (let i = 4; i < source.length; i++) {
      const here = source[i], next = source[i + 1];
      if (quote) {
        if (here === quote) {
          if (next === quote && quote !== ']') i++;
          else quote = '';
        }
        continue;
      }
      if (here === '-' && next === '-' || here === '/' && next === '*') {
        const end = here === '-' ? source.indexOf('\n', i + 2) : source.indexOf('*/', i + 2);
        if (end < 0) break;
        i = here === '-' ? end : end + 1;
        continue;
      }
      if (here === "'" || here === '"' || here === '`' || here === '[') quote = here === '[' ? ']' : here;
      else if (here === '(') depth++;
      else if (here === ')' && --depth === 0) completedCTE = true;
      else if (completedCTE && depth === 0 && /[A-Za-z_]/u.test(here)) {
        const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(source.slice(i))[0];
        const keyword = word.toUpperCase();
        if (keyword === 'SELECT' || keyword === 'VALUES') return;
        if (['DELETE', 'INSERT', 'UPDATE', 'REPLACE'].includes(keyword)) break;
        i += word.length - 1;
      }
    }
  }
  throw Error('Review one read-only SQLite SELECT, VALUES, or WITH query.');
}

module.exports = { skipTrivia, prepareOne, sqliteReadQuery };
