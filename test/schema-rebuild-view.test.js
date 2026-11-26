'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseSnapshotView, assertSelectedViewPair, viewBodyKey} = require('../src/db/schema-rebuild-view');
const {scopedViewBodyKey} = require('../src/db/schema-dependency-graph');

const header = 'CREATE ALGORITHM=MERGE DEFINER=`audit_operator`@`localhost` SQL SECURITY INVOKER VIEW ';
const originalBody = "select `source_rows`.`id` AS `id`,`source_rows`.`score` AS `score` from `source_rows` where (`source_rows`.`note` like 'alpha%')";
const targetBody = originalBody.replace("'alpha%'", "'ALPha%'");
const schema = (dialect = 'mysql', database = 'active_fixture') => ({
  database, server: {database, dialect, currentUser: 'audit_operator@localhost', sqlMode: 'STRICT_TRANS_TABLES'}
});
const view = (createSql, names = ['id', 'score'], name = 'active_scores') => ({
  name, kind: 'view', createSql, columns: names.map((name, index) => ({name, ordinal: index + 1}))
});
const source = view(header + '`active_scores` AS ' + originalBody);
const target = view(header + '`active_fixture`.`active_scores` AS ' + targetBody);

test('parses exact SHOW CREATE identity and preserves case-sensitive body literals', () => {
  const current = schema();
  const expected = {
    schema: 'active_fixture', name: 'active_scores', definition: originalBody, algorithm: 'MERGE',
    security: 'INVOKER', definer: 'audit_operator@localhost', checkOption: 'NONE', sqlMode: 'STRICT_TRANS_TABLES'
  };
  assert.deepEqual(parseSnapshotView(current, source), expected);
  assert.deepEqual(assertSelectedViewPair(current, current, source, target), {
    before: expected, after: {...expected, definition: targetBody}
  });
  assert.notEqual(viewBodyKey(originalBody), viewBodyKey(targetBody));
});

test('reads the parenthesized MariaDB form, bare account spelling, and CHECK OPTION', () => {
  const current = schema('mariadb');
  const prefix = 'CREATE ALGORITHM = MERGE DEFINER=audit_operator@localhost SQL SECURITY INVOKER VIEW active_scores';
  const body = 'select d.id AS id,d.score AS score from source_rows d where (d.score<100)';
  const definition = view(prefix + ' (id,score) AS (' + body + ') WITH LOCAL CHECK OPTION');
  const result = parseSnapshotView(current, definition);
  assert.equal(result.definition, body);
  assert.equal(result.definer, 'audit_operator@localhost');
  assert.equal(result.checkOption, 'LOCAL');
  assert.equal(viewBodyKey('(' + body + ')'), viewBodyKey(body));
  assert.equal(parseSnapshotView(current, view(prefix + ' AS (' + body + ') WITH CHECK OPTION')).checkOption, 'CASCADED');
  assert.throws(() => assertSelectedViewPair(current, current, definition,
    view(prefix + ' AS (' + body + ') WITH CASCADED CHECK OPTION')), /CHECK OPTION/u);
});

test('requires the same exact logical schema, view name, owner and creation settings', () => {
  const current = schema();
  const refuses = (proposed, change, expected) =>
    assert.throws(() => assertSelectedViewPair(current, proposed, source, change), expected);
  const otherSchema = schema('mysql', 'other_fixture');
  refuses(otherSchema, view(header + '`other_fixture`.`active_scores` AS ' + targetBody), /active logical schema/u);
  refuses(schema('mariadb'), target, /active logical schema/u);
  const otherAccount = structuredClone(current);
  otherAccount.server.currentUser = 'operator@localhost';
  refuses(otherAccount, target, /active logical schema/u);
  const otherMode = structuredClone(current);
  otherMode.server.sqlMode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES';
  refuses(otherMode, target, /SQL mode/u);
  for (const [from, to] of [['ALGORITHM=MERGE', 'ALGORITHM=UNDEFINED'],
    ['SECURITY INVOKER', 'SECURITY DEFINER'], ['`audit_operator`@', '`different_definer`@']]) {
    refuses(current, view(target.createSql.replace(from, to)), /current-account definer/u);
  }
  refuses(current, view(target.createSql.replace('`active_fixture`.', '`Active_Fixture`.')), /different schema/u);
  refuses(current, view(target.createSql.replace('`active_scores`', '`Active_Scores`')), /different schema/u);
  refuses(current, view(target.createSql.replace('`active_scores`', '`other_view`'), ['id', 'score'], 'other_view'), /same view/u);
});

