'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { postgresqlRoute, postgresJdbcUrl, validatePostgreSqlQuery } = require('../src/db/postgresql-jdbc');

const route = { host: '127.0.0.1', port: 5432, database: 'catalog', schema: 'analytics', tls: 'loopback' };

test('PostgreSQL profile constructs one schema-scoped URL and rejects remote insecure routes', () => {
  assert.match(postgresJdbcUrl(route), /^jdbc:postgresql:\/\/127\.0\.0\.1:5432\/catalog\?currentSchema=analytics&sslmode=disable&/);
  assert.match(postgresJdbcUrl({ ...route, host: '::1' }), /\/\/\[::1\]:5432/);
  const cert = path.resolve('root CA.pem');
  const verified = postgresJdbcUrl({ ...route, host: 'postgres.example.test', tls: 'verify-full', ca: cert });
  assert.match(verified, /sslmode=verify-full/);
  assert.equal(new URLSearchParams(verified.split('?')[1]).get('sslrootcert'), cert);
  assert.throws(() => postgresqlRoute({ ...route, host: 'localhost' }), /verified PostgreSQL TLS/);
  assert.throws(() => postgresqlRoute({ ...route, schema: 'analytics,private' }), /schema name/);
});

test('PostgreSQL read query scanning understands native literal boundaries, comments, casts, and JSON operators', () => {
  const sql = "/* tail /* nested */ comment */ WITH selected AS (SELECT '{\"name\":1}'::jsonb AS j) SELECT j #>> '{name}', j ? 'name', $한글$semi;DELETE$한글$ FROM selected; -- trailing";
  assert.equal(validatePostgreSqlQuery(sql), sql);
  assert.doesNotThrow(() => validatePostgreSqlQuery("SELECT E'quoted\\\';still a string', 'normal\\', \"delete\" FROM sample"));
  assert.throws(() => validatePostgreSqlQuery('SELECT $$closed$$; VALUES (1)'), /one PostgreSQL statement/);
  assert.throws(() => validatePostgreSqlQuery('SELECT 1 AS 이름$x$; SELECT 2'), /one PostgreSQL statement/);
  assert.throws(() => validatePostgreSqlQuery('SELECT $tag$open'), /dollar-quoted/);
  assert.throws(() => validatePostgreSqlQuery('SELECT /* open'), /block comment/);
  for (const source of ["SELECT \"set_config\"/* test */('timezone','on',FALSE)", 'SELECT id FROM events FOR KEY SHARE',
    'WITH removed AS (DELETE FROM events RETURNING 1) SELECT * FROM removed', "SELECT pg_read_file('fixture')", 'SELECT 1; \\q']) {
    assert.throws(() => validatePostgreSqlQuery(source), { code: 'ROCKETBRAIN_POSTGRESQL' });
  }
});
