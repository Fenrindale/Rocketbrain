'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { owned } = require('./schema-stored-diff-host');
const { MysqlService } = require('../src/db/mysql');
const { analyzeSql } = require('../src/db/sql-analysis');
const { callCompletions, callSignature } = require('../src/db/sql-call-completion');
const baseline = { people: 2, departments: 1, rolledBackNames: 0 };
const omitted = (items, label) => items.every(item => item.label !== label || !item.detail?.includes('function ·'));

async function verifySqlCallCompletion(fixture, adapter) {
  const { actor, config, version } = await owned(fixture.dbConfigPath);
  const maria = fixture.dbEngine === 'mariadb';
  const run = async sql => (await actor.query({ sql, rowsAsArray: true }))[0];
  const expect = async (raw, label, accepts) => {
    const item = (await adapter.complete(raw)).find(candidate => candidate.label === label && accepts(candidate));
    assert.ok(item, label + ' not offered for ' + raw);
    return item;
  };
  const materialize = (raw, item, placeholders) => adapter.apply(raw, item, placeholders);
  try {
    const projectRows = await run('SELECT display_name FROM rb_spring_person ORDER BY id');
    assert.equal(projectRows.length, 2);
    const dataset = new URL('/probe/testing-state', fixture.baseUrl);
    assert.equal(dataset.hostname, '127.0.0.1');
    await adapter.connect(config);
    const abbrev = 'SELECT p.dn|Suffix FROM rb_spring_person p ORDER BY p.id';
    const column = await expect(abbrev, 'display_name', item => item.detail === 'Abbreviated column · p');
    assert.equal(column.filterText, 'dn');
    assert.equal(column.insertText, '`display_name`');
    assert.deepEqual(await run(await materialize(abbrev, column)), projectRows);

    const quoted = 'SELECT `project roster`.dn| FROM rb_spring_person AS `project roster` ORDER BY id';
    const quotedColumn = await expect(quoted, 'display_name', item => item.detail?.includes('project roster'));
    assert.deepEqual(await run(await materialize(quoted, quotedColumn)), projectRows);
    const relation = 'SELECT pr| FROM rb_spring_person AS project_roster ORDER BY id';
    const alias = await expect(relation, 'project_roster', item => item.detail?.startsWith('Relation alias'));
    const qualified = (await materialize(relation, alias)).replace('`project_roster`.', '`project_roster`.`display_name`');
    assert.deepEqual(await run(qualified), projectRows);
    const projection = 'SELECT display_name AS person_label FROM rb_spring_person ORDER BY pl|';
    const projected = await expect(projection, 'person_label', item => item.detail === 'Projection alias');
    assert.equal((await run(await materialize(projection, projected))).length, 2);
    assert.ok(!(await adapter.complete('SELECT p.dn| FROM rb_spring_person AS q')).some(item => item.detail?.startsWith('Abbreviated column')));
    const local = 'WITH people_alias AS (SELECT display_name FROM rb_spring_person) SELECT q.dn| FROM people_alias q ORDER BY q.display_name';
    const localColumn = await expect(local, 'display_name', item => item.detail === 'Abbreviated column · q');
    assert.equal((await run(await materialize(local, localColumn))).length, 2);

    const vendor = maria ? 'MariaDB' : 'MySQL';
    const vendorFunction = item => item.detail?.startsWith(`${vendor} function ·`);
    const existing = "SELECT rr|('Ab1','b','x')";
    const replaceName = await expect(existing, 'REGEXP_REPLACE', vendorFunction);
    assert.equal(replaceName.insertText, 'REGEXP_REPLACE');
    assert.deepEqual(await run(await materialize(existing, replaceName)), [['Ax1']]);
    const replacement = 'SELECT rr|';
    const regexTemplates = (await adapter.complete(replacement)).filter(item => item.label === 'REGEXP_REPLACE' && vendorFunction(item));
    assert.equal(regexTemplates.length, maria ? 1 : 2);
    const regexCall = await materialize(replacement, maria ? regexTemplates[0] : regexTemplates.find(item => item.detail.includes('match_type')),
      { subject: "'ABb'", pattern: "'b'", replacement: "'_'" });
    assert.equal(String((await run(regexCall))[0][0]).at(-1), '_');

    const cast = 'SELECT ca|';
    const castItem = await expect(cast, 'CAST', vendorFunction);
    const castSql = await materialize(cast, castItem, { expression: '12', CHAR: 'UNSIGNED' });
    assert.equal(String((await run(castSql))[0][0]), '12');
    const extract = 'SELECT ex|';
    const extractItem = await expect(extract, 'EXTRACT', vendorFunction);
    assert.equal(String((await run(await materialize(extract, extractItem, { expression: "'2024-08-19'" })))[0][0]), '2024');

    const json = 'SELECT jv|';
    const availableJson = (await adapter.complete(json)).filter(item => item.label === 'JSON_VALUE' && vendorFunction(item));
    assert.equal(availableJson.length, maria ? 1 : 2);
    const jsonSql = await materialize(json, maria ? availableJson[0] : availableJson.find(item => item.detail.includes('RETURNING')),
      { document: "'{\"key\":42}'" });
    assert.equal(String((await run(jsonSql))[0][0]), '42');
    assert.equal(/\bRETURNING\b/.test(jsonSql), !maria);
    if (maria) {
      const normal = await expect('SELECT jn|', 'JSON_NORMALIZE', vendorFunction);
      const [[value]] = await run(await materialize('SELECT jn|', normal, { document: "'{\"b\":2,\"a\":1}'" }));
      assert.deepEqual(typeof value === 'string' ? JSON.parse(value) : value, { a: 1, b: 2 });
      assert.ok(omitted(await adapter.complete('SELECT jss|'), 'JSON_STORAGE_SIZE'));
      assert.ok(omitted(await adapter.complete('SELECT utb|'), 'UUID_TO_BIN'));
    } else {
      const storage = await expect('SELECT jss|', 'JSON_STORAGE_SIZE', vendorFunction);
      assert.ok(Number((await run(await materialize('SELECT jss|', storage, { document: "'{\"key\":42}'" })))[0][0]) > 0);
      const uuid = await expect('SELECT utb|', 'UUID_TO_BIN', item => vendorFunction(item) && !item.detail.includes('swap_flag'));
      const uuidSql = await materialize('SELECT utb|', uuid, { uuid: "'6ccd780c-baba-1026-9564-5b8c656024db'" });
      assert.equal((await run(uuidSql))[0][0].length, 16);
      assert.ok(omitted(await adapter.complete('SELECT jn|'), 'JSON_NORMALIZE'));
    }

    const regex = "SELECT REGEXP_REPLACE(CONCAT('A', 'b'), '[b]', 'x,y', |)";
    const regexHelp = await adapter.signature(regex);
    if (maria) assert.deepEqual(regexHelp, []);
    else assert.ok(regexHelp.some(item => item.active === 3 && item.parameters.at(-1) === 'match_type'));
    const nested = await adapter.signature("SELECT REGEXP_REPLACE(CONCAT('A', |'b'), 'b', 'x')");
    assert.ok(nested.some(item => item.label.startsWith('CONCAT(') && item.active === 1));
    const castHelp = await adapter.signature('SELECT CAST(12 AS |');
    assert.ok(castHelp.some(item => item.label === 'CAST(expression AS type)' && item.active === 1));
    const jsonHelp = await adapter.signature("SELECT JSON_VALUE('{\"key\":42}', '$.key' RETURNING |");
    if (maria) assert.deepEqual(jsonHelp, []);
    else assert.ok(jsonHelp.some(item => item.active === 2 && item.parameters[2] === 'type'));

    assert.ok((await adapter.complete('UPDATE rb_spring_person SET display_name=rr|')).some(item => item.label === 'REGEXP_REPLACE' && vendorFunction(item)));
    const unsafeSlots = ['SELECT 1 FROM rr|', 'SELECT other.rr|', "SELECT 'rr| test'", 'SELECT 1 -- rr|',
      'UPDATE rb_spring_person SET rr|=42', 'INSERT INTO rb_spring_person (rr|) VALUES (1)'];
    for (const raw of unsafeSlots) assert.ok(omitted(await adapter.complete(raw), 'REGEXP_REPLACE'), raw);
    const response = await fetch(dataset, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), baseline);
    return { engine: fixture.dbEngine, version, scopedAliasAndCte: true, abbreviationReplacement: true, exactExistingCall: true,
      vendorFilteredFunctions: true, nestedAndSpecialSignatures: true, typedJsonForms: !maria, optionalRegexForms: !maria,
      unsafeSlotsExcluded: 6, simpleMutationExpressions: true, executableCompletedForms: true, jdbc: baseline };
  } finally {
    try { await adapter.disconnect(); } finally { await actor.end(); }
  }
}

