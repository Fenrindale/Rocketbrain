'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');
const { MysqlService } = require('../src/db/mysql');
const { missingObjectIntent } = require('../src/db/sql-quick-fixes');

const expectedJdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const flags = { allowImplicitCommit: true, allowDestructive: true, allowDependencyChanges: true,
  allowUnverifiedDependencies: true, autoRecover: true };
const quote = name => '`' + name.replaceAll('`', '``') + '`';

async function prove(adapter, runtime, actor, config) {
  const suffix = randomBytes(5).toString('hex'), fresh = 'rb_intent_new_' + suffix;
  const base = 'rb_intent_base_' + suffix, race = 'rb_intent_race_' + suffix, field = 'measured_amount';
  const inventory = async table => (await actor.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [config.database, table]))[0].length;
  try {
    await actor.query('CREATE TABLE ' + quote(base) + ' (id BIGINT PRIMARY KEY,label VARCHAR(30)) ENGINE=InnoDB');
    await actor.query('INSERT INTO ' + quote(base) + " VALUES (4,'한글')");
    await adapter.connect(config);
    const unresolved = await adapter.action('SELECT 1; SELECT x.id FROM ' + quote(fresh) + ' x', fresh);
    const designed = await adapter.open(unresolved);
    assert.equal(designed?.mode, 'create');
    assert.equal(designed?.draft.name, fresh);
    assert.equal(await inventory(fresh), 0);
    const prepared = await adapter.preview(designed, designed.draft);
    assert.match(prepared.sql, new RegExp('CREATE TABLE .*' + fresh));
    assert.equal(await inventory(fresh), 0);
    assert.equal((await adapter.apply(designed, prepared)).state, 'applied');
    assert.equal(await inventory(fresh), 1);
    await actor.query('INSERT INTO ' + quote(fresh) + ' VALUES (11)');
    const [[created]] = await actor.query('SELECT CAST(id AS CHAR) AS id FROM ' + quote(fresh));
    assert.equal(created.id, '11');

    const missing = await adapter.action('SELECT p.' + quote(field) + ' FROM ' + quote(base) + ' p', field);
    const opened = await adapter.open(missing);
    assert.equal(opened?.mode, 'alter');
    const proposal = opened?.draft.columns.find(column => column.name === field);
    assert.equal(proposal?.type, '');
    await assert.rejects(adapter.preview(opened, opened.draft));
    proposal.type = 'DECIMAL(30,8)';
    const checked = await adapter.preview(opened, opened.draft);
    assert.match(checked.sql, /measured_amount/);
    const [[before]] = await actor.query('SELECT label FROM ' + quote(base));
    assert.equal(before.label, '한글');
    assert.equal((await adapter.apply(opened, checked)).state, 'applied');
    const [[retained]] = await actor.query('SELECT label,measured_amount AS amount FROM ' + quote(base));
    assert.deepEqual([retained.label, retained.amount], ['한글', null]);
    await actor.execute('UPDATE ' + quote(base) + ' SET measured_amount=? WHERE id=4', ['9007199254740993.12500000']);
    const [[exact]] = await actor.query('SELECT CAST(measured_amount AS CHAR) AS amount FROM ' + quote(base));
    assert.equal(exact.amount, '9007199254740993.12500000');

    const changedByPeer = await adapter.action('SELECT * FROM ' + quote(race), race);
    await actor.query('CREATE TABLE ' + quote(race) + ' (id INT PRIMARY KEY) ENGINE=InnoDB');
    await assert.rejects(adapter.open(changedByPeer), /table name already exists/);
    assert.equal(await inventory(race), 1);
    const staleSource = await adapter.recheckDocument?.(fresh);
    assert.deepEqual(await jdbcReadback(), expectedJdbc);
    return { engine: runtime.dbEngine, seededTableDesign: true, selectedSecondStatement: true, exactReviewedCreate: true,
      typedExistingTableColumn: true, explicitTypeRequired: true, retainedRowAndExactDecimal: true, lateCatalogCollisionRefused: true,
      ...(staleSource !== undefined && { staleDocumentRefused: staleSource }), jdbc: expectedJdbc };
  } finally {
    try { await adapter.close(); }
    finally { for (const table of [fresh, base, race]) await actor.query('DROP TABLE IF EXISTS ' + quote(table)); }
  }
}

async function runMissingObjectIntentChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const author = api.dbAuthoring;
  const actionOf = async (source, name) => {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: source });
    const position = document.positionAt(source.indexOf(name) + 1);
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri,
      new vscode.Range(position, position), 'quickfix');
    const action = actions.find(item => item.command?.command === 'rocketbrain.sql.designMissingObject');
    assert.ok(action?.title?.includes(name));
    return { action, document };
  };
  const open = item => vscode.commands.executeCommand(item.action.command.command, ...item.action.command.arguments);
  try {
    const evidence = await prove({
      connect: config => api.connectMysql(config), close: () => api.disconnectMysql(), action: actionOf, open,
      preview: (model, draft) => author.reviewDesigner(model.modelId, draft),
      apply: model => author.applyDesigner(model.modelId, flags),
      async recheckDocument(name) {
        const stale = name + '_editor';
        const item = await actionOf('SELECT * FROM ' + quote(stale), stale);
        const editor = await vscode.window.showTextDocument(item.document);
        await editor.edit(edit => edit.insert(item.document.positionAt(0), '-- changed\n'));
        assert.equal(await open(item), false);
        return true;
      }
    }, runtime, actor, config);
    checks.push('The installed SQL Quick Fix opens the reviewed designer for a live missing table or column. Candidate identity and document version are rechecked before opening.');
    return { ...evidence, version, nativeCodeActions: true };
  } finally { await actor.end(); }
}

async function verifyMissingObjectIntents() {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const db = new MysqlService(config);
  try {
    const evidence = await prove({
      connect: async () => {}, close: () => db.dispose(),
      async action(source, name) {
        const metadata = await db.metadata();
        const action = missingObjectIntent(source,source.indexOf(name)+1,metadata);
        assert.ok(action?.title.includes(name));
        return action;
      },
      open: intent => db.openTableDesigner(intent),
      preview: (model,draft) => db.previewTableDesign({ modelId: model.modelId, draft }),
      apply: (model,review) => db.applyTableDesign({ ...flags, reviewId: review.reviewId })
    }, runtime, actor, config);
    return { ...evidence, version };
  } finally { await actor.end(); }
}

module.exports = { runMissingObjectIntentChecks, verifyMissingObjectIntents };
if (require.main === module) verifyMissingObjectIntents().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
