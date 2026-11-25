'use strict';

const path = require('node:path');
const net = require('node:net');
const { dnsName } = require('./connection-security');

const maxSql = 128 * 1024;
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_POSTGRESQL' });
const identifier = value => typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value);
const denied = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'SET',
  'RESET', 'COPY', 'GRANT', 'REVOKE', 'CALL', 'DO', 'LOCK', 'VACUUM', 'REINDEX', 'CLUSTER', 'DISCARD', 'PREPARE',
  'EXECUTE', 'ANALYZE', 'NOTIFY', 'LISTEN', 'UNLISTEN', 'REFRESH', 'BEGIN', 'COMMIT', 'ROLLBACK']);
const functions = new Set(['NEXTVAL', 'SETVAL', 'SET_CONFIG', 'LO_IMPORT', 'LO_EXPORT', 'LO_CREATE', 'LO_UNLINK', 'LO_PUT', 'DBLINK']);
const serverControl = /^(?:PG_(?:ADVISORY_|TRY_ADVISORY_|READ_|WRITE_|LS_|STAT_FILE|RELOAD_CONF|ROTATE_LOGFILE|TERMINATE_BACKEND|CANCEL_BACKEND|CREATE_REPLICATION_SLOT|DROP_REPLICATION_SLOT)|DBLINK_)/;
const words = new Set(['SELECT', 'WITH', 'SHOW', 'VALUES', 'EXPLAIN', 'TABLE']);

function postgresqlRoute(value) {
  const { host, port, database, schema, tls, ca } = value ?? {};
  if (typeof host !== 'string' || !net.isIP(host) && !dnsName(host) ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !identifier(database) || !identifier(schema)) {
    throw fail('Enter a PostgreSQL host, TCP port, database name and schema name.');
  }
  if (tls === 'loopback' && ['127.0.0.1', '::1'].includes(host) && !ca) return { host, port, database, schema, tls };
  if (tls === 'verify-full' && typeof ca === 'string' && path.isAbsolute(ca) && ca.length <= 4096 && !/^\\\\/.test(ca) && !/[\0\r\n]/.test(ca)) {
    return { host, port, database, schema, tls, ca };
  }
  throw fail('Use verified PostgreSQL TLS with a local CA file, or choose an exact numeric loopback endpoint.');
}

function postgresJdbcUrl(value) {
  const route = postgresqlRoute(value);
  const host = net.isIP(route.host) === 6 ? '[' + route.host + ']' : route.host;
  const options = new URLSearchParams({ currentSchema: route.schema, sslmode: route.tls === 'loopback' ? 'disable' : 'verify-full',
    gssEncMode: 'disable', connectTimeout: '5', socketTimeout: '10', readOnlyMode: 'transaction' });
  if (route.ca) options.set('sslrootcert', route.ca);
  return `jdbc:postgresql://${host}:${route.port}/${route.database}?${options}`;
}

const startsIdentifier = character => Boolean(character && /[A-Za-z_\u0080-\uffff]/.test(character));
const identifierPart = character => Boolean(character && /[A-Za-z0-9_$\u0080-\uffff]/.test(character));

function quoted(sql, offset) {
  const quote = sql[offset];
  const escape = quote === "'" && /e/i.test(sql[offset - 1] || '') && !identifierPart(sql[offset - 2]);
  let value = '', cursor = offset + 1;
  while (cursor < sql.length) {
    if (escape && sql[cursor] === '\\') { cursor += 2; continue; }
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] !== quote) return { end: cursor + 1, value };
      cursor++;
    }
    if (quote === '"') value += sql[cursor];
    cursor++;
  }
  throw fail('Complete the PostgreSQL quoted literal or identifier before running it.');
}

function skipComment(sql, offset) {
  let nesting = 1, cursor = offset + 2;
  while (cursor < sql.length) {
    if (sql.startsWith('/*', cursor)) { nesting++; cursor += 2; }
    else if (sql.startsWith('*/', cursor)) {
      cursor += 2;
      if (!--nesting) return cursor;
    } else cursor++;
    if (nesting > 32) throw fail('The PostgreSQL block comment is nested too deeply.');
  }
  throw fail('Close the PostgreSQL block comment before running the query.');
}

function rejectControl(token, isQuoted = false) {
  if (!isQuoted && denied.has(token) || functions.has(token) || serverControl.test(token)) {
    throw fail('The PostgreSQL query contains a write, control or server resource operation.');
  }
}

function validatePostgreSqlQuery(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.includes('\0') || Buffer.byteLength(sql) > maxSql) {
    throw fail('Enter a PostgreSQL query of at most 128 KiB.');
  }
  let first, ended = false, previousBare;
  for (let cursor = 0; cursor < sql.length;) {
    const character = sql[cursor];
    if (/[ \t\r\n\f\v]/.test(character)) { cursor++; continue; }
    if (sql.startsWith('--', cursor)) {
      while (cursor < sql.length && sql[cursor] !== '\n' && sql[cursor] !== '\r') cursor++;
      continue;
    }
    if (sql.startsWith('/*', cursor)) { cursor = skipComment(sql, cursor); continue; }
    if (ended) throw fail('Run one PostgreSQL statement at a time.');
    if (character === ';') { ended = true; cursor++; continue; }
    if (!first && !startsIdentifier(character)) throw fail('Run a supported read-only PostgreSQL statement.');
    if (character === "'" || character === '"') {
      if (/(?:^|[^\w$])u&$/i.test(sql.slice(Math.max(0, cursor - 4), cursor))) throw fail('Use ordinary quoted PostgreSQL syntax in this query.');
      const item = quoted(sql, cursor);
      if (character === '"') rejectControl(item.value.toUpperCase(), true);
      cursor = item.end;
      continue;
    }
    if (character === '$') {
      const delimiter = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]{0,62})?\$/.exec(sql.slice(cursor, cursor + 66))?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, cursor + delimiter.length);
        if (end === -1) throw fail('Close the PostgreSQL dollar-quoted string before running the query.');
        cursor = end + delimiter.length;
        continue;
      }
      if (/^\$[0-9]/.test(sql.slice(cursor, cursor + 2))) throw fail('Run PostgreSQL queries with literal values in this console.');
    }
    if (startsIdentifier(character)) {
      const start = cursor++;
      while (identifierPart(sql[cursor])) cursor++;
      const token = sql.slice(start, cursor).toUpperCase();
      if (!first) { first = token; if (!words.has(first)) throw fail('Run a supported read-only PostgreSQL statement.'); }
      if (previousBare === 'FOR' && ['SHARE', 'KEY', 'NO'].includes(token)) throw fail('Locking reads are unavailable in the PostgreSQL console.');
      rejectControl(token);
      previousBare = token;
      continue;
    }
    if (character === '`' || character === '\\') throw fail('Use PostgreSQL SQL without shell metacommands or backtick quoting.');
    cursor++;
  }
  if (!first) throw fail('Run a supported read-only PostgreSQL statement.');
  return sql;
}

module.exports = { postgresqlRoute, postgresJdbcUrl, validatePostgreSqlQuery };