const input = raw => ({ text: raw.replace('|', ''), offset: raw.indexOf('|') });
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function runSqlCallCompletionChecks(api, vscode, checks) {
  const fixture = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  async function open(raw) {
    const source = input(raw);
    return { ...source, document: await vscode.workspace.openTextDocument({ language: 'sql', content: source.text }) };
  }
  const result = await verifySqlCallCompletion(fixture, {
    connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    async complete(raw) {
      const { document, offset } = await open(raw);
      const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(offset));
      return result?.items.map(item => ({ ...item, label: typeof item.label === 'string' ? item.label : item.label.label })) ?? [];
    },
    async signature(raw) {
      const { document, offset } = await open(raw);
      const result = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', document.uri, document.positionAt(offset));
      return result?.signatures.map(item => ({ label: item.label, active: item.activeParameter ?? result.activeParameter,
        parameters: item.parameters.map(parameter => parameter.label) })) ?? [];
    },
    async apply(raw, item, replacements = {}) {
      const { document } = await open(raw);
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      const range = item.range?.replacing ?? item.range;
      assert.ok(range);
      if (typeof item.insertText === 'string') {
        assert.equal(await editor.edit(builder => builder.replace(range, item.insertText)), true);
        return document.getText();
      }
      assert.ok(typeof item.insertText.value === 'string' && item.insertText.value.includes('${1:'));
      assert.equal(await editor.insertSnippet(new vscode.SnippetString(item.insertText.value), range), true);
      await vscode.commands.executeCommand('leaveSnippet');
      let text = document.getText();
      for (const [word, value] of Object.entries(replacements)) text = text.replace(new RegExp('\\b' + escaped(word) + '\\b', 'g'), () => value);
      return text;
    }
  });
  checks.push('Installed SQL providers resolved scoped aliases/abbreviations, replaced the exact typed token and inserted executable function snippets.');
  checks.push('The actual engine version selected vendor-only functions and nested argument guidance. String, comment, relation and assignment-name slots were excluded.');
  return { ...result, nativeCompletionAndSignature: true, nativeSnippetInsertion: true };
}

async function verifyActualSqlCallCompletion(fixture) {
  let db, catalog, options;
  return verifySqlCallCompletion(fixture, {
    async connect(config) {
      db = new MysqlService(config); catalog = await db.metadata();
      assert.ok(catalog.semanticContextObserved);
      options = { dialect: catalog.dialect, serverVersion: catalog.serverVersion, sqlMode: catalog.sqlMode, database: catalog.database };
    },
    async disconnect() { await db?.dispose(); },
    complete(raw) {
      const { text, offset } = input(raw);
      return callCompletions(text, offset, options, analyzeSql(text, catalog, options));
    },
    signature(raw) { const { text, offset } = input(raw); return callSignature(text, offset, options) ?? []; },
    apply(raw, item, replacements = {}) {
      const { text } = input(raw);
      const value = item.insertText ?? item.parts.map(part => typeof part === 'string' ? part : replacements[part.placeholder] ?? part.placeholder).join('');
      return text.slice(0, item.start) + value + text.slice(item.end);
    }
  });
}

module.exports = { runSqlCallCompletionChecks, verifyActualSqlCallCompletion };
