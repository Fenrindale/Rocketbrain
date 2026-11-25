'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { sqlJoinFixes } = require('../src/db/sql-join-fixes');
const { sqlQuickFixes } = require('../src/db/sql-quick-fixes');
const { statementRanges } = require('../src/db/sql-analysis');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

const jdbcBaseline = { people: 2, departments: 1, rolledBackNames: 0 };
const commands = { join: 'rocketbrain.sql.applyJoinQuickFix', name: 'rocketbrain.sql.applyReviewedQuickFix' };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const qualified = (schema, table) => quote(schema) + '.' + quote(table);

async function withSqlContextFixture(verify) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const crossPath = await fs.realpath(process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG || '');
  assert.equal(path.dirname(crossPath), path.dirname(await fs.realpath(runtime.dbConfigPath)));
  const cross = await read(crossPath);
  assert.equal(cross.fixtureId, path.basename(path.dirname(crossPath)));
  assert.deepEqual(cross.schemas, ['rocketbrain_fixture', 'rocketbrain_related']);
  const { actor, config, version } = await owned(runtime.dbConfigPath), [local, external] = cross.schemas;
  const suffix = randomBytes(4).toString('hex');
  const parent = 'rb_ctx_parent_' + suffix, bridge = 'rb_ctx_bridge_' + suffix, leaf = 'rb_ctx_leaf_' + suffix, tail = 'rb_ctx_tail_' + suffix;
  const bridgeKey = 'rb_ctx_from_bridge_' + suffix, parentKey = 'rb_ctx_from_parent_' + suffix, tailKey = 'rb_ctx_from_tail_' + suffix;
  const [p, b, l, t] = [qualified(local, parent), qualified(local, bridge), qualified(external, leaf), qualified(external, tail)];
  try {
    await actor.query(`CREATE TABLE ${p}(tenant INT NOT NULL,id BIGINT UNSIGNED,label VARCHAR(40),PRIMARY KEY(tenant,id)) ENGINE=InnoDB`);
    await actor.query(`CREATE TABLE ${b}(tenant INT NOT NULL,id BIGINT UNSIGNED,parent_id BIGINT UNSIGNED,label VARCHAR(40),PRIMARY KEY(tenant,id),
      FOREIGN KEY(tenant,parent_id) REFERENCES ${p}(tenant,id)) ENGINE=InnoDB`);
    await actor.query(`CREATE TABLE ${l}(tenant INT NOT NULL,id BIGINT UNSIGNED,bridge_id BIGINT UNSIGNED,owner_id BIGINT UNSIGNED,PRIMARY KEY(tenant,id),
      CONSTRAINT ${bridgeKey} FOREIGN KEY(tenant,bridge_id) REFERENCES ${b}(tenant,id),
      CONSTRAINT ${parentKey} FOREIGN KEY(tenant,owner_id) REFERENCES ${p}(tenant,id)) ENGINE=InnoDB`);
    await actor.query(`CREATE TABLE ${t}(tenant INT NOT NULL,id BIGINT UNSIGNED,leaf_id BIGINT UNSIGNED,PRIMARY KEY(tenant,id),
      CONSTRAINT ${tailKey} FOREIGN KEY(tenant,leaf_id) REFERENCES ${l}(tenant,id)) ENGINE=InnoDB`);
    await actor.query(`INSERT INTO ${p} VALUES (1,10,'root'),(1,11,'alternate owner'),(2,10,'other tenant')`);
    await actor.query(`INSERT INTO ${b} VALUES (1,22,10,'through bridge'),(2,22,10,'other bridge')`);
    await actor.query(`INSERT INTO ${l} VALUES (1,33,22,11),(2,33,22,10)`);
    await actor.query(`INSERT INTO ${t} VALUES (1,50,33),(2,50,33)`);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, jdbcBaseline);
    const prefix = 'SELECT 7;\n', suffixRead = ';\nSELECT 8;';
    const chain = prefix + `SELECT p.label, b.label, l.id+0 AS leaf_id FROM ${p} p JOIN ${b} b ON p.tenant=b.tenant AND p.id=b.parent_id\n` +
      `LEFT OUTER JOIN ${l} l ON| JOIN ${t} t ON t.tenant=l.tenant AND t.leaf_id=l.id WHERE p.tenant=1 AND p.id=10` + suffixRead;
    const ambiguity = prefix + `SELECT p.label FROM ${p} p WHERE p.id=10 AND p.tenant=1 AND EXISTS (` +
      `SELECT |id FROM ${b} p JOIN ${b} w ON p.tenant=w.tenant AND p.id=w.id WHERE p.id=22)` + suffixRead;
    const qualifier = prefix + `SELECT ${local}.|${parent.slice(0, -1)}x.label FROM ${p} WHERE tenant=1 AND id=10` + suffixRead;
    const drop = () => actor.query(`ALTER TABLE ${l} DROP FOREIGN KEY ${bridgeKey}`);
    return await verify({ runtime, config, version, jdbc, actor, bridgeKey, parentKey, chain, ambiguity, qualifier, parent, drop });
  } finally {
    try { for (const table of [t, l, b, p]) await actor.query('DROP TABLE IF EXISTS ' + table); }
    finally { await actor.end(); }
  }
}

