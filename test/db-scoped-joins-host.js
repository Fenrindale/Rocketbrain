'use strict';

const assert = require('node:assert/strict');
const { withScopedRelationshipFixture } = require('./db-related-scoped-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const QUOTE = String.fromCharCode(96);
const quote = value => QUOTE + value.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
const qualified = (schema, table) => quote(schema) + '.' + quote(table);

function statements(fixture) {
  const { config, local, remote, table, logical } = fixture, prefix = table.slice(0, -2);
  const parent = qualified(remote, table), child = qualified(local, table);
  return [
    { name: 'spring', text: 'SELECT COUNT(*) AS matches FROM rb_spring_person p JOIN rb_spring_dep|',
      replaces: 'rb_spring_dep', target: qualified(config.database, 'rb_spring_department'), result: 2,
      keys: [quote('p') + '.' + quote('department_id')] },
    { name: 'cte', text: 'SELECT 7;\nWITH sources(t_key,b_key) AS (' +
        'SELECT c.tenant,c.token FROM ' + child + ' c WHERE c.id=2), ' +
        'next_scope AS (SELECT x.t_key AS chosen,x.b_key FROM sources x)\n' +
        'SELECT COUNT(*) AS matches FROM next_scope n INNER JOIN ' + remote + '.' + prefix + '|;\nSELECT 8;',
      replaces: remote + '.' + prefix, target: parent, result: 1,
      keys: [quote('n') + '.' + quote('chosen'), quote('n') + '.' + quote('b_key')] },
    { name: 'derived', text: 'SELECT COUNT(*) AS matches FROM (SELECT c.tenant AS p_key,c.token AS bytes FROM ' +
        child + ' c WHERE c.id=2) d JOIN ' + remote + '.' + prefix + '|',
      replaces: remote + '.' + prefix, target: parent, result: 1,
      keys: [quote('d') + '.' + quote('p_key'), quote('d') + '.' + quote('bytes')] },
    { name: 'correlated', text: 'SELECT COUNT(*) AS matches FROM ' + child + ' c WHERE c.id=2 AND EXISTS (' +
        'SELECT p.label FROM ' + parent + ' p INNER JOIN ' + local + '.' + prefix +
        '| WHERE p.tenant=c.tenant AND p.token=c.token)',
      replaces: local + '.' + prefix, target: child, result: 1,
      keys: [quote('p') + '.' + quote('tenant'), quote('p') + '.' + quote('token')] },
    { name: 'saved relation', text: 'WITH tags(k,b) AS (SELECT a.reference_id,a.token FROM ' +
        quote(logical) + ' a WHERE a.id=10) SELECT COUNT(*) AS matches FROM tags t JOIN ' + prefix + '|',
      replaces: prefix, target: child, result: 1,
      keys: [quote('t') + '.' + quote('k'), quote('t') + '.' + quote('b')], logical: true }
  ];
}

async function verify(workflow, fixture, reject, run) {
  const cases = statements(fixture);
  for (const item of cases) await run(item);
  const { table, local } = fixture;
  for (const text of [
    'SELECT missing.id FROM ' + quote(table) + ' c JOIN |',
    'SELECT c.id FROM ' + quote(table) + ' c, (SELECT tenant FROM ' + quote(table) + ') c JOIN |',
    'USE ' + local + '; SELECT * FROM ' + quote(table) + ' c JOIN |',
    'WITH k(a,b) AS (SELECT c.tenant+1,c.token FROM ' + quote(table) + ' c) SELECT * FROM k JOIN |'
  ]) assert.deepEqual(await reject(text), []);
  return Object.fromEntries(cases.map(test => [test.name, test.result]).concat([[workflow, true]]));
}

function parsed(source) {
  const cursor = source.indexOf('|');
  assert.ok(cursor > 0);
  return { text: source.slice(0, cursor) + source.slice(cursor + 1), offset: cursor };
}

function verifiedItem(items, item, insert) {
  const match = items.find(value => typeof value.insertText === 'string' && value.insertText.startsWith(item.target + ' ') &&
    value.detail?.endsWith(item.logical ? 'configured workspace relationship' : 'verified foreign key'));
  assert.ok(match, 'Missing verified JOIN completion for ' + item.name);
  for (const key of item.keys) assert.ok(match.insertText.includes(key), 'The JOIN lost a projected key.');
  const keyed = item.keys.map(key => match.insertText.indexOf(key));
  assert.deepEqual(keyed, [...keyed].sort((a, b) => a - b), 'Composite columns lost their declared order.');
  return insert(match);
}

async function runScopedJoinChecks(api, vscode, checks) {
  let coverage;
  const { engine, jdbc } = await withScopedRelationshipFixture(async fixture => {
    const { config, logical, definition } = fixture;
    const profiles = api.dbConnections, diagrams = api.schemaDiagrams;
    const profile = await profiles.save({ profile: { name: 'Scoped JOIN ' + definition.id, host: config.host,
      port: config.port, user: config.user, database: config.database, tls: { mode: 'disabled' }, ssh: null },
    password: config.password, rememberPassword: false });
    let annotation;
    async function completion(source) {
      const { text, offset } = parsed(source);
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
      const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(offset));
      return { document, items: result.items, offset };
    }
    const joinOnly = items => items.filter(item => typeof item.insertText === 'string' && /\sON\s/.test(item.insertText));
    try {
      await profiles.connect({ id: profile.id, password: config.password });
      await api.sqlAnalysis.refreshMetadata();
      const graph = await diagrams.openDiagram({ focus: logical });
      const updated = await diagrams.addRelation(graph.token, { name: definition.name, child: definition.child, parent: definition.parent, pairs: definition.pairs });
      annotation = updated.diagram.edges.find(edge => edge.kind === 'logical' && edge.child === logical);
      assert.ok(annotation);
      coverage = await verify('nativeCompletionProvider', fixture, async source => joinOnly((await completion(source)).items), async item => {
        const { document, items, offset } = await completion(item.text);
        const editor = await vscode.window.showTextDocument(document);
        const candidate = verifiedItem(items, item, match => match);
        assert.equal(document.getText(candidate.range), item.replaces);
        assert.equal(document.offsetAt(candidate.range.end), offset);
        assert.equal(await editor.edit(edit => edit.replace(candidate.range, candidate.insertText)), true);
        const edited = document.getText();
        const { statementRanges } = require('../src/db/sql-analysis');
        const part = statementRanges(edited, { sqlMode: [] }).statements.find(value =>
          value.start <= offset && value.end > offset);
        assert.ok(part);
        editor.selection = new vscode.Selection(document.positionAt(part.start), document.positionAt(part.end));
        await vscode.commands.executeCommand('rocketbrain.runQuery');
        const result = api.results().at(-1);
        assert.equal(result.state, 'done', result.error);
        assert.deepEqual(result.result.columns, ['matches']);
        assert.equal(Number(result.result.rows[0][0]), item.result);
      });
      const current = await diagrams.openDiagram({ focus: logical });
      await diagrams.removeRelation(current.token, annotation.id);
      annotation = undefined;
      const latest = await completion(statements(fixture).at(-1).text);
      assert.equal(latest.items.some(item => item.detail?.includes('configured workspace relationship')), false);
    } finally {
      if (annotation) {
        const current = await diagrams.openDiagram({ focus: logical });
        await diagrams.removeRelation(current.token, annotation.id);
      }
      await api.disconnectMysql();
      await profiles.remove({ id: profile.id, expectedRevision: profile.revision });
    }
  });
  checks.push('Native editor JOIN completion replaces only the active prefix, preserves adjacent statements, tracks CTE and derived aliases, and executes inbound and outbound cross-schema composite keys on the live server.');
  checks.push('A configured profile-scoped logical relationship is labelled and usable until removed; dangling and ambiguous aliases and changed statement context suppress foreign-key suggestions.');
  return { engine, jdbc, ...coverage, logicalRemovalDisablesCompletion: true };
}