test('checks that parsed output labels, metadata and an optional header list agree in order', () => {
  const current = schema();
  for (const invalid of [
    view(target.createSql.replace('AS `score`', 'AS `Score`')),
    view(target.createSql, ['score', 'id']),
    view(header + '`active_scores` (`score`,`id`) AS ' + targetBody),
    view(header + '`active_scores` AS SELECT * FROM source_rows'),
    view(header + '`active_scores` AS SELECT id, score + 1 FROM source_rows'),
    {...target, columns: target.columns.map(column => ({...column, ordinal: 1}))}
  ]) assert.throws(() => parseSnapshotView(current, invalid), {code: 'ROCKETBRAIN_REBUILD_VIEW'});

  const swapped = view(header + '`active_scores` AS SELECT score,id FROM source_rows', ['score', 'id']);
  assert.throws(() => assertSelectedViewPair(current, current, source, swapped), /retains its exposed column names and order/u);
});

test('body identity normalizes formatting without collapsing source names, literal values or glued SQL tokens', () => {
  const sql = "select `Records`.`Value` as `Value` from `Records` where (`Records`.`Value` <= 12.4) and `note` = 'a;--b'";
  const formatted = "SELECT `Records` . `Value` AS `Value`\nFROM `Records` WHERE (`Records`.`Value`<=12.4) AND `note`='a;--b'";
  assert.equal(viewBodyKey(sql), viewBodyKey(formatted));
  for (const variant of [sql.replaceAll('`Records`', '`records`'), sql.replace("'a;--b'", "'A;--b'"),
    sql.replace('<=', '< ='), sql.replace('12.4', '1 2.4'), sql.replace('12.4', '12 .4'),
    sql.replace('from `Records`', 'from `active_fixture`.`Records`')]) {
    assert.notEqual(viewBodyKey(sql), viewBodyKey(variant));
  }
  assert.notEqual(viewBodyKey("select t.Exact from t"), viewBodyKey("select t.exact from t"));
  assert.notEqual(viewBodyKey("select t.IN from t"), viewBodyKey("select t.in from t"));
});

test('catalog comparison reconciles only the bound active schema spelling in SHOW CREATE and VIEWS', () => {
  const mysqlShow = targetBody;
  const mysqlCatalog = mysqlShow.replaceAll('`source_rows`', '`active_fixture`.`source_rows`');
  const key = body => scopedViewBodyKey(body, 'STRICT_TRANS_TABLES', 'active_fixture');
  assert.equal(key(mysqlShow), key(mysqlCatalog));
  assert.equal(key(mysqlShow), key(mysqlCatalog.replace('from `active_fixture`.', 'from ')));
  assert.notEqual(key(mysqlShow), key(mysqlCatalog.replace("'ALPha%'", "'alpha%'")));
  assert.notEqual(key(mysqlShow), key(mysqlCatalog.replaceAll('`active_fixture`', '`other_fixture`')));

  const aliased = "select `r`.`id` AS `id` from `source_rows` AS `r` where `r`.`note` like 'ALPha%'";
  assert.notEqual(key(aliased), key(aliased.replaceAll('`r`', '`R`')));
});

test('refuses comments, separators, variables, executable suffixes and unproved qualification', () => {
  const current = schema();
  const forbidden = [originalBody + ';', originalBody + '; SELECT 1', originalBody + ' -- hidden',
    originalBody.replace(' from ', ' /* comment */ from '), originalBody.replace(' from ', ' /*!99999 SELECT 1 */ from '),
    originalBody.replace(' from ', ' /*M!99999 SELECT 1 */ from '), originalBody.replace(' from ', ' /*+ hint */ from '),
    originalBody.replace("'alpha%'", '@user_variable'), originalBody.replace("'alpha%'", '@@sql_mode'),
    originalBody + ' INTO OUTFILE \'file\'', originalBody + ' WITH LOCAL CHECK OPTION trailing',
    'select id, `other_fixture`.SUM(score) AS score from source_rows',
    'select id, (select score from other_rows) AS score from source_rows'];
  for (const body of forbidden) {
    assert.throws(() => parseSnapshotView(current, view(header + '`active_scores` AS ' + body)),
      /SQL|view|Comments/u, body);
  }
  for (const input of [originalBody + ';', originalBody + ' # removed', '/* header */ ' + originalBody]) {
    assert.throws(() => viewBodyKey(input), {code: 'ROCKETBRAIN_REBUILD_VIEW'});
  }
});

test('refuses explicit defaults or unsupported statement forms in SHOW CREATE header', () => {
  const current = schema();
  for (const definition of [target.createSql.replace('CREATE ', 'CREATE OR REPLACE '),
    target.createSql.replace('`audit_operator`@`localhost`', 'CURRENT_USER'),
    target.createSql.replace('ALGORITHM=MERGE', 'ALGORITHM=UNKNOWN'),
    target.createSql.replace('SECURITY INVOKER', 'SECURITY ANY'),
    target.createSql.replace('MERGE', '`MERGE`'), target.createSql.replace('SQL SECURITY INVOKER ', '')]) {
    assert.throws(() => parseSnapshotView(current, view(definition)), {code: 'ROCKETBRAIN_REBUILD_VIEW'});
  }
});