const parse = source => ({ text: source.replace('|', ''), offset: source.indexOf('|') });
const edited = (text, fix) => text.slice(0, fix.start) + fix.replacement + text.slice(fix.end);
function currentStatement(text, offset) {
  const part = statementRanges(text, { sqlMode: [] }).statements.find(item => item.start <= offset && offset < item.end);
  assert.ok(part);
  return part;
}

async function verifySqlContextCases(fixture, adapter) {
  const { chain, ambiguity, qualifier, bridgeKey, parentKey, parent, drop } = fixture;
  const open = (kind, source) => adapter.open(kind, parse(source));
  const original = await open('join', chain);
  const [parentFix, bridgeFix] = original.fixes;
  assert.equal(original.fixes.length, 2);
  assert.deepEqual(original.fixes.map(fix => fix.title), ['Complete JOIN using ' + parentKey + ' (p → l)',
    'Complete JOIN using ' + bridgeKey + ' (b → l)']);
  assert.ok(original.fixes.every(fix => fix.start === original.offset && fix.end === fix.start));
  assert.equal(bridgeFix.replacement, ' `b`.`tenant` = `l`.`tenant` AND `b`.`id` = `l`.`bridge_id`');
  await adapter.assertDirtyRefused?.(original, bridgeFix);
  const corrected = await open('join', chain);
  assert.deepEqual(await adapter.applyAndRun(corrected, corrected.fixes[1]), [['root', 'through bridge', '33']]);
  const alternative = await open('join', chain);
  assert.equal(alternative.fixes[0].replacement, parentFix.replacement);
  assert.deepEqual(await adapter.applyAndRun(alternative, alternative.fixes[0]), []);

  const nested = await open('name', ambiguity);
  assert.deepEqual(nested.fixes.map(fix => fix.replacement), ['`p`.`id`', '`w`.`id`']);
  assert.deepEqual(await adapter.applyAndRun(nested, nested.fixes[0]), [['root']]);
  const physical = await open('name', qualifier);
  assert.deepEqual(physical.fixes.map(fix => fix.replacement), [quote(parent)]);
  assert.deepEqual(await adapter.applyAndRun(physical, physical.fixes[0]), [['root']]);
  assert.deepEqual((await open('join', 'USE rocketbrain_related;\n' + chain)).fixes, []);
  assert.deepEqual((await open('name', 'USE rocketbrain_related;\n' + qualifier)).fixes, []);
  const saved = await open('join', chain);
  await drop();
  await adapter.assertRemovedRefused?.(saved, saved.fixes[1]);
  assert.deepEqual((await open('join', chain)).fixes.map(fix => fix.title), [parentFix.title]);
  return { engine: fixture.runtime.dbEngine, version: fixture.version, jdbc: fixture.jdbc, chainedCompositeJoin: true,
    twoObservedSchemas: true, validAlternatives: 2, laterAliasExcluded: true, exactSiblingAndScriptPreservation: true,
    nestedQualifierResolved: true, schemaQualifiedTypoResolved: true, contextBarrier: true, removedConstraintRefused: true };
}

