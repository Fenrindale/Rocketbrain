'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');
const { MysqlService } = require('../src/db/mysql');
const { analyzeLiveDdlScript } = require('../src/db/ddl-model');
const { indexHintCompletions } = require('../src/db/ddl-script-indexes');
const { completionsAt } = require('../src/db/sql-analysis');
const { scopedDmlColumns } = require('../src/db/sql-dml-completion');
const { until } = require('./helpers/stdio-lsp');

const jdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const lower = value => value?.toLowerCase();

async function verifyLiveScriptDdl(runtime, adapter) {
  const spring = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(spring.hostname, '127.0.0.1');
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const table = 'rb_live_ddl_' + randomBytes(5).toString('hex');
  const added = `ALTER TABLE ${table} ADD COLUMN amount DECIMAL(24,8) DEFAULT 12.34567890, ADD INDEX ix_amount (amount)`;
  const renamed = `ALTER TABLE ${table} RENAME COLUMN amount TO cost, RENAME INDEX ix_amount TO ix_cost`;
  const created = `CREATE INDEX ix_label ON ${table} (label)`;
  const dropIndex = `DROP INDEX ix_label ON ${table}`;
  const dropped = `ALTER TABLE ${table} DROP INDEX ix_cost, DROP COLUMN cost`;
  const privateScript = [
    `SELECT p.id FROM ${table} p`, added, `SELECT p.amount FROM ${table} p`, renamed,
    `SELECT p.cost FROM ${table} AS p FORCE INDEX (ix_cost)`, `UPDATE ${table} SET cost=15 WHERE id=1`,
    created, `SELECT p.label FROM ${table} p USE INDEX (ix_label)`, dropIndex, dropped,
    `SELECT p.cost FROM ${table} p`, "SET SESSION sql_mode=CONCAT('ANSI','_QUOTES')", `SELECT p.id FROM ${table} p`
  ].join(';\n') + ';';
  const inspect = async () => {
    const [columns] = await actor.execute('SELECT COLUMN_NAME name, COLUMN_TYPE type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table]);
    const [indexes] = await actor.execute('SELECT INDEX_NAME name, COLUMN_NAME columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', [table]);
    return { columns, indexes };
  };
  try {
    await actor.query(`CREATE TABLE ${table} (id BIGINT PRIMARY KEY, label VARCHAR(32)) ENGINE=InnoDB`);
    await actor.query(`INSERT INTO ${table} VALUES (1,'seed')`);
    await adapter.connect(config);
    const before = await inspect();
    const originalMode = (await actor.query('SELECT @@session.sql_mode AS mode'))[0][0].mode;
    await adapter.open(privateScript);
    const report = adapter.report();
    const after = report.statements;
    assert.equal(report.scriptCatalog, true);
    assert.equal(report.executedSql, false);
    assert.equal(report.validityVerified, false);
    assert.equal(after[0].scriptShadow, false);
    assert.equal(lower(after[2].model.projections[0].type.dbType), 'decimal(24,8)');
    assert.equal(after[4].model.state, 'known');
    assert.equal(lower(after[4].model.projections[0].type.dbType), 'decimal(24,8)');
    assert.equal(after[7].model.state, 'known');
    assert.equal(after[10].model.state, 'invalid');
    assert.ok(after[10].model.diagnostics.some(item => item.code === 'sql.name.column'));
    assert.equal(after[12].contextUncertain, true);
    assert.equal(after[12].model.projections[0].type.family, 'unknown');
    assert.deepEqual((report.ddlChanges ?? report.changes).flatMap(change => change.indexChanges || []).map(change => [change.action, change.name]),
      [['add','ix_amount'], ['rename','ix_amount'], ['add','ix_label'], ['drop','ix_label'], ['drop','ix_cost']]);

    const indexAt = privateScript.indexOf('FORCE INDEX (ix_cost)') + 'FORCE INDEX (ix_'.length;
    const completeIndex = (await adapter.completion(indexAt)).filter(item => item.detail?.startsWith('Script index'));
    assert.deepEqual(completeIndex.map(item => [item.label, item.detail]), [['ix_cost', 'Script index · cost']]);
    const columnAt = privateScript.indexOf('SELECT p.cost') + 'SELECT p.co'.length;
    assert.ok((await adapter.completion(columnAt)).some(item => item.label === 'cost' && /decimal\(24,8\)/i.test(item.detail)));
    const dmlAt = privateScript.indexOf('SET cost=15') + 'SET co'.length;
    assert.ok((await adapter.completion(dmlAt)).some(item => item.label === 'cost' && /Writable column/.test(item.detail)));
    const staleAt = privateScript.lastIndexOf('SELECT p.id') + 'SELECT p.i'.length;
    assert.ok(!(await adapter.completion(staleAt)).some(item => item.label === 'id'));
    await adapter.assertProtected?.(columnAt);

    const replacement = privateScript.replaceAll('ix_cost', 'ix_revised');
    await adapter.edit(replacement);
    const rebindAt = replacement.indexOf('FORCE INDEX (ix_revised)') + 'FORCE INDEX (ix_'.length;
    assert.deepEqual((await adapter.completion(rebindAt)).filter(item => item.detail?.startsWith('Script index')).map(item => item.label), ['ix_revised']);
    assert.deepEqual(await inspect(), before);
    assert.equal((await actor.query('SELECT @@session.sql_mode AS mode'))[0][0].mode, originalMode);

    // Apply only these exact owned fixture statements after validating the editor's read-only analysis.
    await actor.query(added);
    const physicalAdd = await inspect();
    assert.ok(physicalAdd.columns.some(item => item.name === 'amount' && lower(item.type) === 'decimal(24,8)'));
    assert.ok(physicalAdd.indexes.some(item => item.name === 'ix_amount' && item.columnName === 'amount'));
    await actor.query(renamed);
    const physicalRename = await inspect();
    assert.ok(physicalRename.indexes.some(item => item.name === 'ix_cost' && item.columnName === 'cost'));
    const [[value]] = await actor.query({ sql: `SELECT p.cost FROM ${table} AS p FORCE INDEX (ix_cost)`, rowsAsArray: true });
    assert.equal(value[0], '12.34567890');
    await actor.query(created);
    assert.ok((await inspect()).indexes.some(item => item.name === 'ix_label' && item.columnName === 'label'));
    await actor.query(dropIndex);
    await actor.query(dropped);
    assert.deepEqual(await inspect(), before);
    await assert.rejects(() => actor.query(`SELECT p.cost FROM ${table} p`), error => error.code === 'ER_BAD_FIELD_ERROR');
    const response = await fetch(spring, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), jdbc);
    return { engine: runtime.dbEngine, version, automaticScriptCatalog: true, typedColumnsAtStatement: true,
      indexActions: 5, indexedColumnRename: true, indexHintNameScope: true, dmlUsesShadow: true,
      missingAfterDrop: true, modeChangeSuppressesBinding: true, reeditInvalidates: true,
      analysisLeftPhysicalCatalogUnchanged: true, realDdlMatched: true, exactDecimal: true, jdbc };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try { await actor.query(`DROP TABLE IF EXISTS ${table}`); }
      finally { await actor.end(); }
    }
  }
}

