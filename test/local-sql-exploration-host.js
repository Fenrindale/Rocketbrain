'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { registerGroundedSqlAssistant } = require('../src/db/local-sql-grounding-vscode');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { jdbcReadback } = require('./java-source-analysis-host');
const { fixtures, selectRoute, original, followup, expected } = require('./local-sql-grounding-host');

const section = 'rocketbrain.localSqlAssistant.';
const disposable = { dispose() {} };

function commandHost(model, route) {
  const commands = new Map(), providers = new Map(), responses = [], errors = [], previews = [], documents = [];
  let selectedEdge = 0, documentId = 0;
  const uri = url => ({ scheme: url.protocol.slice(0, -1), query: url.search.slice(1), toString: () => url.href });
  const vscode = {
    Uri: { parse: value => uri(new URL(value)) },
    ProgressLocation: { Notification: 1 },
    commands: { registerCommand(id, action) { commands.set(id, action); return disposable; } },
    workspace: {
      isTrusted: true, getConfiguration: () => ({ get: key => model[key] }),
      onDidChangeConfiguration: () => disposable,
      registerTextDocumentContentProvider(scheme, provider) { providers.set(scheme, provider); return disposable; },
      async openTextDocument(input) {
        const address = input.scheme ? input : uri(new URL('untitled:/Grounded-' + ++documentId + '.sql'));
        const document = { uri: address, version: 1, languageId: input.language ?? 'plaintext', isClosed: false,
          text: input.content ?? providers.get(address.scheme).provideTextDocumentContent(address), getText() { return this.text; } };
        documents.push(document);
        return document;
      }
    },
    window: {
      async showQuickPick(options, { title }) {
        if (title === 'Start a Grounded SQL Query') return route.root;
        if (title === 'Choose the Next Foreign-Key Join') {
          const edgeId = route.edgeIds[selectedEdge++];
          const selected = options.find(item => item.edge?.id === edgeId);
          assert.ok(selected, 'The normal join picker offers the fixture foreign key.');
          return selected;
        }
        if (title.startsWith('Share Selected Columns from ')) {
          const selection = route.selections.find(item => item.table === title.slice('Share Selected Columns from '.length));
          return options.filter(item => selection.columns.includes(item.label));
        }
        if (title === 'Choose a Reviewed Grounded SQL Exploration') return options[0];
        assert.equal(title, 'Review Grounded SQL');
      },
      async showInputBox() { return responses.shift(); },
      async showInformationMessage(_message, options, command) {
        if (command === 'Send to Local Model') previews.push(JSON.parse(options.detail.split('\n\n').at(-1)));
        return command;
      },
      async showErrorMessage(message) { errors.push(message); },
      async showTextDocument(document) { return (this.activeTextEditor = { document }); },
      async withProgress(_options, task) { return task({}, { isCancellationRequested: false, onCancellationRequested: () => disposable }); }
    }
  };
  return { vscode, documents, providers, errors, previews, async invoke(command, input) {
    if (input) responses.push(input);
    assert.ok(commands.has(section + command));
    await commands.get(section + command)();
    assert.deepEqual(errors, []);
  } };
}

