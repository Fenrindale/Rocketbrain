'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sqlFieldLists } = require('../src/db/sql-field-lists');

const column = (name, ordinal, extra = '') => ({ name, ordinal, type:'varchar(64)', extra });
const catalog = {
  database:'fixture', coverage:{ tables:'loaded', columns:'loaded' },
  tables:[{ name:'people', kind:'table', columns:[column('id', 1, 'auto_increment'), column('name', 2),
    column('nickname', 3), column('name_folded', 4, 'STORED GENERATED')] },
  { name:'schools', kind:'table', columns:[column('name', 1)] }]
};
function complete(source, available = catalog, options = {}) {
  const offset = source.indexOf('|');
  return sqlFieldLists(source.replace('|', ''), offset, available, options);
}
const text = source => complete(source)[0]?.insertText;

test('SELECT list completion orders qualified fields from visible relations and statement scope', () => {
  assert.equal(text('SELECT | FROM people AS p JOIN schools AS s ON p.name=s.name'),
    '`p`.`id`, `p`.`name`, `p`.`nickname`, `p`.`name_folded`, `s`.`name`');
  assert.equal(text('SELECT 1; SELECT DISTINCT |FROM schools'), '`schools`.`name` ');
  assert.equal(text('SELECT | FROM no_such_table'), undefined);
  assert.equal(text('SELECT p.name, | FROM people p'), undefined);
});

test('INSERT list completion uses observed writable ordinals in the selected schema', () => {
  assert.equal(text('INSERT INTO fixture.people (|) VALUES (?, ?)'), '`name`, `nickname`');
  assert.equal(text('INSERT IGNORE INTO people |VALUES (?, ?)'), '(`name`, `nickname`) ');
  assert.equal(text('INSERT INTO other.people (|) VALUES (?, ?)'), undefined);
  assert.equal(text('INSERT INTO people (name, |) VALUES (?, ?)'), undefined);
  assert.deepEqual(complete('INSERT INTO people (|) VALUES (?, ?)', { ...catalog, coverage:{tables:'loaded'} }), []);
});

test('GROUP BY list completion takes direct projected columns and leaves aggregate arguments alone', () => {
  assert.equal(text('SELECT p.name AS label, p.nickname, COUNT(*) FROM people p GROUP BY |'), '`p`.`name`, `p`.`nickname`');
  assert.equal(text('SELECT p.name, UPPER(p.nickname), COUNT(*) FROM people p GROUP BY |'), undefined);
  assert.equal(text('SELECT p.name, COUNT(*) FROM people p ORDER BY |'), undefined);
  assert.equal(text('SELECT COUNT(*) FROM people GROUP BY |'), undefined);
  assert.equal(text("SELECT '| FROM people'"), undefined);
});