async function runLiveScriptDdlChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  let document, source;
  const positionAt = offset => {
    const lines = source.slice(0, offset).split('\n');
    return new vscode.Position(lines.length - 1, lines.at(-1).length);
  };
  const fields = await verifyLiveScriptDdl(runtime, {
    connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    async open(text) { source = text; document = await vscode.workspace.openTextDocument({ language: 'sql', content: text }); },
    async edit(text) {
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      const end = document.positionAt(document.getText().length);
      assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(new vscode.Position(0,0),end),text)), true);
      await until(() => document.getText().replace(/\r\n/g, '\n') === text, 8000);
      source = text;
    },
    report: () => api.sqlAnalysis.analyzeDocument(document),
    async completion(offset) {
      const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, positionAt(offset));
      return result?.items.map(item => ({ label: typeof item.label === 'string' ? item.label : item.label.label, detail: item.detail })) ?? [];
    },
    async assertProtected(offset) {
      const position = positionAt(offset);
      assert.equal(api.sqlAnalysis.virtualActive(document), false);
      assert.equal(api.sqlAnalysis.scriptContextAt(document, document.offsetAt(position)), true);
      assert.equal(api.sqlAnalysis.catalogTargetAt(document, position), null);
      assert.throws(() => api.sqlAnalysis.prepareRename(document, position), /preceding DDL/);
      const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(position, position));
      assert.ok(!actions?.some(action => /^rocketbrain\.sql\./.test(action.command?.command ?? '')));
      const diagnostics = vscode.languages.getDiagnostics(document.uri);
      assert.ok(diagnostics.some(item => item.code === 'sql.script.catalog'));
      assert.ok(diagnostics.some(item => item.code === 'sql.script.incomplete'));
    }
  });
  checks.push('Ordinary SQL auto-completion and diagnostics used the ordered script-only catalog and exact added, renamed and dropped index names.');
  checks.push('The real disposable schema matched the supported statements, while the editor alone left the catalog unchanged and blocked physical rename from a script projection.');
  return { ...fields, nativeScriptCompletion: true, physicalActionsGuarded: true };
}

async function verifyActualLiveScriptDdl(runtime) {
  let db, catalog, source, report;
  const open = text => {
    source = text;
    const analysis = analyzeLiveDdlScript(source, catalog);
    report = { ...analysis, scriptCatalog: true, executedSql: false, validityVerified: false };
  };
  return verifyLiveScriptDdl(runtime, {
    async connect(config) { db = new MysqlService(config); catalog = await db.metadata(); },
    async disconnect() { await db?.dispose(); },
    open, edit: open, report: () => report,
    async completion(offset) {
      const part = report.statements.find(item => item.start <= offset && offset <= item.end);
      if (!part || part.contextUncertain) return [];
      const relative = offset - part.start, shadow = part.scriptCatalog;
      const items = completionsAt(part.model, relative);
      if (!shadow) return items;
      return [...items, ...indexHintCompletions(part.model.text, relative, shadow),
        ...await scopedDmlColumns(source, offset, shadow, { ...catalog, catalogComplete: true })];
    }
  });
}

module.exports = { runLiveScriptDdlChecks, verifyActualLiveScriptDdl };