async function verifyScopedJoinBackend() {
  const { MysqlService } = require('../src/db/mysql');
  const { logicalEdges } = require('../src/db/schema-erd');
  const { scopedForeignKeyJoins } = require('../src/db/foreign-key-joins');
  const { statementRanges } = require('../src/db/sql-analysis');
  let coverage;
  const { engine, jdbc } = await withScopedRelationshipFixture(async fixture => {
    const spring = await jdbcReadback(), db = new MysqlService(fixture.config);
    try {
      const metadata = await db.metadata();
      const options = { dialect: metadata.dialect, sqlMode: metadata.sqlMode, tableNameCaseSensitive: metadata.tableNameCaseSensitive,
        logical: logicalEdges(metadata, [fixture.definition]) };
      const lookup = request => db.joinCompletionCatalog(request);
      const proposals = async source => {
        const { text, offset } = parsed(source);
        return scopedForeignKeyJoins(text, offset, metadata, options, lookup);
      };
      coverage = await verify('liveBackend', fixture, proposals, async item => {
        const { text, offset } = parsed(item.text);
        const candidate = verifiedItem(await proposals(item.text), item, match => match);
        assert.equal(text.slice(candidate.start, candidate.end), item.replaces);
        assert.equal(candidate.end, offset);
        const edited = text.slice(0, candidate.start) + candidate.insertText + text.slice(candidate.end);
        const part = statementRanges(edited, options).statements.find(value => value.start <= offset && value.end > offset);
        assert.ok(part);
        const result = await db.query(edited.slice(part.start, part.end));
        assert.deepEqual(result.columns, ['matches']);
        assert.equal(Number(result.rows[0][0]), item.result);
      });
      assert.deepEqual(await jdbcReadback(), spring);
    } finally { await db.dispose(); }
  });
  return { engine, jdbc, ...coverage, qualifiedBulkCatalog: true, guardedRejections: 4 };
}

if (require.main === module) verifyScopedJoinBackend().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error.stack);
  process.exitCode = 1;
});

module.exports = { runScopedJoinChecks, verifyScopedJoinBackend };
