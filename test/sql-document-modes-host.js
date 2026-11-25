'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { analyzeLiveDdlScript } = require('../src/db/ddl-model');
const { completionsAt } = require('../src/db/sql-analysis');
const { scopedDmlColumns } = require('../src/db/sql-dml-completion');
const { owned } = require('./schema-stored-diff-host');

const slash = String.fromCharCode(92);
const identifierQuote = String.fromCharCode(96);
const unusual = 'literal' + slash + 'key';
const quote = name => identifierQuote + name.replaceAll(identifierQuote, identifierQuote + identifierQuote) + identifierQuote;
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };

async function verifyDocumentSqlModes(adapter) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const table = 'rb_modes_' + randomBytes(5).toString('hex');
  const ansiReference = 'SELECT "p"."' + unusual + '" AS number_value, "p".member_score FROM "' + table + '" "p"';
  const noEscapeReference = "SELECT 'before" + slash + "' AS saved_text, " + '"p".member_score FROM "' + table + '" "p"';
  const defaultReference = 'SELECT "whole; literal" AS double_text,' +
    " 'escape" + slash + "q' AS single_text FROM " + quote(table);
  const statements = ["SET SESSION sql_mode='ANSI_QUOTES'", ansiReference,
    "SET SESSION sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'", noEscapeReference,
    "SET LOCAL sql_mode=''", defaultReference];
  const source = statements.join(';\n') + ';';
  const mode = async () => (await actor.query('SELECT @@SESSION.sql_mode mode'))[0][0].mode;
  const spring = async () => {
    const url = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  let connected = false;
  try {
    await spring();
    const initial = await mode();
    assert.doesNotMatch(initial, /ANSI_QUOTES|NO_BACKSLASH_ESCAPES/u);
    await actor.query('CREATE TABLE ' + table + ' (' + quote(unusual) + ' INT, member_score INT) ENGINE=InnoDB');
    await actor.query('INSERT INTO ' + table + ' VALUES (21, 45)');
    await adapter.connect(config);
    connected = true;
    const metadataBefore = adapter.catalogModes();
    assert.deepEqual(metadataBefore, initial.split(',').filter(Boolean));
    const report = await adapter.analyze(source);
    assert.equal(report.state, 'known', JSON.stringify(report.unknown));
    assert.equal(report.statements.length, 6);
    assert.deepEqual(report.unknown, []);
    const changes = report.sqlModeTransitions ?? report.modeTransitions;
    assert.deepEqual(changes.map(item => item.sqlMode), [['ANSI_QUOTES'], ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES'], []]);
    const observedText = adapter.documentText?.() ?? source;
    assert.ok(changes.every(item => observedText.slice(item.start,item.end).startsWith('SET ')));
    assert.ok(report.statements.every(item => item.model.executedSql === false));
    assert.deepEqual(report.statements[1].model.projections.map(item => item.type.family), ['integer', 'integer']);
    assert.deepEqual(report.statements[3].model.projections.map(item => item.type.family), ['string', 'integer']);
    assert.deepEqual(report.statements[5].model.projections.map(item => item.type.family), ['string', 'string']);

    const offset = source.indexOf('"p".member_score') + '"p".member_sc'.length;
    const completions = await adapter.complete(offset);
    assert.ok(completions.some(item => item.label === 'member_score' && /\bp\b/u.test(item.detail)));
    await adapter.assertNative?.(offset);
    const dml = statements[0] + ';\nUPDATE "' + table + '" SET member_score=46 WHERE member_score=45;';
    await adapter.analyze(dml);
    const writeOffset = dml.indexOf('SET member_score') + 'SET member_sc'.length;
    const writable = (await adapter.complete(writeOffset)).find(item => item.label === 'member_score' && /Writable column/u.test(item.detail));
    assert.equal(writable?.rangeText, 'member_score');
    const unreadable = await adapter.analyze("SET SESSION sql_mode=CONCAT('ANSI','_QUOTES');\n" + ansiReference + ';');
    assert.equal(unreadable.statements.at(-1).contextUncertain, true);
    assert.deepEqual(unreadable.sqlModeTransitions ?? unreadable.modeTransitions, []);
    assert.deepEqual(adapter.catalogModes(), metadataBefore);
    assert.equal(await mode(), initial);

    await actor.query(statements[0]);
    assert.equal(await mode(), 'ANSI_QUOTES');
    assert.deepEqual((await actor.query(ansiReference))[0], [{ number_value: 21, member_score: 45 }]);
    await actor.query(statements[2]);
    assert.deepEqual((await mode()).split(',').sort(), ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES']);
    assert.deepEqual((await actor.query(noEscapeReference))[0], [{ saved_text: 'before' + slash, member_score: 45 }]);
    await actor.query(statements[4]);
    assert.equal(await mode(), '');
    assert.deepEqual((await actor.query(defaultReference))[0], [{ double_text: 'whole; literal', single_text: 'escapeq' }]);
    await spring();
    return { engine: runtime.dbEngine, serverVersion: version, statements: report.statements.length,
      modeTransitions: changes.length, ansiQuotedBackslashIdentifier: true, noBackslashEscapes: true, restoredLiteralQuoting: true,
      opaqueModeStopsBinding: true, exactOffsets: true, projectedAliasCompletion: true, projectedDmlCompletion: true, analyzerNoExecution: true,
      springJdbcUnchanged: true, nativeProjectedDiagnostics: Boolean(adapter.assertNative) };
  } finally {
    try { if (connected) await adapter.disconnect(); }
    finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + table); }
      finally { await actor.end(); }
    }
  }
}

