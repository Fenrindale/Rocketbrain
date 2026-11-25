'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { planJavaCatalogRename } = require('../src/db/sql-usage-sources');
const { scanJavaSql } = require('../src/db/java-sql-usages');
const { MysqlService } = require('../src/db/mysql');
const { withJavaSqlSchemaCase } = require('./java-sql-schema-rename-host');

const catalog = { database: 'fixture', dialect: 'mysql', coverage: { tables: 'loaded', columns: 'loaded' }, tables: [
  { name: 'people', columns: [{ name: 'id', type: 'bigint' }, { name: 'label', type: 'varchar(80)' }] },
  { name: 'other', columns: [{ name: 'id', type: 'bigint' }, { name: 'label', type: 'varchar(80)' }] }
], views: [] };
const scope = { database: 'fixture', dialect: 'mysql', sqlMode: [] };
const target = { kind: 'column', database: 'fixture', table: 'people', column: 'label' };

function source(fragment) {
  return ['import org.springframework.jdbc.core.JdbcTemplate;', 'class Selection {',
    '  String choose(JdbcTemplate jdbc, long id) {', `    return jdbc.queryForObject(${fragment}, String.class, id);`, '  }', '}'].join('\n');
}

test('Java SQL rename projects the exact physical tokens through escapes and text block indentation', () => {
  const text = source(`"""
        SELECT p.label AS visible
        FROM people p
        WHERE p.id = ? AND p.label <> 'label' /* label */
          AND NOT EXISTS (SELECT 1 FROM other o WHERE o.label = 'label')
        """`);
  const renamed = planJavaCatalogRename(text, catalog, scope, target, 'new"label');
  assert.equal(renamed.edits.length, 2);
  assert.ok(renamed.edits.every(edit => text.slice(edit.start, edit.end) === 'label'));
  assert.equal(renamed.resultText, text.replaceAll('p.label', 'p.`new\\"label`'));
  const decoded = scanJavaSql(renamed.resultText).fragments[0].text;
  assert.ok(decoded.includes('p.`new"label` AS visible'));
  assert.ok(decoded.includes("o.label = 'label'"));
  assert.ok(decoded.includes('/* label */'));
});

test('Java SQL rename preserves earlier concatenations and refuses a split token or runtime SQL', () => {
  const independent = source('"SELECT p.label " + "FROM people p WHERE p.id = ?"');
  assert.deepEqual(planJavaCatalogRename(independent, catalog, scope, target, 'display').edits.map(edit => edit.newText), ['`display`']);
  const split = source('"SELECT p.la" + "bel FROM people p WHERE p.id = ?"');
  assert.throws(() => planJavaCatalogRename(split, catalog, scope, target, 'display'), { code: 'SQL_PROJECT_EMBEDDED_SPLIT' });
  const dynamic = source('"SELECT p.label FROM " + value + " p WHERE p.id = ?"');
  assert.throws(() => planJavaCatalogRename(dynamic, catalog, scope, target, 'display'), { code: 'SQL_PROJECT_INCOMPLETE' });
});

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG && process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
test('reviewed physical rename preserves real Spring JDBC behavior in the edited Java source',
  { skip: !fixture && 'Run an owned Spring and DB fixture with an independent JDK.', timeout: 90000 }, async () => {
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
    const proof = await withJavaSqlSchemaCase(runtime, async ({ config, changed, original, expected, columns }) => {
      const db = new MysqlService(config);
      try {
        const metadata = await db.metadata();
        const plan = await db.previewSchemaRename(changed);
        const selected = { ...changed, database: config.database };
        const { resultText: after, edits } = planJavaCatalogRename(original, metadata,
          { database: config.database, dialect: metadata.dialect, sqlMode: metadata.sqlMode,
            tableNameCaseSensitive: metadata.tableNameCaseSensitive }, selected, changed.newName);
        assert.equal(after, expected);
        assert.equal(edits.length, 3);
        assert.deepEqual(await columns(changed.table), ['id', 'label']);
        const applied = await db.applySchemaRename({ reviewId: plan.reviewId, allowUnverifiedDependencies: true });
        assert.equal(applied.state, 'applied');
        assert.equal(applied.verified, true);
        return { after, sourceEdits: edits.length, details: { reviewedPhysicalRename: true } };
      } finally { await db.dispose(); }
    });
    console.log(JSON.stringify(proof));
  });
