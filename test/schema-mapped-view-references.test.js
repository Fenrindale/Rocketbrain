'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {assertMappedViewReferences} = require('../src/db/schema-mapped-view-references');

const schema = 'active_db';
const fields = (...names) => names.map(name => ({name}));
const view = (name, definition, database = schema) => ({schema: database, name, definition, sqlMode: 'STRICT_TRANS_TABLES'});
const table = (name, columns, database = schema) => ({schema: database, name, columns: fields(...columns)});
const beforeMain = view('v_main', "SELECT `item`.`id`, `item`.`note` AS `note` FROM `active_db`.`articles` `item` WHERE `item`.`note` LIKE 'ALPha%'");
const afterMain = view('v_main', "SELECT `item`.`id`, `item`.`headline` AS `note` FROM `articles` AS `item` WHERE `item`.`headline` LIKE 'ALPha%'");
const nested = view('v_nested', 'SELECT `note` AS `note` FROM `active_db`.`v_main`');
const safe = view('v_stable', "SELECT `item`.`id` AS `note`, 'headline' AS `literal_text` FROM `articles` `item` ORDER BY `note`");
const fixture = (before, after, selected = [], extraTables = []) => ({
  plan: {
    formatVersion: 8,
    database: schema,
    currentServer: {tableNameCaseSensitive: true},
    steps: [{table: 'articles', before: {columns: fields('id', 'note', 'retained')},
      after: {columns: fields('id', 'headline', 'retained')}}],
    columnMappings: {articles: [{from: 'note', to: 'headline'}]},
    selectedViews: selected.map(name => ({before: before.find(item => item.name === name), after: after.find(item => item.name === name)}))
  },
  bundle: {before: {views: before}, after: {views: after}, tableSnapshots: extraTables}
});
const validate = value => assertMappedViewReferences(value.plan, value.bundle);
const code = 'ROCKETBRAIN_REBUILD_COLUMN_MAPPING';
const omitted = /Select each dependent view/u;
const obsolete = /replace mapped source references/u;
const unresolved = /could not be resolved exactly/u;

test('binds physical aliases and leaves output aliases, string literals, and chained consumers alone', () => {
  const input = fixture([beforeMain, nested, safe], [afterMain, nested, safe], ['v_main']);
  const previous = structuredClone(input);
  assert.doesNotThrow(() => validate(input));
  assert.deepEqual(input, previous);
});

test('requires every directly affected view to be chosen even if selection omits its definition change', () => {
  const extra = view('v_unselected', 'SELECT `active_db`.`articles`.`note` AS `value` FROM `active_db`.`articles`');
  assert.throws(() => validate(fixture([beforeMain, extra, nested], [afterMain, extra, nested], ['v_main'])),
    {code, message: omitted});
  assert.throws(() => validate(fixture([beforeMain], [afterMain])), {code, message: omitted});
});

test('checks actual destination use and refuses the obsolete source in either a column or predicate', () => {
  const removed = view('v_main', 'SELECT `item`.`id` AS `note` FROM `articles` AS `item`');
  const stale = view('v_main', afterMain.definition.replace('WHERE `item`.`headline`', 'WHERE `item`.`note`'));
  const staleBare = view('v_main', afterMain.definition.replace('WHERE `item`.`headline`', 'WHERE `note`'));
  for (const target of [removed, stale, staleBare]) {
    assert.throws(() => validate(fixture([beforeMain], [target], ['v_main'])), {code, message: obsolete});
  }
  const order = [' ORDER BY `note`', ' ORDER BY `note` DESC, `id`'];
  for (const suffix of order) {
    assert.doesNotThrow(() => validate(fixture([beforeMain], [{...afterMain, definition: afterMain.definition + suffix}], ['v_main'])));
  }
});

test('uses phase-local column metadata for bare names and refuses unresolved join references', () => {
  const from = ' FROM `articles` a JOIN `other` b ON a.id=b.id';
  const original = view('v_main', 'SELECT `note` AS `display_value`' + from);
  const modified = view('v_main', 'SELECT `headline` AS `display_value`' + from);
  assert.doesNotThrow(() => validate(fixture([original], [modified], ['v_main'], [table('other', ['id', 'label'])])));
  for (const unrelated of [[], [table('other', ['id', 'note'])], [table('other', ['id', 'headline'])]]) {
    assert.throws(() => validate(fixture([original], [modified], ['v_main'], unrelated)), {code, message: unresolved});
  }
});

test('binds exact qualified relation ownership when another database exposes the same table and column names', () => {
  const from = ' FROM `active_db`.`articles` JOIN `remote_db`.`articles` ON `active_db`.`articles`.`id`=`remote_db`.`articles`.`id`';
  const otherTable = table('articles', ['id', 'note', 'headline'], 'remote_db');
  const original = view('v_main', 'SELECT `active_db`.`articles`.`note` AS `base`, `remote_db`.`articles`.`note` AS `peer`' + from);
  const proper = view('v_main', original.definition.replace('`active_db`.`articles`.`note`', '`active_db`.`articles`.`headline`'));
  const wrong = view('v_main', original.definition.replace('`active_db`.`articles`.`note`', '`remote_db`.`articles`.`headline`'));
  const unchanged = view('v_unaffected', 'SELECT `remote_db`.`articles`.`note` AS `note`' + from);
  assert.doesNotThrow(() => validate(fixture([original, unchanged], [proper, unchanged], ['v_main'], [otherTable])));
  assert.throws(() => validate(fixture([original], [wrong], ['v_main'], [otherTable])), {code, message: obsolete});
  const ambiguous = view('v_main', 'SELECT `articles`.`note` AS `display_value`' + from);
  assert.throws(() => validate(fixture([ambiguous], [proper], ['v_main'], [otherTable])), {code, message: unresolved});
});

test('recognizes exact relation names when aliases or column names are spelled differently', () => {
  const explicit = view('v_main', 'SELECT `Articles`.`Note` AS `display_value` FROM `Articles`');
  const next = view('v_main', 'SELECT `Articles`.`Headline` AS `display_value` FROM `Articles`');
  const caseInsensitive = fixture([explicit], [next], ['v_main']);
  caseInsensitive.plan.currentServer.tableNameCaseSensitive = false;
  assert.doesNotThrow(() => validate(caseInsensitive));
  const unrecognized = view('v_main', 'SELECT `missing`.`headline` AS `note` FROM `articles` AS `item`');
  assert.throws(() => validate(fixture([beforeMain], [unrecognized], ['v_main'])), {code, message: unresolved});
});

test('refuses implicit wildcard/NATURAL/USING bindings while admitting an ordinary unaffected count', () => {
  const unproven = [
    'SELECT * FROM articles', 'SELECT ALL * FROM articles', 'SELECT item.* FROM articles item',
    'SELECT a.id FROM articles a JOIN other b USING (note)',
    'SELECT a.id FROM articles a NATURAL JOIN other b'
  ];
  for (const sql of unproven) {
    const dependent = view('v_unselected', sql);
    assert.throws(() => validate(fixture([dependent], [dependent], [], [table('other', ['id', 'note'])])),
      {code, message: unresolved}, sql);
  }
  const count = view('v_count', 'SELECT COUNT(*) AS `note`, a.id * 2 AS `double_id` FROM articles a GROUP BY a.id');
  assert.doesNotThrow(() => validate(fixture([count], [count])));
});