async function verifyDocumentSqlModesBackend() {
  let db, catalog, report;
  return verifyDocumentSqlModes({
    async connect(config) { db = new MysqlService(config); catalog = await db.metadata(); },
    disconnect: () => db.dispose(),
    catalogModes: () => catalog.sqlMode,
    analyze(text) { report = analyzeLiveDdlScript(text, catalog); return report; },
    async complete(offset) {
      const part = report.statements.find(item => item.start <= offset && offset < item.end);
      if (/^\s*UPDATE\b/u.test(part.model.text)) {
        const options = { ...catalog, sqlMode: part.sqlMode, catalogComplete: true };
        const fields = await scopedDmlColumns(part.model.text, offset - part.start, part.scriptCatalog, options);
        return fields.map(item => ({ ...item, rangeText: part.model.text.slice(item.start, item.end) }));
      }
      return completionsAt(part.model, offset - part.start);
    }
  });
}

async function runSqlDocumentModeChecks(api, vscode, checks) {
  let document, text;
  const result = await verifyDocumentSqlModes({
    connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    catalogModes: () => api.catalogSnapshot().sqlMode,
    documentText: () => document.getText(),
    async analyze(source) {
      text = source;
      document = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
      return api.sqlAnalysis.analyzeDocument(document);
    },
    async complete(offset) {
      const prior = text.slice(0, offset).split('\n');
      const position = new vscode.Position(prior.length - 1, prior.at(-1).length);
      const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
      return completion?.items.map(item => ({ label: typeof item.label === 'string' ? item.label : item.label.label,
        detail: item.detail, rangeText: item.range instanceof vscode.Range ? document.getText(item.range) : undefined })) ?? [];
    },
    assertNative() {
      const notices = vscode.languages.getDiagnostics(document.uri).filter(item => item.code === 'sql.script.sessionMode');
      assert.equal(notices.length, 3);
      assert.ok(notices.every(item => item.message.includes('declared document SQL mode')));
    }
  });
  checks.push('The native SQL editor attributed literal SET SESSION and SET LOCAL modes to later statement offsets and completed a quoted alias column.');
  checks.push('Actual server output confirmed ANSI quoted identifiers and both string escape modes. The editor did not execute SQL or bind after an opaque mode expression.');
  return result;
}

module.exports = { runSqlDocumentModeChecks, verifyDocumentSqlModesBackend };
if (require.main === module) {
  verifyDocumentSqlModesBackend().then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
