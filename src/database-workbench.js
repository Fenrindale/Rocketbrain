'use strict';

const { DatabaseService } = require('./db/service');
const { MysqlService } = require('./db/mysql');
const { ResultsView } = require('./results');
const { statementAt } = require('./sql');
const { completeSql } = require('./db/completion');
const { TableEditor } = require('./table-editor');
const { relatedRows } = require('./db/related-rows');
const { tableLayoutConnectionKey } = require('./db/result-layouts');
const demoHistoryKey = require('node:crypto').createHash('sha256').update('rocketbrain:sqlite-demo').digest('hex');

async function registerDatabaseWorkbench(context, vscode, ProjectTree, SchemaTree, isVirtualSqlPreview = () => false) {
  const activityLog = require('./db/activity-log-vscode').registerSqlActivity(context, vscode);
  const output = vscode.window.createOutputChannel('Rocketbrain');
  const state = { db: new DatabaseService(), schema: [], metadata:null, profile:null, tableLayoutConnection:undefined, label: 'Offline demo', mysql: false, running: new Set(), connecting: new Set(), switching: false, disposed: false, candidates: new Set(), epoch: 0 };
  const bindings = new Map();
  const schemaMigrations = new Map();
  const schemaRebuilds=new Map(),streamManagers=new Map(),streamReviews=new Map(),streamTransactions=new Map();
  const connectionEvents = new vscode.EventEmitter();
  const completedUserSql = new vscode.EventEmitter();
  context.subscriptions.push(completedUserSql);
  let sequence = 0;
  let tableEditor, transferLease;
  const project = new ProjectTree(), schemaTree = new SchemaTree(state), results = new ResultsView(vscode, context, {
    editAction: (id, message) => tableEditor.handle(id, message),
    relatedAction: chooseRelatedRows,
    datasetAction: (id, input) => tableEditor.stageDatasetChanges(id, input),
    resultClosed: id => tableEditor.forget(id)
  });
  tableEditor = new TableEditor({ results, connection: () => state, withSession, trusted: () => vscode.workspace.isTrusted, onStatus: () => updateStatus() });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  status.command = 'rocketbrain.sessionStatus'; status.show();
  const currentDocument = () => vscode.window.activeTextEditor?.document;
  const existingBinding = () => bindings.get(currentDocument()?.uri.toString());
  function reconcileStreamTransactions(){let removed=false;for(const [id,saved]of streamTransactions){if(!streamManagers.get(saved.db)?.hasPendingTransaction(id)){streamTransactions.delete(id);removed=true;}}if(removed&&!streamTransactions.size)state.running.delete('stream-import');}
  const exclusiveDatabaseWork=()=>{
    reconcileStreamTransactions();
    return ['schema-migration','stream-import','table-transfer','database-admin'].some(key=>state.running.has(key));
  };
  const databaseGuard=(db,epoch)=>()=>vscode.workspace.isTrusted&&!state.disposed&&!state.switching&&state.db===db&&state.epoch===epoch;
  function assertExclusiveReady(){reconcileStreamTransactions();if(!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching)throw new Error('Connect to MySQL or MariaDB in a trusted workspace first.');if(state.running.size||state.connecting.size)throw new Error('Finish the current database operation or pending import transaction first.');}
  function streamFor(db){let manager=streamManagers.get(db);if(!manager){manager=new(require('./db/import-stream').StreamImporter)(db,{onStateChange:()=>{reconcileStreamTransactions();updateStatus();}});streamManagers.set(db,manager);}return manager;}
  async function closeDatabaseResources(db){const manager=streamManagers.get(db);if(manager){await manager.dispose();streamManagers.delete(db);}await db.dispose();}
  async function refreshAfterSchemaAttempt(db,epoch,report){if(state.disposed||db!==state.db||epoch!==state.epoch)return;state.metadata=null;state.schema=[];schemaTree.refresh();connectionEvents.fire({epoch,mysql:true,metadata:null});try{await refreshSchema();if(report)report.metadataRefresh={state:'refreshed'};}catch{if(report)report.metadataRefresh={state:'failed',message:'Refresh database metadata explicitly before further schema work.'};}}
  function updateStatus() {
    const binding = existingBinding();
    const session = state.mysql && binding ? state.db.getSessionState(binding.id) : null;
    const mode = streamTransactions.size ? 'import waiting for Commit or Roll Back' : session ? session.needsReconnect ? 'disconnected · reconnect required' : `${session.readOnly ? 'read only' : session.autocommit ? 'writes · auto commit' : 'writes · manual commit'}${session.inTransaction ? ' · transaction active' : ''}${session.transactionIsolation ? ' · ' + session.transactionIsolation.toLowerCase() : ''}` : state.mysql ? 'new console · read only' : 'SQLite demo';
    status.text = `${state.running.size ? '$(sync~spin)' : '$(database)'} Rocketbrain · ${binding?.id || state.label} · ${mode}`;
    status.command=streamTransactions.size?'rocketbrain.import.stream':'rocketbrain.sessionStatus';
    status.tooltip = `${state.label}\n${mode}\n${streamTransactions.size?'Click to Commit or Roll Back the pending streamed import.':'Each SQL editor uses its own database session. Click for session details.'}`;
    void vscode.commands.executeCommand('setContext', 'rocketbrain.mysqlConnected', state.mysql);
    void vscode.commands.executeCommand('setContext', 'rocketbrain.sqlRunning', state.running.size > 0);
  }
  const command = (id, action) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await action(...args); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); output.appendLine(message); await vscode.window.showErrorMessage(`Rocketbrain: ${message}`); }
    finally { updateStatus(); }
  }));
  async function refreshSchema() {
    if(exclusiveDatabaseWork())throw new Error('Finish the schema operation or pending import transaction before refreshing metadata.');
    if (state.mysql && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before reading database metadata.');
    const { epoch, db } = state;
    const metadata=state.mysql?await db.metadata():null;
    const schema = metadata?[...metadata.tables,...metadata.views]:await db.schema();
    if (epoch === state.epoch && !state.disposed) { state.schema = schema;state.metadata=metadata;schemaTree.refresh();connectionEvents.fire({epoch:state.epoch,mysql:state.mysql,metadata}); }
  }
  const connectionError=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_CONNECTION_CONTEXT'});
  function pendingTableDraft(){return results.history.some(record=>tableEditor.contexts.has(record.id)&&(record.hasDraft||record.review||record.bulkDraft||record.editBusy));}
  async function switchDatabase(next, label, mysql, schema, expectedEpoch = state.epoch,metadata=null,profile=null,tableLayoutConnection) {
    reconcileStreamTransactions();
    if (state.disposed) throw connectionError('The workspace has closed.');
    if (state.running.size || state.connecting.size || state.switching) throw connectionError('Wait for the running query or database switch to finish.');
    if (expectedEpoch !== state.epoch) throw connectionError('The database changed while connecting. Connect again.');
    if(pendingTableDraft())throw connectionError('Apply or discard pending table drafts before changing the database connection.');
    // Switching a connection rolls back its open transactions through closeSession/dispose.
    if (state.mysql && [...bindings.values()].some(binding => { const session = state.db.getSessionState(binding.id); return session.inTransaction || session.outcomeUnknown; })) {
      const choice = await vscode.window.showWarningMessage('Changing the connection closes all console sessions and rolls back uncommitted work. An interrupted write may already have committed; switching does not resolve its outcome.', { modal: true }, 'Roll Back and Switch');
      if (choice !== 'Roll Back and Switch') throw connectionError('The database switch was cancelled.');
    }
    // User interaction above yields; revalidate before changing the active connection.
    if (state.running.size || state.connecting.size || state.switching || expectedEpoch !== state.epoch || state.disposed) throw connectionError('The connection state changed. Try again.');
    if(mysql&&!vscode.workspace.isTrusted)throw connectionError('Trust this workspace before changing the database connection.');
    if(pendingTableDraft())throw connectionError('Apply or discard pending table drafts before changing the database connection.');
    state.switching = true;
    try {
      const knownSchema = schema || await next.schema();
      if (state.disposed || (mysql&&!vscode.workspace.isTrusted)) throw connectionError('The workspace closed or trust changed while connecting.');
      const previous = state.db;
      state.epoch++; state.db = next; state.schema = knownSchema; state.metadata=metadata;state.label = label; state.mysql = mysql;state.profile=profile;
      state.tableLayoutConnection = tableLayoutConnection;
      connectionEvents.fire({ epoch: state.epoch, label: state.label, mysql,metadata });
      bindings.clear();schemaMigrations.clear();schemaRebuilds.clear();streamReviews.clear();streamTransactions.clear(); schemaTree.refresh(); updateStatus();
      await closeDatabaseResources(previous);
    } finally { state.switching = false; }
  }
  async function connectMysql(config) {
    reconcileStreamTransactions();
    if (!vscode.workspace.isTrusted) throw connectionError('Trust this workspace before connecting to a database.');
    if (state.running.size || state.connecting.size || state.switching) throw connectionError('Wait for the current database operation first.');
    const expectedEpoch = state.epoch;
    const next = new MysqlService(config, { reportActivity: activityLog.createReporter() }); state.candidates.add(next);
    try {
      const metadata = await next.metadata();
      const schema = [...metadata.tables,...metadata.views];
      const profile = require('./db/connection-security').connectionProfile(config);
      const layoutConnection = tableLayoutConnectionKey(config, profile);
      await switchDatabase(next, profile ? profile.name+' · '+config.database : `${config.database} @ ${config.host}`,
        true, schema, expectedEpoch, metadata, profile, layoutConnection);
    }
    catch (error) { if (state.db !== next) await next.dispose(); throw error; }
    finally { state.candidates.delete(next); }
  }
  async function bind(document) {
    if(exclusiveDatabaseWork())throw new Error('Finish the schema operation or pending import transaction before using a console.');
    if (!document || document.languageId !== 'sql') throw new Error('Open a SQL editor first.');
    if (state.disposed || state.switching) throw new Error('The database is changing or the workspace has closed.');
    if (state.mysql && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before using a database.');
    const key = document.uri.toString();
    if (!bindings.has(key)) {
      const binding = { id: `console-${++sequence}`, epoch: state.epoch };
      // Install before awaiting so concurrent actions on the editor share the same session.
      bindings.set(key, binding);
      const db = state.db;
      if (state.mysql) {
        state.connecting.add(binding.id);
        binding.ready = db.openSession(binding.id, { readOnly: true }).finally(() => state.connecting.delete(binding.id));
      }
    }
    const bound = bindings.get(key);
    if (bound.ready) {
      try { await bound.ready; }
      catch (error) { if (bindings.get(key) === bound) bindings.delete(key); throw error; }
      finally { delete bound.ready; }
    }
    if (state.epoch !== bound.epoch || state.disposed || bindings.get(key) !== bound) throw new Error('This console changed while connecting. Try again.');
    bound.documentClosed = false;
    updateStatus();
    return bound;
  }
  async function sessionAction(action) {
    if (!state.mysql) throw new Error('Connect to MySQL or MariaDB to use console transactions.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using a database.');
    const document = currentDocument(), binding = await bind(document);
    assertBinding(document, binding);
    return withSession(binding.id, action);
  }
  function assertBinding(document, binding) {
    if (state.disposed || state.switching || binding.epoch !== state.epoch || bindings.get(document.uri.toString()) !== binding) throw new Error('The connection changed. Try this console action again.');
  }
  async function withSession(id, action) {
    if(exclusiveDatabaseWork())throw new Error('Finish the schema operation or pending import transaction before using a console.');
    if (state.disposed || state.switching || !state.mysql) throw new Error('Connect to MySQL or MariaDB first.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using a database.');
    if (state.running.has(id) || state.connecting.has(id)) throw new Error('Cancel or finish the query in this console first.');
    state.running.add(id);
    try { return await action(id); }
    finally { state.running.delete(id); updateStatus(); }
  }
  async function openSql(text) {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    await bind(document); return editor;
  }
  async function inspectRelatedRows(id, selection) {
    const snapshot = tableEditor.relatedSnapshot(id, selection);
    return withSession(snapshot.sessionId, async () => {
      const catalog = await snapshot.db.metadata();
      snapshot.validate();
      return relatedRows(catalog, snapshot.table, snapshot.columns, snapshot.values)
        .map(({ key, label, table, direction, columns }) => ({ key, label, table, direction, columns }));
    });
  }
  async function openRelatedRows(id, selection, key) {
    if (typeof key !== 'string' || key.length > 16384) throw Error('Choose a visible foreign key relation.');
    const snapshot = tableEditor.relatedSnapshot(id, selection);
    return withSession(snapshot.sessionId, async () => {
      const catalog = await snapshot.db.metadata();
      snapshot.validate();
      const match = relatedRows(catalog, snapshot.table, snapshot.columns, snapshot.values).find(item => item.key === key);
      if (!match) throw Error('The foreign key or visible row changed. Choose the relation again.');
      const document = await vscode.workspace.openTextDocument({
        language: 'sql', content: '-- Related rows are fetched by the Results view with bound key values.\n'
      });
      const binding = await bind(document);
      let opened;
      try {
        assertBinding(document, binding);
        snapshot.validate();
        opened = await tableEditor.open({ table:match.table, sessionId:binding.id,
          sql:document.getText(), filters:match.filters });
      } catch (error) {
        if (bindings.get(document.uri.toString()) === binding && snapshot.db === state.db) {
          await state.db.closeSession(binding.id);
          bindings.delete(document.uri.toString());
        }
        throw error;
      }
      await vscode.window.showTextDocument(document, { preview:false, preserveFocus:true });
      return opened;
    });
  }
  async function chooseRelatedRows(id, selection) {
    const matches = await inspectRelatedRows(id, selection);
    if (!matches.length) {
      await vscode.window.showInformationMessage('This row has no navigable foreign keys in the current schema.');
      return;
    }
    const options = matches.map(item => ({ label:item.label,
      description:item.direction === 'referenced' ? 'Referenced rows' : 'Referencing rows',
      detail:item.columns.map(([from,to]) => from + ' → ' + to).join(', '),
      key:item.key }));
    const chosen = await vscode.window.showQuickPick(options, { title:'Open Related Rows' });
    if (chosen) return openRelatedRows(id, selection, chosen.key);
  }
  function savedQueryTarget() {
    return { connectionEpoch:state.epoch, label:state.label, key:state.mysql?state.tableLayoutConnection:demoHistoryKey,
      profile:state.profile?{id:state.profile.id,database:state.profile.database}:null };
  }
  async function runSql(sql, document = currentDocument(), { connectionEpoch, connectionKey, saved = false, userQuery = false, beforeRun } = {}) {
    if (!sql.trim()) return;
    if (state.mysql && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before using a database.');
    if (connectionEpoch !== undefined && (connectionEpoch !== state.epoch ||
        connectionKey !== undefined && connectionKey !== savedQueryTarget().key)) {
      throw new Error('The active database changed. Choose the saved query destination again.');
    }
    const binding = await bind(document);
    assertBinding(document, binding);
    const db = state.db;
    if (state.running.has(binding.id)) throw new Error('This console already has a running query.');
    const session = state.mysql ? db.getSessionState(binding.id) : null;
    const historyTarget = userQuery && !saved && (session?.readOnly ?? true) ? savedQueryTarget() : null;
    if (saved && session && !session.readOnly) throw new Error('Run the saved query in a read-only console.');
    state.running.add(binding.id); updateStatus();
    const source = state.mysql ? `${state.label} · ${binding.id} · ${session.readOnly ? 'read only' : session.autocommit ? 'writes · auto commit' : 'writes · manual commit'}` : 'Offline demo · SQLite · sample data';
    let id;
    try {
      const editor = vscode.window.activeTextEditor;
      await results.show();
      if (editor) await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
      if (saved && (!vscode.workspace.isTrusted || document.isClosed || document.getText() !== sql)) throw new Error('The saved SQL changed or the workspace is unavailable.');
      beforeRun?.();
      id = results.begin(sql, source, { readOnly: session?.readOnly ?? true, sessionId: binding.id });
      results.finish(id, await db.query(sql, { sessionId: binding.id, maxRows: 500, timeoutMs: 5000 }));
      if (historyTarget?.key && vscode.workspace.isTrusted && binding.epoch===state.epoch && db===state.db) {
        completedUserSql.fire({ sql, target:historyTarget });
      }
    } catch (error) {
      if (id) results.finish(id, undefined, error instanceof Error ? error.message : String(error), error.state); else throw error;
    } finally { state.running.delete(binding.id); updateStatus(); }
    return id;
  }
  function selectedSql(editor) {
    if (!editor || editor.document.isClosed || editor.document.languageId !== 'sql') throw new Error('Open a SQL editor first.');
    return editor.selection.isEmpty ? statementAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active), { dialect: state.mysql ? 'mysql' : 'sqlite' }) : editor.document.getText(editor.selection);
  }
  command('rocketbrain.openConsole', async () => {
    await refreshSchema();
    const name = state.schema[0]?.name;
    const sql = state.mysql ? `-- ${state.label}\n-- This editor owns an independent read-only session.\n-- Use Change Console Mode to enable writes; transactions are explicit.\n${name ? `SELECT * FROM \`${name.replace(/`/g, '``')}\` LIMIT 100;` : 'SELECT VERSION() AS server_version;'}` : '-- Offline sample · SQLite\nSELECT * FROM projects;\n\n-- Select SQL or place the cursor in a statement, then press Ctrl+Enter.\n';
    const editor = await openSql(sql); await results.show();
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
  });
  command('rocketbrain.runQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    return runSql(selectedSql(editor), editor.document,{userQuery:true});
  });
  command('rocketbrain.openTable', async name => {
    if (typeof name !== 'string' || !state.schema.some(table => table.name === name)) return;
    const quoted = state.mysql ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"';
    const sql = `SELECT * FROM ${quoted} LIMIT ${state.mysql ? 200 : 100};`; const editor = await openSql(sql);
    if (state.mysql) {
      const binding = await bind(editor.document); assertBinding(editor.document, binding);
      await results.show(); await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
      await tableEditor.open({ table: name, sessionId: binding.id, sql });
    } else await runSql(sql, editor.document);
  });
  command('rocketbrain.refresh', async () => { project.refresh(); await refreshSchema(); });
  const useDemo = async () => {
    const next = new DatabaseService(); state.candidates.add(next);
    try { await switchDatabase(next, 'Offline demo', false); }
    catch (error) { if (state.db !== next) await next.dispose(); throw error; }
    finally { state.candidates.delete(next); }
  };
  command('rocketbrain.useDemo', useDemo); command('rocketbrain.disconnect', useDemo);
  command('rocketbrain.beginTransaction', () => sessionAction(id => state.db.begin({ sessionId: id })));
  command('rocketbrain.commit', () => sessionAction(id => state.db.commit({ sessionId: id })));
  command('rocketbrain.rollback', () => sessionAction(id => state.db.rollback({ sessionId: id })));
  command('rocketbrain.cancelQuery', async () => {
    const binding = existingBinding();
    if (!state.mysql || !binding || !state.running.has(binding.id)) return;
    await state.db.cancel(binding.id);
  });
  command('rocketbrain.reconnectSession', () => sessionAction(async id => {
    const choice = await vscode.window.showWarningMessage('Reconnect starts a new session. Temporary tables, session variables and uncommitted work from the previous connection are lost. An interrupted write may have an unknown outcome; inspect the server before retrying.', { modal: true }, 'Start New Session');
    if (choice === 'Start New Session') await state.db.reconnect(id);
  }));
  command('rocketbrain.sessionStatus', async () => {
    const binding = existingBinding();
    const session = state.mysql && binding ? state.db.getSessionState(binding.id) : null;
    output.appendLine(JSON.stringify({ source: state.label, console: binding?.id, ...(session || { readOnly: true, engine: state.mysql ? 'MySQL/MariaDB — open a console' : 'SQLite demo' }) }, null, 2));
    output.show(true);
  });
  command('rocketbrain.manageSessions', async () => {
    if (!state.mysql) throw new Error('Connect to MySQL or MariaDB first.');
    const epoch = state.epoch;
    const sessions = [...bindings.entries()].map(([key, binding]) => {
      const session = state.db.getSessionState(binding.id);
      return { label: binding.id, description: `${binding.documentClosed ? 'editor closed · ' : ''}${session.readOnly ? 'read only' : 'writes'}${session.inTransaction ? ' · transaction active' : ''}${session.outcomeUnknown ? ' · outcome unknown' : ''}${session.needsReconnect ? ' · reconnect required' : ''}`, key, binding };
    });
    const selected = await vscode.window.showQuickPick(sessions, { title: 'Rocketbrain · Console Sessions', placeHolder: 'Closed editors retain their sessions until you explicitly close them.' });
    if (!selected) return;
    if (epoch !== state.epoch || state.disposed) throw new Error('The connection changed. Open the session list again.');
    await withSession(selected.binding.id, async id => {
      const action = await vscode.window.showQuickPick(['Show State', 'Commit', 'Roll Back', 'Close Session'], { title: id });
      if (action === 'Show State') { output.appendLine(JSON.stringify(state.db.getSessionState(id), null, 2)); output.show(true); }
      else if (action === 'Commit') await state.db.commit({ sessionId: id });
      else if (action === 'Roll Back') await state.db.rollback({ sessionId: id });
      else if (action === 'Close Session') {
        const session = state.db.getSessionState(id);
        if (session.inTransaction || session.outcomeUnknown) {
          const accepted = await vscode.window.showWarningMessage('Closing loses this session and rolls back uncommitted work. A previously interrupted write may already have committed; closing does not resolve its outcome.', { modal: true }, 'Close Session');
          if (accepted !== 'Close Session') return;
        }
        await state.db.closeSession(id); bindings.delete(selected.key);
      }
    });
  });
  command('rocketbrain.consoleMode', () => sessionAction(async id => {
    const choice = await vscode.window.showQuickPick([
      { label: 'Read only', description: 'Reject write SQL in this console', readOnly: true, autocommit: true },
      { label: 'Read/write · manual commit', description: 'Changes remain pending until Commit or Roll Back', readOnly: false, autocommit: false },
      { label: 'Read/write · auto commit', description: 'Each successful write is committed immediately', readOnly: false, autocommit: true }
    ], { title: `${id} · Change Console Mode`, ignoreFocusOut: true });
    if (!choice) return;
    if (!choice.readOnly) {
      const accepted = await vscode.window.showWarningMessage(choice.autocommit ? 'Writes will change the database immediately. DDL can also commit implicitly.' : 'Writes are enabled. Commit or Roll Back to finish a transaction. MySQL/MariaDB DDL can commit implicitly even in manual mode.', { modal: true }, 'Enable Writes');
      if (accepted !== 'Enable Writes') return;
    }
    await state.db.setReadOnly(choice.readOnly, { sessionId: id });
    await state.db.setAutocommit(choice.autocommit, { sessionId: id });
  }));
  command('rocketbrain.connectMysql', async () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to a database.');
    const saved = context.workspaceState.get('rocketbrain.mysqlProfile', {});
    const ask = (prompt, value, extra = {}) => vscode.window.showInputBox({ title: 'MySQL / MariaDB · independent connection', prompt, value, ignoreFocusOut: true, ...extra });
    const host = await ask('Host', saved.host || '127.0.0.1'); if (host === undefined) return;
    const portText = await ask('Port', String(saved.port || 3306), { validateInput: value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? undefined : 'Enter a port between 1 and 65535.' }); if (portText === undefined) return;
    const user = await ask('User', saved.user || ''); if (user === undefined) return;
    const database = await ask('Database', saved.database || ''); if (database === undefined) return;
    if (![host, user, database].every(value => value.trim())) throw new Error('Host, user and database are required.');
    const tls = await vscode.window.showQuickPick([{ label: 'TLS · verify server certificate', value: true }, { label: 'Plain connection · local development only', value: false }], { title: 'Connection encryption', ignoreFocusOut: true }); if (!tls) return;
    const profile = { host: host.trim(), port: Number(portText), user: user.trim(), database: database.trim(), tls: tls.value };
    const secretId = 'rocketbrain.mysql.' + require('node:crypto').createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    const password = await ask('Password · stored in VS Code Secret Storage after a successful connection', await context.secrets.get(secretId) || '', { password: true }); if (password === undefined) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Connecting to MySQL / MariaDB' }, () => connectMysql({ ...profile, password, ssl: tls.value ? { rejectUnauthorized: true } : undefined }));
    await context.secrets.store(secretId, password); await context.workspaceState.update('rocketbrain.mysqlProfile', profile);
  });
  let disposePromise;
  function disposeDatabase(){if(disposePromise)return disposePromise;state.disposed=true;state.epoch++;schemaMigrations.clear();schemaRebuilds.clear();streamReviews.clear();streamTransactions.clear();const databases=new Set([state.db,...state.candidates]);state.candidates.clear();bindings.clear();disposePromise=(async()=>{const settled=await Promise.allSettled([...databases].map(closeDatabaseResources));const failure=settled.find(item=>item.status==='rejected');if(failure)throw failure.reason;})();return disposePromise;}
  context.subscriptions.push(project, schemaTree, output, status, tableEditor, connectionEvents,
    vscode.window.registerTreeDataProvider('rocketbrain.project', project),
    vscode.window.registerTreeDataProvider('rocketbrain.databases', schemaTree),
    vscode.window.registerWebviewViewProvider('rocketbrain.results', results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidCloseTextDocument(document => {
      const binding = bindings.get(document.uri.toString());
      if (!binding) return;
      if (state.mysql) {
        // A document close is not consent to discard a database transaction.
        binding.documentClosed = true;
        output.appendLine(`${binding.id}: editor closed; server session retained. Use Manage Console Sessions to commit, roll back or close it.`);
        if (state.db.getSessionState(binding.id).inTransaction) void vscode.window.showWarningMessage(`${binding.id} retains an open transaction. Use Rocketbrain: Manage Console Sessions to finish it.`);
      } else bindings.delete(document.uri.toString());
      updateStatus();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => project.refresh()),
    vscode.workspace.onDidCreateFiles(() => project.refresh()), vscode.workspace.onDidDeleteFiles(() => project.refresh()), vscode.workspace.onDidRenameFiles(() => project.refresh()),
    vscode.languages.registerCompletionItemProvider('sql', { provideCompletionItems(document, position) {
      if(state.mysql||isVirtualSqlPreview(document))return [];
      // Suggestions use the current statement and metadata; nested SQL name binding remains a later phase.
      const text = document.getText(), offset = document.offsetAt(position);
      const sql = statementAt(text, offset, { dialect: state.mysql ? 'mysql' : 'sqlite' });
      const start = text.lastIndexOf(sql, offset);
      if (!sql || start < 0) return [];
      return completeSql(sql, offset - start, state.schema).map(suggestion => {
        const item = new vscode.CompletionItem(suggestion.label, suggestion.kind === 'table' ? vscode.CompletionItemKind.Struct : vscode.CompletionItemKind.Field);
        item.detail = suggestion.detail; item.insertText = state.mysql ? suggestion.insertText : '"' + suggestion.label.replace(/"/g, '""') + '"';
        return item;
      });
    } }, '.'),
    { dispose() { void disposeDatabase().catch(()=>{}); } }
  );
  await refreshSchema(); updateStatus();
  // Deliberate local extension API for integration callers; credentials are never returned or persisted here.
  return {
    ...require('./db/authoring-facade').authoringFacade({state,assertReady:assertExclusiveReady,pendingDraft:pendingTableDraft,isTrusted:()=>vscode.workspace.isTrusted,sessions:()=>[...bindings.values()].map(binding=>state.db.getSessionState(binding.id)),updateStatus,refresh:refreshAfterSchemaAttempt}),
    dispose:disposeDatabase,disconnectMysql:useDemo,activityLog,activeConnectionProfile:()=>state.profile?structuredClone(state.profile):null,
    schema: () => structuredClone(state.schema),
    catalogSnapshot:()=>state.metadata?structuredClone(state.metadata):null,
    queryDemo: sql => state.mysql ? Promise.reject(new Error('Demo checks require the demo connection.')) : state.db.query(sql),
    source: () => state.label, results: () => structuredClone(results.history), connectMysql,
    exportResult: (id, format, destination) => results.exportSnapshot(id, format, destination),
    analyzeResult: (id, options) => results.analyzeSnapshot(id, options),
    compareDatasets: (targetId, sourceId, mapping) => results.compareDatasets(targetId,sourceId,mapping),
    stageDatasetComparison: (id, input) => results.stageDatasetComparison(id,input),
    savedResultLayout: id => results.savedLayout(id),
    saveResultLayout: (id, modelId, columns) => results.saveLayout(id, modelId, columns),
    inspectRelatedRows, openRelatedRows,
    onDidChangeDatabase: connectionEvents.event,
    onDidCompleteUserSql: completedUserSql.event,
    async withDatabaseAdmin(action,{write=false}={}){
      if(typeof action!=='function')throw Error('Choose a database catalog or privilege operation.');
      assertExclusiveReady();
      if(write&&(pendingTableDraft()||[...bindings.values()].some(binding=>{
        const session=state.db.getSessionState(binding.id);
        return session?.inTransaction||session?.outcomeUnknown||session?.needsReconnect;
      })))throw Error('Resolve console transactions and drafts before changing a database privilege.');
      const {db,epoch}=state,key='database-admin';
      state.running.add(key);
      updateStatus();
      try{
        return await action({db,epoch,guard:databaseGuard(db,epoch)});
      }finally{
        state.running.delete(key);
        updateStatus();
      }
    },
    async withTableTransfer(action,{settling=false}={}){
      const key='table-transfer';
      if(typeof action!=='function')throw Error('Choose a table copy operation.');
      if(settling){
        if(!transferLease||transferLease.busy||state.db!==transferLease.db||state.epoch!==transferLease.epoch||
            !state.mysql||state.disposed||!vscode.workspace.isTrusted)throw Error('The pending table copy is no longer available.');
      }else{
        assertExclusiveReady();
        if(pendingTableDraft()||[...bindings.values()].some(binding=>{
          const session=state.db.getSessionState(binding.id);
          return session?.inTransaction||session?.outcomeUnknown||session?.needsReconnect;
        }))throw Error('Resolve console transactions and drafts before copying a table.');
        transferLease={db:state.db,epoch:state.epoch,busy:false};
        state.running.add(key);
        updateStatus();
      }
      const lease=transferLease;
      lease.busy=true;
      const releasePending=()=>{
        if(transferLease!==lease)return;
        transferLease=undefined;
        state.running.delete(key);
        updateStatus();
      };
      const guard=()=>transferLease===lease&&databaseGuard(lease.db,lease.epoch)()&&!pendingTableDraft();
      let result;
      try{
        result=await action({db:lease.db,epoch:lease.epoch,guard,releasePending});
        return result;
      }finally{
        lease.busy=false;
        if((!settling||result)&&result?.state!=='awaiting-commit')releasePending();
      }
    },
    async withExclusiveSchemaWork(action){
      reconcileStreamTransactions();
      if(typeof action!=='function'||!vscode.workspace.isTrusted||state.disposed||state.switching)throw new Error('Use a trusted open workspace for coordinated schema work.');
      if(state.running.size||state.connecting.size)throw new Error('Finish the current database operation before coordinated schema work.');
      if(state.mysql&&[...bindings.values()].some(binding=>{const session=state.db.getSessionState(binding.id);return session?.inTransaction||session?.outcomeUnknown||session?.needsReconnect;}))throw new Error('Resolve active or uncertain console transactions before coordinated schema work.');
      const {db,epoch}=state,key='schema-migration';state.running.add(key);updateStatus();let report;
      const guard=()=>vscode.workspace.isTrusted&&!state.disposed&&!state.switching&&state.db===db&&state.epoch===epoch;
      try{return report=await action({guard});}finally{state.running.delete(key);updateStatus();if(state.mysql&&guard())await refreshAfterSchemaAttempt(db,epoch,null);}
    },
    async listSchemaPrograms(){
      assertExclusiveReady();const{db,epoch}=state,key='schema-program-analysis';state.running.add(key);updateStatus();
      try{const programs=await db.listSchemaPrograms();if(!databaseGuard(db,epoch)())throw new Error('The database changed while listing stored programs. Inspect again.');return{programs,connectionEpoch:epoch};}finally{state.running.delete(key);updateStatus();}
    },
    async analyzeSchemaPrograms(request={}){
      assertExclusiveReady();const{db,epoch}=state;if(request.connectionEpoch!==undefined&&request.connectionEpoch!==epoch)throw new Error('The procedure selection belongs to an older connection. Inspect again.');
      const key='schema-program-analysis';state.running.add(key);updateStatus();
      try{const input=structuredClone({routines:request.routines,...(request.inputs!==undefined?{inputs:request.inputs}:{}),...(request.sessionVariables!==undefined?{sessionVariables:request.sessionVariables}:{})});const report=await db.analyzeSchemaPrograms(input);if(!databaseGuard(db,epoch)())throw new Error('The database changed during stored-program analysis. Inspect again.');return{...report,connectionEpoch:epoch};}finally{state.running.delete(key);updateStatus();}
    },
    async explainQueryPlan(sql, { cancellation, beforeDispatch, format } = {}) {
      assertExclusiveReady();
      const { db, epoch } = state, key = 'visual-explain';
      const assertCurrent = () => {
        if (cancellation?.isCancellationRequested) throw Error('Visual EXPLAIN was cancelled.');
        if (!databaseGuard(db, epoch)()) throw Error('The database connection changed. Explain the query again.');
      };
      assertCurrent();
      state.running.add(key); updateStatus();
      try {
        const plan = await db.explainQueryPlan(sql, { format, assertCurrent: () => { assertCurrent(); beforeDispatch?.(); } });
        assertCurrent();
        return plan;
      } finally { state.running.delete(key); updateStatus(); }
    },
    async measureQueryPlan(sql, { confirmed, cancellation, beforeDispatch } = {}) {
      if (confirmed !== true) throw Error('Approve execution of the selected read-only SQL before measuring it.');
      assertExclusiveReady();
      const { db, epoch } = state, key = 'visual-explain';
      const assertCurrent = () => {
        if (cancellation?.isCancellationRequested) throw Error('The query measurement was cancelled.');
        if (!databaseGuard(db, epoch)()) throw Error('The database connection changed. Review the query again.');
        beforeDispatch?.();
      };
      state.running.add(key);
      updateStatus();
      try {
        const plan = await db.measureQueryPlan(sql, { assertCurrent, cancellation });
        assertCurrent();
        return plan;
      } finally { state.running.delete(key); updateStatus(); }
    },
    async databaseCatalog() {
      if(exclusiveDatabaseWork())throw new Error('Finish the schema operation or pending import transaction before reading database metadata.');
      if (!state.mysql || state.disposed) throw new Error('Connect to MySQL or MariaDB before comparing JPA mappings.');
      if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before reading database metadata.');
      const { db, epoch } = state;
      const catalog = await db.metadata();
      if (state.db !== db || state.epoch !== epoch || state.disposed) throw new Error('The database changed during metadata inspection. Compare again.');
      return catalog;
    },
    sessionState: () => state.mysql && existingBinding() ? state.db.getSessionState(existingBinding().id) : null,
    sessions: () => state.mysql ? [...bindings.values()].map(binding => ({ ...state.db.getSessionState(binding.id), editorClosed: Boolean(binding.documentClosed) })) : [],
    async inspectConsoleIsolation(document = currentDocument()) {
      if (!state.mysql) throw new Error('Connect to MySQL or MariaDB before choosing an isolation level.');
      if (!document || document.isClosed || document.languageId !== 'sql') throw new Error('Open a SQL editor first.');
      const binding = await bind(document);
      assertBinding(document, binding);
      return withSession(binding.id, async () => ({
        ...await state.db.getTransactionIsolation({ sessionId: binding.id }), connectionEpoch: binding.epoch
      }));
    },
    async setConsoleIsolation(document, level, observed) {
      const binding = document && bindings.get(document.uri.toString());
      if (!binding || document.isClosed || document.languageId !== 'sql' || binding.id !== observed?.id || binding.epoch !== observed?.connectionEpoch) {
        throw new Error('This SQL console changed. Open the isolation picker again.');
      }
      assertBinding(document, binding);
      return withSession(binding.id, async () => {
        const beforeChange = () => {
          if (document.isClosed || !vscode.workspace.isTrusted) throw new Error('This SQL console is unavailable. Open the isolation picker again.');
          assertBinding(document, binding);
          if (pendingTableDraft()) throw new Error('Apply or discard pending table drafts before changing transaction isolation.');
        };
        beforeChange();
        const next = await state.db.setTransactionIsolation(level, {
          sessionId: binding.id, expectedConnectionId: observed.connectionId,
          expectedIsolation: observed.transactionIsolation, beforeChange
        });
        return { ...next, connectionEpoch: binding.epoch };
      });
    },
    selectedSql,
    savedQueryTarget,
    async openSavedQuery(sql, destination, { beforeRun } = {}) {
      if (!vscode.workspace.isTrusted || state.disposed || state.switching) throw new Error('Open a trusted workspace before using saved queries.');
      if (destination && destination.connectionEpoch !== state.epoch) throw new Error('The active database changed. Choose the saved query destination again.');
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
      await vscode.window.showTextDocument(document, { preview: false });
      if (!destination) return { documentUri: document.uri.toString() };
      if (!vscode.workspace.isTrusted || document.isClosed || document.getText() !== sql) throw new Error('The saved SQL changed or the workspace is unavailable.');
      const resultId = await runSql(sql, document, { connectionEpoch:destination.connectionEpoch, connectionKey:destination.key,
        saved:true,beforeRun });
      return { documentUri: document.uri.toString(), resultId };
    },
    tableAction: (id, message) => tableEditor.handle(id, message),
    async describeSqlScript(sql,{document=currentDocument()}={}) {
      if(!state.mysql)throw new Error('Connect to MySQL or MariaDB before running a SQL script.');
      const binding=await bind(document);assertBinding(document,binding);
      return withSession(binding.id,async()=>({...await state.db.describeScript(sql,{sessionId:binding.id}),connectionEpoch:state.epoch,documentUri:document.uri.toString()}));
    },
    async previewSqlScript(sql,{document=currentDocument(),parameters,connectionEpoch,maxRows,timeoutMs,totalTimeoutMs}={}) {
      if(!state.mysql||connectionEpoch!==undefined&&connectionEpoch!==state.epoch)throw new Error('The database connection changed. Prepare the script again.');
      const binding=await bind(document);assertBinding(document,binding);
      return withSession(binding.id,async()=>({...await state.db.previewScript(sql,{sessionId:binding.id,parameters,maxRows,timeoutMs,totalTimeoutMs}),connectionEpoch:state.epoch,documentUri:document.uri.toString()}));
    },
    async runSqlScript(request) {
      if(!state.mysql||request.connectionEpoch!==state.epoch)throw new Error('The database connection changed. Preview the script again.');
      const binding=bindings.get(request.documentUri);
      if(!binding||binding.id!==request.sessionId||binding.epoch!==state.epoch)throw new Error('The SQL console changed. Preview the script again.');
      const db=state.db;return withSession(binding.id,()=>db.runScript({reviewId:request.reviewId,allowImplicitCommit:request.allowImplicitCommit===true,cancellation:request.cancellation}));
    },
    async captureSchemaSnapshot(options={}) {
      if(!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching)throw new Error('Connect to MySQL or MariaDB in a trusted workspace first.');
      if(state.running.size||state.connecting.size)throw new Error('Finish running database operations before capturing a schema snapshot.');
      const {db,epoch}=state,key='schema-snapshot';state.running.add(key);updateStatus();
      try{const snapshot=await require('./db/schema-diff').captureSchema(db,options);if(state.disposed||db!==state.db||epoch!==state.epoch)throw new Error('The database changed while capturing the schema. Capture again.');return snapshot;}finally{state.running.delete(key);updateStatus();}
    },
    async previewSchemaMigration(request) {
      if(!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching)throw new Error('Connect to MySQL or MariaDB in a trusted workspace first.');
      if(state.running.size||state.connecting.size)throw new Error('Finish running database operations before reviewing a schema application.');
      const {db,epoch}=state,key='schema-migration';state.running.add(key);updateStatus();
      try{
        const prepared=await db.previewSchemaMigration(request);
        if(state.disposed||db!==state.db||epoch!==state.epoch||!vscode.workspace.isTrusted){await db.discardSchemaMigration(prepared.reviewId);throw new Error('The database changed while preparing the schema application. Compare again.');}
        while(schemaMigrations.size>=16){const [id,value]=schemaMigrations.entries().next().value;schemaMigrations.delete(id);await value.db.discardSchemaMigration(id);}
        schemaMigrations.set(prepared.reviewId,{db,epoch,expiresAt:prepared.expiresAt});return {...prepared,connectionEpoch:epoch};
      }finally{state.running.delete(key);updateStatus();}
    },
    async applySchemaMigration(request) {
      const saved=schemaMigrations.get(request.reviewId);
      if(!saved||saved.db!==state.db||saved.epoch!==state.epoch||request.connectionEpoch!==state.epoch||!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching)throw new Error('The database or schema review changed. Prepare the migration again.');
      if(request.allowImplicitCommit!==true)throw new Error('Review the SQL and acknowledge possible implicit commits before applying it.');
      if(state.running.size||state.connecting.size)throw new Error('Finish running database operations before applying the reviewed schema.');
      const {db,epoch}=state,key='schema-migration';state.running.add(key);schemaMigrations.delete(request.reviewId);updateStatus();
      let report;
      try{return report=await db.applySchemaMigration({reviewId:request.reviewId,allowImplicitCommit:true,cancellation:request.cancellation,guard:()=>vscode.workspace.isTrusted&&!state.disposed&&!state.switching&&db===state.db&&epoch===state.epoch});}
      finally{
        state.running.delete(key);updateStatus();
        if(!state.disposed&&db===state.db&&epoch===state.epoch){
          state.metadata=null;state.schema=[];schemaTree.refresh();connectionEvents.fire({epoch,mysql:true,metadata:null});
          try{await refreshSchema();if(report)report.metadataRefresh={state:'refreshed'};}catch{if(report)report.metadataRefresh={state:'failed',message:'Refresh database metadata explicitly before further schema work.'};}
        }
      }
    },
    async discardSchemaMigration(reviewId) {const saved=schemaMigrations.get(reviewId);schemaMigrations.delete(reviewId);if(saved)await saved.db.discardSchemaMigration(reviewId);},
    async previewSchemaRebuild(request){
      assertExclusiveReady();const {db,epoch}=state,key='schema-migration';state.running.add(key);updateStatus();
      try{const review=await db.previewSchemaRebuild(request);if(!databaseGuard(db,epoch)()){await db.discardSchemaRebuild(review.reviewId);throw new Error('The connection changed while preparing the rebuild. Compare again.');}while(schemaRebuilds.size>=10){const [id,saved]=schemaRebuilds.entries().next().value;schemaRebuilds.delete(id);await saved.db.discardSchemaRebuild(id);}schemaRebuilds.set(review.reviewId,{db,epoch,requiresDependencies:review.plan?.requiresDependencyChangeApproval===true,requiresLoss:review.plan?.requiresLossyConversionApproval===true,requiresUnverified:review.plan?.requiresUnverifiedDependencyApproval===true});return{...review,connectionEpoch:epoch};}finally{state.running.delete(key);updateStatus();}
    },
    async discardSchemaRebuild(reviewId){const saved=schemaRebuilds.get(reviewId);schemaRebuilds.delete(reviewId);if(saved)await saved.db.discardSchemaRebuild(reviewId);},
    async applySchemaRebuild(request){
      assertExclusiveReady();const saved=schemaRebuilds.get(request.reviewId);if(!saved||saved.db!==state.db||saved.epoch!==state.epoch||request.connectionEpoch!==state.epoch)throw new Error('The rebuild review belongs to an older connection. Compare again.');
      if(request.allowDestructive!==true||request.allowImplicitCommit!==true)throw new Error('Review the exact rebuild SQL, retained backup and destructive/implicit-commit effects before applying.');
      if(saved.requiresDependencies&&request.allowDependencyChanges!==true)throw new Error('Explicitly acknowledge dependency changes and temporary application write guards before applying.');
      if(saved.requiresLoss&&request.allowLossyConversions!==true)throw new Error('Explicitly approve the reviewed lossy conversion policy before applying.');
      if(saved.requiresUnverified&&request.allowUnverifiedDependencies!==true)throw new Error('Explicitly acknowledge the reviewed uninspectable dependency scope before applying.');
      const {db,epoch}=state,key='schema-migration';state.running.add(key);schemaRebuilds.delete(request.reviewId);updateStatus();let report;
      try{return report=await db.applySchemaRebuild({reviewId:request.reviewId,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:request.allowUnverifiedDependencies===true,allowDependencyChanges:request.allowDependencyChanges===true,allowLossyConversions:request.allowLossyConversions===true,autoRecover:request.autoRecover!==false,cancellation:request.cancellation,guard:databaseGuard(db,epoch)});}finally{state.running.delete(key);updateStatus();await refreshAfterSchemaAttempt(db,epoch,report);}
    },
    async listSchemaRecoveries(){assertExclusiveReady();const {db,epoch}=state,key='schema-migration';state.running.add(key);updateStatus();try{const result=await db.listSchemaRecoveries();if(!databaseGuard(db,epoch)())throw new Error('The database changed during recovery inspection.');return{connectionEpoch:epoch,operations:result};}finally{state.running.delete(key);updateStatus();}},
    async recoverSchemaRebuild(request){
      assertExclusiveReady();if(request.connectionEpoch!==state.epoch)throw new Error('Inspect recoverable operations again on the current connection.');const {db,epoch}=state,key='schema-migration';state.running.add(key);updateStatus();let report;
      try{return report=await db.recoverSchemaRebuild({operationId:request.operationId,allowDestructive:request.allowDestructive===true,allowImplicitCommit:request.allowImplicitCommit===true,allowUnverifiedDependencies:request.allowUnverifiedDependencies===true,allowDependencyChanges:request.allowDependencyChanges===true,allowLossyConversions:request.allowLossyConversions===true,cancellation:request.cancellation,guard:databaseGuard(db,epoch)});}finally{state.running.delete(key);updateStatus();await refreshAfterSchemaAttempt(db,epoch,report);}
    },
    async inspectStreamImport(request){assertExclusiveReady();const {db,epoch}=state,key='stream-import';state.running.add(key);updateStatus();try{const result=await streamFor(db).inspect({...request,guard:databaseGuard(db,epoch)});if(!databaseGuard(db,epoch)())throw new Error('The database changed while inspecting the import.');return{...result,connectionEpoch:epoch};}finally{state.running.delete(key);updateStatus();}},
    async prepareStreamImport(request){assertExclusiveReady();if(request.connectionEpoch!==undefined&&request.connectionEpoch!==state.epoch)throw new Error('The import belongs to an older connection. Inspect it again.');const {db,epoch}=state,key='stream-import';state.running.add(key);updateStatus();try{const result=await streamFor(db).prepare({...request,guard:databaseGuard(db,epoch)});if(!databaseGuard(db,epoch)())throw new Error('The connection changed while reviewing the import.');while(streamReviews.size>=10)streamReviews.delete(streamReviews.keys().next().value);streamReviews.set(result.reviewId,{db,epoch});return{...result,connectionEpoch:epoch};}finally{state.running.delete(key);updateStatus();}},
    async runStreamImport(request){
      assertExclusiveReady();const saved=streamReviews.get(request.reviewId);if(!saved||saved.db!==state.db||saved.epoch!==state.epoch||request.connectionEpoch!==state.epoch)throw new Error('Prepare the streaming import again on the current connection.');const {db,epoch}=state,key='stream-import';state.running.add(key);streamReviews.delete(request.reviewId);updateStatus();let pending=false;
      try{const result=await streamFor(db).run({reviewId:request.reviewId,cancellation:request.cancellation,onProgress:request.onProgress,guard:databaseGuard(db,epoch)});if(result.transactionId&&result.state==='awaiting-commit'){streamTransactions.set(result.transactionId,{db,epoch});pending=true;}return{...result,connectionEpoch:epoch};}finally{if(!pending)state.running.delete(key);updateStatus();}
    },
    async commitStreamImport(request){const saved=streamTransactions.get(request.transactionId);if(!saved||saved.db!==state.db||saved.epoch!==state.epoch||request.connectionEpoch!==state.epoch||!databaseGuard(saved.db,saved.epoch)())throw new Error('Choose the current pending import transaction.');const manager=streamFor(saved.db);try{return await manager.commit({transactionId:request.transactionId,guard:databaseGuard(saved.db,saved.epoch)});}finally{if(!manager.hasPendingTransaction(request.transactionId)){streamTransactions.delete(request.transactionId);state.running.delete('stream-import');}updateStatus();}},
    async rollbackStreamImport(request){const saved=streamTransactions.get(request.transactionId);if(!saved||saved.db!==state.db||saved.epoch!==state.epoch)throw new Error('Choose the current pending import transaction.');const manager=streamFor(saved.db);try{return await manager.rollback({transactionId:request.transactionId});}finally{if(!manager.hasPendingTransaction(request.transactionId)){streamTransactions.delete(request.transactionId);state.running.delete('stream-import');}updateStatus();}},
    async discardStreamImport(reviewId){const saved=streamReviews.get(reviewId);streamReviews.delete(reviewId);if(saved)await streamFor(saved.db).discard(reviewId);},
    pendingStreamImports(){reconcileStreamTransactions();return(streamManagers.get(state.db)?.pendingState()||[]).map(report=>({...report,connectionEpoch:state.epoch}));},
    async disposeStreamImports(){const manager=streamManagers.get(state.db);if(manager){await manager.dispose();streamManagers.delete(state.db);}streamReviews.clear();streamTransactions.clear();state.running.delete('stream-import');updateStatus();},
    scriptResultBegin(sql,source,options){return results.begin(sql,source,options);},
    scriptResultFinish(id,result,error,sessionState){results.finish(id,result,error,sessionState);},
    scriptResultRetained: id => results.hasResult(id),
    scriptStatementResult: (id, index) => results.findStatement(id, index),
    activateResult: id => results.activateResult(id),
    setResultTab: (id, settings) => results.setResultTab(id, settings),
    savedResultFilters: id => results.savedFilters(id),
    saveResultFilter: (id, modelId, name) => results.saveFilterPreset(id, modelId, name),
    removeResultFilter: (id, modelId, name) => results.removeFilterPreset(id, modelId, name),
    showResults:()=>results.show(),
    async configureConsoleSession(sessionId,{readOnly,autocommit}={}) {
      if(![...bindings.values()].some(binding=>binding.id===sessionId))throw new Error('Unknown SQL console.');
      return withSession(sessionId,async()=>{if(readOnly!==undefined)await state.db.setReadOnly(readOnly,{sessionId});if(autocommit!==undefined)await state.db.setAutocommit(autocommit,{sessionId});return state.db.getSessionState(sessionId);});
    },
    async controlConsoleSession(sessionId,action) {
      if(![...bindings.values()].some(binding=>binding.id===sessionId)||!['begin','commit','rollback'].includes(action))throw new Error('Choose a managed transaction control for an existing console.');
      return withSession(sessionId,()=>state.db[action]({sessionId}));
    },
    async previewSchemaRename(request) {
      if(exclusiveDatabaseWork())throw new Error('Finish the schema operation or pending import transaction before preparing a rename.');
      if(!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching)throw new Error('Connect to MySQL or MariaDB in a trusted workspace first.');
      const {db,epoch}=state,plan=await db.previewSchemaRename(request);
      if(db!==state.db||epoch!==state.epoch||state.disposed)throw new Error('The database changed while preparing the rename. Preview again.');
      return {...plan,connectionEpoch:epoch};
    },
    async applySchemaRename(request) {
      if(!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching||request.connectionEpoch!==state.epoch)throw new Error('The database connection changed. Preview the rename again.');
      if(state.running.size||state.connecting.size)throw new Error('Finish the current database operations before applying a schema rename.');
      const db=state.db,key='schema-rename';state.running.add(key);updateStatus();
      try{return await db.applySchemaRename({reviewId:request.reviewId,allowUnverifiedDependencies:request.allowUnverifiedDependencies===true});}finally{state.running.delete(key);updateStatus();}
    },
    refreshSchema,
    closeConsoleSession: id => withSession(id, async () => {
      if (![...bindings.values()].some(binding => binding.id === id)) throw new Error('Unknown console session.');
      await state.db.closeSession(id);
      for (const [key, binding] of bindings) if (binding.id === id) bindings.delete(key);
    })
  };
}

module.exports = { registerDatabaseWorkbench };