async function verifyExploration(config, model) {
  const connection = await mysql.createConnection(config);
  const db = new MysqlService(config);
  const subscriptions = [];
  try {
    await fixtures(connection);
    const catalog = await db.metadata(), route = selectRoute(catalog);
    const host = commandHost(model, route);
    let epoch = 1, invalidated;
    const api = registerGroundedSqlAssistant({ subscriptions }, host.vscode, {
      liveCatalogIdentity: () => ({ connection: 'owned-fixture', epoch, database: catalog.database }),
      liveCatalogSnapshot: () => catalog,
      databaseCatalog: () => db.metadata(), explainGroundedQuery: (...args) => db.explainGroundedQuery(...args),
      onDidChangeDatabase: callback => { invalidated = callback; return disposable; }
    });
    // The first quick pick dismisses the command completely. The next command starts without its previous editor.
    await host.invoke('grounded', original);
    const [first] = api.sessions();
    assert.ok(first, 'The first command made one reviewed exploration available after exiting.');
    assert.equal(first.turns, 1);
    const before = api.transcript(first.id);
    const firstDocument = host.documents.at(-1);
    assert.equal(firstDocument.getText(), before.turns[0].sql + '\n');
    firstDocument.isClosed = true;
    host.vscode.window.activeTextEditor = undefined;
    await assert.rejects(api.stage({ previousId: before.turns[0].id, input: followup }), /reviewed SQL editor changed or closed/);

    await host.invoke('continueGrounded', followup);
    assert.equal(host.documents.length, 3);
    assert.equal(host.documents[1].getText(), firstDocument.getText());
    assert.notEqual(host.documents[1].uri.toString(), firstDocument.uri.toString());
    const after = api.transcript(first.id);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.deepEqual(after.scope, route);
    assert.equal(after.model, model.model);
    assert.equal(after.turns.length, 2);
    assert.deepEqual(after.turns[0], before.turns[0]);
    assert.deepEqual(Object.keys(after.turns[1].changes), ['columns', 'measures', 'sort']);
    assert.ok(after.turns[1].changes.columns.after.includes('rb_grounding_branch.label'));
    assert.deepEqual(after.turns[1].changes.measures.after, [{ function: 'COUNT', column: 'rb_spring_person.id' }]);
    assert.equal(host.documents[2].getText(), after.turns[1].sql + '\n');
    for (const turn of after.turns) assert.equal(turn.digest, createHash('sha256').update(turn.sql).digest('hex'));
    await host.invoke('groundedTranscript');
    const transcript = host.documents.at(-1);
    assert.equal(transcript.uri.scheme, 'rocketbrain-sql-exploration');
    assert.equal(transcript.languageId, 'plaintext');
    assert.match(transcript.getText(), /Plan changes/);
    for (const turn of after.turns) assert.ok(transcript.getText().includes(turn.sql));
    assert.equal(host.previews.length, 2);
    assert.deepEqual(host.previews[0].joins, host.previews[1].joins);
    assert.ok(host.previews[1].previousPlan);
    for (const hidden of [config.password, 'secret_label', 'fixture-private-sentinel', 'North', 'South', original, before.turns[0].sql]) {
      assert.ok(!JSON.stringify(host.previews[1]).includes(hidden));
    }
    assert.equal(Object.hasOwn(host.previews[1].previousPlan, 'explanation'), false);
    await assert.rejects(api.stage({ previousId: after.turns[0].id, input: followup }), /latest reviewed turn/);
    const latest = after.turns[1];
    const contenders = await Promise.allSettled(Array.from({ length: 2 }, () => api.stage({ previousId: latest.id, input: followup })));
    const rejected = contenders.find(item => item.status === 'rejected');
    const staged = contenders.find(item => item.status === 'fulfilled');
    assert.ok(staged && rejected);
    assert.match(rejected.reason.message, /pending request/);
    const editor = host.documents[2];
    editor.version++;
    await assert.rejects(api.draft(staged.value.id, { confirmed: true }), /reviewed SQL editor changed/);
    await assert.rejects(api.resume(first.id), /reviewed SQL editor changed/);
    editor.isClosed = true;
    assert.equal(await api.resume(first.id), latest.id);
    const pending = await api.stage({ previousId: latest.id, input: followup });
    api.discard(pending.id);
    await assert.rejects(api.draft(pending.id, { confirmed: true }), /expired/);

    await db.openSession('default', { readOnly: true });
    const verified = [];
    for (const [index, turn] of after.turns.entries()) {
      const plan = await api.inspect(turn.id, { confirmed: true, digest: turn.digest });
      assert.equal(plan.engine, catalog.dialect);
      assert.equal(Boolean(plan.measured), false);
      const result = await db.query(turn.sql), control = await db.query(expected[index]);
      assert.deepEqual(result.rows, control.rows);
      verified.push({ reviewedTurn: turn.number, rows: result.rows.length, estimatedOperators: plan.nodes.length });
    }

    await connection.query('ALTER TABLE rb_grounding_assignment DROP FOREIGN KEY rb_grounding_branch_fk');
    await assert.rejects(api.resume(first.id), /reviewed key|metadata changed/);
    epoch++;
    await assert.rejects(api.resume(first.id), /database or local model configuration changed/);
    invalidated();
    assert.deepEqual(api.sessions(), []);
    return { engine: catalog.dialect, serverVersion: catalog.serverVersion, model: 'Qwen2.5-Coder-1.5B-Instruct Q4_K_M',
      exitedAndResumedRegisteredCommands: true, reviewedSourceReopened: true, readonlyTranscript: true, planDelta: Object.keys(latest.changes),
      modelMetadataAndTypedPlanOnly: true, verified, changedDraftRefused: true, staleForeignKeyRefused: true,
      changedConnectionRefused: true, ancestorAndConcurrentReplayRefused: true, automaticSelectExecution: false, jdbc: await jdbcReadback() };
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    try {
      await db.dispose();
      await connection.query('DROP TABLE IF EXISTS rb_grounding_assignment');
      await connection.query('DROP TABLE IF EXISTS rb_grounding_branch');
    } finally { await connection.end(); }
  }
}

if (require.main === module) fixtureConfig().then(async config => {
  const model = await startLocalModel();
  try { console.log(JSON.stringify(await verifyExploration(config, model))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { verifyExploration };
