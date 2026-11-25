'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const { callCompletions, callSignature } = require('../src/db/sql-call-completion');
const { verifyActualSqlCallCompletion } = require('./sql-call-completion-host');

const options = { dialect: 'mysql', serverVersion: '8.4.13', sqlMode: [] };
test('catalog functions require observed vendor and version and withhold unsupported modes', () => {
  const text = 'SELECT jv';
  const labels = observed => callCompletions(text, text.length, observed).filter(item => item.label === 'JSON_VALUE');
  assert.equal(labels(options).length, 2);
  assert.equal(labels({ ...options, serverVersion: '8.0.20' }).length, 0);
  assert.equal(labels({ ...options, serverVersion: '11.4.8-MariaDB', dialect: 'mariadb' }).length, 1);
  assert.equal(labels({ ...options, sqlMode: ['ORACLE'] }).length, 0);
  assert.equal(labels({ ...options, sqlMode: undefined }).length, 0);
  assert.equal(labels({ ...options, serverVersion: '11.4.8-MariaDB' }).length, 0);
});

test('signature help respects nesting, SQL mode, variadic path/value position and unsupported input', () => {
  const get = (raw, observed = options) => callSignature(raw.replace('|', ''), raw.indexOf('|'), observed);
  assert.equal(get("SELECT JSON_SET(doc, '$.a', 1, |'"), undefined);
  assert.equal(get("SELECT JSON_SET(doc, '$.a', 1, |'$.b', 2)")[0].active, 1);
  assert.equal(get("SELECT JSON_SET(doc, '$.a', 1, '$.b', |2)")[0].active, 2);
  assert.equal(get('SELECT COUNT (|)'), undefined);
  assert.equal(get('SELECT COUNT (|)', { ...options, sqlMode: ['IGNORE_SPACE'] })[0].active, 0);
  assert.equal(get('SELECT app.COUNT(|)'), undefined);
  assert.equal(get("SELECT REGEXP_REPLACE('literal |string', 'p', 'r')"), undefined);
  assert.equal(get('SELECT CAST(10 AS |')[0].active, 1);
  assert.equal(get("SELECT SUBSTRING('abc' FROM 1 FOR |2)")[0].active, 2);
});

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
test('actual Spring two-vendor fixture executes completions and checks observed function syntax',
  { skip: !fixture && 'Run an owned Spring/MySQL or MariaDB fixture.', timeout: 90000 }, async () => {
    console.log(JSON.stringify(await verifyActualSqlCallCompletion(JSON.parse(await fs.readFile(fixture, 'utf8')))));
  });