async function verifySqlContextFixBackend() {
  return withSqlContextFixture(async fixture => {
    const db = new MysqlService(fixture.config);
    try {
      const catalog = await db.metadata();
      return await verifySqlContextCases(fixture, {
        async open(kind, input) {
          const { text, offset } = input;
          const fixes = kind === 'join' ? await sqlJoinFixes(text, offset, catalog, request => db.joinCompletionCatalog(request)) :
            sqlQuickFixes(text, offset, catalog);
          return { ...input, fixes };
        },
        async applyAndRun(input, fix) {
          const after = edited(input.text, fix), part = currentStatement(after, input.offset);
          const [rows] = await fixture.actor.query({ sql: after.slice(part.start, part.end), rowsAsArray: true,
            supportBigNumbers: true, bigNumberStrings: true });
          return rows.map(row => row.map(value => value == null ? value : String(value)));
        }
      });
    } finally { await db.dispose(); }
  });
}

async function runSqlContextFixChecks(api, vscode, checks) {
  return withSqlContextFixture(async fixture => {
    await api.connectMysql(fixture.config);
    const run = fix => vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
    try {
      const details = await verifySqlContextCases(fixture, {
        async open(kind, input) {
          const document = await vscode.workspace.openTextDocument({ language: 'sql', content: input.text });
          const at = document.positionAt(input.offset), range = new vscode.Range(at, at);
          const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, range, 'quickfix');
          return { ...input, document, fixes: actions.filter(item => item.command?.command === commands[kind]).map(item => {
            const frame = item.command.arguments[0];
            return { command: item.command, title: item.title, start: frame.start, end: frame.end ?? frame.start, replacement: frame.replacement };
          }) };
        },
        async applyAndRun(input, fix) {
          const { document, offset, text } = input, editor = await vscode.window.showTextDocument(document, { preview: false });
          assert.equal(await run(fix), true);
          const after = edited(text, fix);
          await until(() => document.getText() === after, 5000);
          const part = currentStatement(after, offset);
          editor.selection = new vscode.Selection(document.positionAt(part.start), document.positionAt(part.end));
          const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
          const record = api.results().find(item => item.id === id);
          assert.ok(record?.result, record?.error);
          return record.result.rows.map(row => row.map(value => value == null ? value : String(value)));
        },
        async assertDirtyRefused({ document, text }, fix) {
          const editor = await vscode.window.showTextDocument(document, { preview: false });
          assert.equal(await editor.edit(change => change.insert(document.positionAt(text.length), '\n')), true);
          await until(() => document.getText() === text + '\n', 5000);
          assert.equal(await run(fix), false);
        },
        async assertRemovedRefused({ document, text }, fix) {
          assert.equal(await run(fix), false);
          assert.equal(document.getText(), text);
        }
      });
      checks.push('Native SQL Quick Fix preserved adjacent statements and chained JOIN predicates while offering two observed cross-schema composite keys.');
      checks.push('Executing the alternatives produced distinct real results. Nested and quoted physical qualifiers resolved, and stale documents or removed keys were refused.');
      return { ...details, nativeQuickFix: true, dirtyDocumentRefused: true, staleCommandRefused: true };
    } finally { await api.disconnectMysql(); }
  });
}

module.exports = { verifySqlContextFixBackend, runSqlContextFixChecks };
if (require.main === module) verifySqlContextFixBackend().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
