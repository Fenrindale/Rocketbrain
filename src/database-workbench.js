'use strict';

const { DatabaseService } = require('./db/service');
const { MysqlService } = require('./db/mysql');
const { ResultsView } = require('./results');
const { statementAt } = require('./sql');
const { inspectDmlScope } = require('./db/sql-dml-scope');
const { completeSql } = require('./db/completion');
const { TableEditor } = require('./table-editor');
const { relatedRowsFromObservation } = require('./db/related-rows');
const { crossLogicalKey } = require('./db/cross-schema-logical');
const { keyParameters } = require('./db/sql-related-source');
const { randomUUID } = require('node:crypto');
const { logicalKey, scopeKey, logicalEdges } = require('./db/schema-erd');
const { tableLayoutConnectionKey } = require('./db/result-layouts');
const { createMetadataCache, observeCatalogIdentity } = require('./db/metadata-cache');
const { runCatalogOperation } = require('./db/catalog-refresh');
const demoHistoryKey = require('node:crypto').createHash('sha256').update('rocketbrain:sqlite-demo').digest('hex');

async function registerDatabaseWorkbench(context, vscode, ProjectTree, SchemaTree, isVirtualSqlPreview = () => false, analysisOnlySql = () => false) {
  const { isProfileConsole: isVirtualProfileConsole, registerProfileConsoleFiles } = require('./db/profile-console-files');
  const profileFiles = registerProfileConsoleFiles(vscode, context);
  const fileProfiles = require('./db/sql-file-profiles').createSqlFileProfiles(context.workspaceState);
  const isProfileConsole = document => isVirtualProfileConsole(document) || Boolean(fileProfiles.get(document?.uri));
  const profileSessions = new Map(), profileBindings = new Map();
  const activityLog = require('./db/activity-log-vscode').registerSqlActivity(context, vscode);
  const output = vscode.window.createOutputChannel('Rocketbrain');
  const sqlDrafts = require('./db/console-drafts').registerConsoleDrafts(context, vscode, { profileFiles, output,
    canTrack: document => document.languageId === 'sql' && !document.isClosed && !isVirtualSqlPreview(document) &&
      (isVirtualProfileConsole(document) && profileBindings.has(document.uri.toString()) ||
        document.uri.scheme === 'untitled' && bindings.has(document.uri.toString())) });
  const state = { db: new DatabaseService(), schema: [], metadata:null, profile:null, tableLayoutConnection:undefined, label: 'Offline demo', mysql: false, running: new Set(), connecting: new Set(), switching: false, disposed: false, candidates: new Set(), epoch: 0 };
  const metadataCache = createMetadataCache(context.workspaceState, { isTrusted: () => vscode.workspace.isTrusted && !state.disposed });
  let catalogFingerprints = new Map();
  const cacheScheme = 'rocketbrain-offline-db-metadata';
  const analysisMetadata = () => (vscode.workspace.isTrusted ? state.offlineMetadata?.catalog : undefined) || state.metadata;
  const offlineDocumentsChanged = new vscode.EventEmitter();
  context.subscriptions.push(offlineDocumentsChanged);
  function refreshOfflineDocuments(id) {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === cacheScheme && document.uri.path.split('/')[1] === id) {
        offlineDocumentsChanged.fire(document.uri);
      }
    }
  }
  const bindings = new Map();
  const schemaMigrations = new Map();
  const schemaRebuilds=new Map(),streamManagers=new Map(),streamReviews=new Map(),streamTransactions=new Map();
  const connectionEvents = new vscode.EventEmitter();
  const profileSessionEvents = new vscode.EventEmitter();
  const sqlFileProfileEvents = new vscode.EventEmitter();
  const completedUserSql = new vscode.EventEmitter();
  context.subscriptions.push(completedUserSql, sqlFileProfileEvents);
  let sequence = 0;
  let tableEditor, transferLease;
  const relatedSources = new Map();
  const project = new ProjectTree(), schemaTree = new SchemaTree(state), results = new ResultsView(vscode, context, {
    editAction: (id, message) => tableEditor.handle(id, message),
    relatedAction: chooseRelatedRows,
    relatedReturn: returnToRelatedSource,
    focusQueryEditor,
    canFocusQueryEditor: editor => {
      try { return Boolean(resolveQueryEditor(editor)); } catch { return false; }
    },
    datasetAction: (id, input) => tableEditor.stageDatasetChanges(id, input),
    resultClosed: id => { relatedSources.delete(id); tableEditor.forget(id); }
  });
  tableEditor = new TableEditor({ results, connection: () => state, withSession, trusted: () => vscode.workspace.isTrusted, onStatus: () => updateStatus() });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  status.command = 'rocketbrain.sessionStatus'; status.show();
  const currentDocument = () => vscode.window.activeTextEditor?.document;
  const bindingMap = document => isProfileConsole(document) ? profileBindings : bindings;
  const existingBinding = (document = currentDocument()) => bindingMap(document).get(document?.uri.toString());
  const consoleDatabase = id => {
    const record = profileSessions.get(id);
    if (!record && typeof id === 'string' && id.startsWith('profile-console-')) throw Error('The dedicated database session is closed.');
    return record?.db || state.db;
  };
  const consoleLabel = id => profileSessions.get(id)?.label || state.label;
  const allBindings = () => [...bindings.values(), ...profileBindings.values()];
  const openEditorUris = () => new Set(vscode.window.tabGroups.all.flatMap(group =>
    group.tabs.map(tab => tab.input?.uri?.toString()).filter(Boolean)));
  function resolveQueryEditor({ uri, viewColumn, profileSessionId }) {
    if (state.disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace to return to the query editor.');
    const groups = vscode.window.tabGroups.all;
    const locations = groups.filter(group => group.tabs.some(tab => tab.input?.uri?.toString() === uri));
    const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri);
    if (!locations.length || !document || document.isClosed || document.languageId !== 'sql' || isVirtualSqlPreview(document)) {
      throw Error('The source SQL editor is no longer open.');
    }
    if (profileSessionId && (existingBinding(document)?.id !== profileSessionId || !profileSessions.has(profileSessionId))) {
      throw Error('The source SQL editor no longer uses this result’s database profile session.');
    }
    const group = locations.find(location => location.viewColumn === viewColumn) ?? locations[0];
    return { document, viewColumn: group.viewColumn };
  }
  async function focusQueryEditor(editor) {
    const { document, viewColumn } = resolveQueryEditor(editor);
    await vscode.window.showTextDocument(document, { viewColumn, preserveFocus: false });
  }
  function consoleSessions() {
    const sessions = new Map();
    const open = openEditorUris();
    const bound = state.mysql ? [...bindings, ...profileBindings] : profileBindings;
    for (const [uri, binding] of bound) {
      let session = sessions.get(binding.id);
      if (!session) {
        session = { ...consoleDatabase(binding.id).getSessionState(binding.id), editorCount: 0, openEditors: 0 };
        if (profileSessions.has(binding.id)) session.profile = profileSessions.get(binding.id).profile;
        sessions.set(binding.id, session);
      }
      session.editorCount++;
      if (open.has(uri)) session.openEditors++;
    }
    return [...sessions.values()].map(session => ({ ...session, editorClosed: session.openEditors === 0 }));
  }
  function profileSessionList() {
    if (state.disposed || !vscode.workspace.isTrusted || !profileSessions.size) return [];
    const open = openEditorUris();
    return [...profileSessions].map(([id, record]) => {
      const session = record.db.getSessionState(id), editors = linkedEditors(id);
      return { id, profileId: record.profile.id, connected: session.connected, readOnly: session.readOnly,
        inTransaction: session.inTransaction, outcomeUnknown: session.outcomeUnknown, needsReconnect: session.needsReconnect,
        busy: state.running.has(id) || state.connecting.has(id), linkedEditors: editors.length,
        openEditors: editors.filter(binding => open.has(binding.uri.toString())).length };
    });
  }
  let lastProfileState = '[]';
  function publishProfileSessions() {
    const next = JSON.stringify(profileSessionList());
    if (lastProfileState === next) return;
    lastProfileState = next;
    profileSessionEvents.fire();
  }
  function linkedEditors(id) {
    return allBindings().filter(binding => binding.id === id);
  }
  function reconcileStreamTransactions(){let removed=false;for(const [id,saved]of streamTransactions){if(!streamManagers.get(saved.db)?.hasPendingTransaction(id)){streamTransactions.delete(id);removed=true;}}if(removed&&!streamTransactions.size)state.running.delete('stream-import');}
  const exclusiveDatabaseWork=()=>{
    reconcileStreamTransactions();
    return ['schema-migration','stream-import','table-transfer','database-admin','native-dump','metadata-refresh'].some(key=>state.running.has(key));
  };
  const databaseGuard=(db,epoch)=>()=>vscode.workspace.isTrusted&&!state.disposed&&!state.switching&&state.db===db&&state.epoch===epoch;
  function assertExclusiveReady(){reconcileStreamTransactions();if(!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching)throw new Error('Connect to MySQL or MariaDB in a trusted workspace first.');if(state.running.size||state.connecting.size)throw new Error('Finish the current database operation or pending import transaction first.');}
  function streamFor(db){let manager=streamManagers.get(db);if(!manager){manager=new(require('./db/import-stream').StreamImporter)(db,{onStateChange:()=>{reconcileStreamTransactions();updateStatus();}});streamManagers.set(db,manager);}return manager;}
  async function closeDatabaseResources(db){const manager=streamManagers.get(db);if(manager){await manager.dispose();streamManagers.delete(db);}await db.dispose();}
  async function refreshAfterSchemaAttempt(db,epoch,report){if(state.disposed||db!==state.db||epoch!==state.epoch)return;state.metadata=null;state.schema=[];schemaTree.refresh();connectionEvents.fire({epoch,mysql:true,metadata:null});try{await refreshSchema();if(report)report.metadataRefresh={state:'refreshed'};}catch{if(report)report.metadataRefresh={state:'failed',message:'Refresh database metadata explicitly before further schema work.'};}}
  function updateStatus() {
    const document = currentDocument(), dedicated = isProfileConsole(document);
    const binding = existingBinding(document);
    const session = (state.mysql || dedicated) && binding ? consoleDatabase(binding.id).getSessionState(binding.id) : null;
    const shared = session && linkedEditors(binding.id).length > 1;
    const mode = sqlDrafts.isRecovered(document) ? 'offline SQL draft' : streamTransactions.size ? 'import waiting for Commit or Roll Back' : session ? session.needsReconnect ? (session.lifecycle?.disconnectedByIdleTimeout ? 'idle timeout · reconnect required' : 'disconnected · reconnect required') : `${session.readOnly ? 'read only' : session.autocommit ? 'writes · auto commit' : 'writes · manual commit'}${session.inTransaction ? ' · transaction active' : ''}${session.transactionIsolation ? ' · ' + session.transactionIsolation.toLowerCase() : ''}` : dedicated ? 'profile session closed' : state.mysql ? 'new console · read only' : 'SQLite demo';
    const cached = !dedicated && state.offlineMetadata?.provenance;
    const label = sqlDrafts.isRecovered(document) ? 'Recovered draft' : dedicated && !binding ?
      fileProfiles.get(document?.uri)?.label || 'Dedicated profile' : consoleLabel(binding?.id);
    status.text = cached ? '$(database) Rocketbrain · ' + cached.database + ' · cached metadata' :
      `${state.running.size ? '$(sync~spin)' : '$(database)'} Rocketbrain · ${dedicated && binding ? label : binding?.id || label}${shared ? ' · shared' : ''} · ${mode}`;
    status.command=streamTransactions.size?'rocketbrain.import.stream':cached?'rocketbrain.db.openCachedMetadata':'rocketbrain.sessionStatus';
    status.tooltip = cached ? 'Offline analysis · captured ' + cached.capturedAt + '\nConnect to use live SQL.' :
      `${label}\n${mode}\n${streamTransactions.size ? 'Click to Commit or Roll Back the pending streamed import.' : shared ? 'All linked editors use this session and its transaction. Click for session details.' : 'Click for session details.'}`;
    void vscode.commands.executeCommand('setContext', 'rocketbrain.mysqlConnected', state.mysql);
    void vscode.commands.executeCommand('setContext', 'rocketbrain.offlineMetadataActive', Boolean(state.offlineMetadata));
    void vscode.commands.executeCommand('setContext', 'rocketbrain.profileConsole', dedicated);
    void vscode.commands.executeCommand('setContext', 'rocketbrain.sqlRunning', state.running.size > 0);
    publishProfileSessions();
  }
  const command = (id, action) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await action(...args); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); output.appendLine(message); await vscode.window.showErrorMessage(`Rocketbrain: ${message}`); }
    finally { updateStatus(); }
  }));
  const resultSnapshots=require('./db/result-snapshots').registerResultSnapshots(context,vscode,results,command);
  const gridReviewRecovery=require('./db/table-edit-recovery').registerGridReviewRecovery(context,vscode,tableEditor,results,command);
  const dataExtractors = require('./db/data-extractor-vscode').registerDataExtractors(context, vscode, command, results);
  let datasetProfileSource;
  const datasetWorkflows = require('./db/dataset-workflow-vscode').registerDatasetWorkflows(context, vscode, command, {
    profileSource: () => datasetProfileSource,
    tableNames: () => { assertExclusiveReady(); return state.schema.filter(item => item.kind === 'table').map(item => item.name); },
    async withConnection(action) {
      assertExclusiveReady();
      if (state.offlineMetadata) throw Error('Use the live catalog before replaying a saved comparison.');
      const { db, epoch } = state, key = 'dataset-workflow';
      state.running.add(key); updateStatus();
      try { return await action({ db, guard: databaseGuard(db, epoch) }); }
      finally { state.running.delete(key); updateStatus(); }
    },
    openTargets: name => results.history.filter(record => tableEditor.contexts.get(record.id)?.db === state.db &&
      results.exportable(record) && !record.readOnly && record.result.edit?.canEdit && record.result.edit.table === name)
      .map(record => ({ id: record.id, label: record.label })),
    async stage(id, reconcile) {
      const record = results.history.find(item => item.id === id);
      const target = record?.result, table = tableEditor.contexts.get(id), epoch = state.epoch;
      const assertCurrent = db => {
        if (!databaseGuard(db, epoch)() || table?.db !== db || tableEditor.contexts.get(id) !== table ||
            !results.history.includes(record) || record.result !== target || record.state !== 'done' || record.closing ||
            record.readOnly || record.hasDraft || record.review || record.sessionState?.outcomeUnknown) {
          throw Error('Open the destination in the current editable table grid before staging.');
        }
      };
      if (record?.editBusy) throw Error('Wait for the current table operation.');
      assertCurrent(state.db);
      const { changes, exactDeletes, assertFresh } = await reconcile(target, assertCurrent);
      await tableEditor.stageDatasetChanges(id, { changes, assertFresh, modelId: target.edit.modelId, draftRevision: record.draftRevision || 0,
        exactDeletes,
        editMessage: 'The selected destination operations are staged from the saved comparison. Review SQL, Apply, then Commit or Roll Back.' });
      await results.show();
    }
  });
  async function verifySavedMetadata(db, id, catalog, current) {
    try {
      if (!id || !current() || !metadataCache.has(id)) return;
      const identity = await observeCatalogIdentity(db, catalog);
      const outcome = await metadataCache.revalidate(id, identity, catalog, current);
      if (outcome === 'matched' || outcome === 'invalidated') refreshOfflineDocuments(id);
    } catch { output.appendLine('The saved metadata could not be checked against the live connection.'); }
  }
  async function captureOfflineMetadata() {
    return readCatalogOperation(async ({ db, current, id }) => {
      const catalog = await db.metadata();
      const identity = await observeCatalogIdentity(db, catalog);
      const saved = await metadataCache.capture(id, identity, catalog, current);
      refreshOfflineDocuments(saved.id);
      return saved;
    }, true);
  }
  function publishOfflineSelection(value) {
    state.offlineMetadata = value;
    connectionEvents.fire({ epoch: state.epoch, mysql: false, metadata: analysisMetadata() });
    updateStatus();
  }
  function openOfflineMetadata(id, fingerprint) {
    if (state.mysql || state.switching || state.running.size) throw Error('Disconnect the database and finish any running query before opening offline metadata.');
    const value = metadataCache.open(id, fingerprint);
    publishOfflineSelection(value);
    return value.provenance;
  }
  function closeOfflineMetadata() {
    if (!state.offlineMetadata) return false;
    publishOfflineSelection(undefined);
    return true;
  }
  async function removeOfflineMetadata(id, fingerprint) {
    await metadataCache.remove(id, fingerprint);
    if (state.offlineMetadata?.provenance.id === id) closeOfflineMetadata();
    refreshOfflineDocuments(id);
  }
  async function pickOfflineMetadata(title) {
    const choices = metadataCache.list().map(item => {
      const age = Math.max(0, Math.floor((Date.now() - Date.parse(item.capturedAt)) / 3600000));
      return { label: item.database, description: item.dialect + ' ' + item.serverVersion + ' · captured ' + item.capturedAt,
        detail: item.tables + ' tables · ' + item.views + ' views · connection ' + item.id.slice(0, 10) +
          (age ? ' · ' + age + ' h old' : ' · less than 1 h old'), item };
    });
    if (!choices.length) throw Error('Save metadata from a live database connection first.');
    return (await vscode.window.showQuickPick(choices, { title }))?.item;
  }
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(cacheScheme, {
    onDidChange: offlineDocumentsChanged.event,
    provideTextDocumentContent(uri) {
      try {
        const [, id, fingerprint] = uri.path.split('/');
        const { catalog, provenance } = metadataCache.open(id, fingerprint);
        return ['Cached database metadata', provenance.database + ' · ' + provenance.dialect + ' ' + provenance.serverVersion,
          'Captured at ' + provenance.capturedAt, 'Last matched live at ' + provenance.checkedAt,
          'Offline reference for the observed account. Live schema and query validity are unverified.',
          ...[...catalog.tables, ...catalog.views].flatMap(object => ['', object.kind + ' ' + JSON.stringify(object.name),
            ...object.columns.map(column => '  ' + JSON.stringify(column.name) + '  ' + column.type +
              (column.nullable ? '  NULL' : '  NOT NULL') + (column.primaryKey ? '  PK' : ''))])].join('\n');
      } catch { return 'This saved metadata snapshot is unavailable.'; }
    }
  }));
  command('rocketbrain.db.cacheMetadata', async () => {
    const saved = await captureOfflineMetadata();
    await vscode.window.showInformationMessage('Saved offline database metadata for ' + saved.database + '.');
    return saved;
  });
  command('rocketbrain.db.openCachedMetadata', async () => {
    const item = await pickOfflineMetadata('Open Cached Database Metadata');
    if (!item) return;
    const opened = openOfflineMetadata(item.id, item.fingerprint);
    const uri = vscode.Uri.from({ scheme: cacheScheme, path: '/' + item.id + '/' + item.fingerprint + '/catalog.txt' });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    return opened;
  });
  command('rocketbrain.db.closeCachedMetadata', closeOfflineMetadata);
  command('rocketbrain.db.removeCachedMetadata', async () => {
    const item = await pickOfflineMetadata('Remove Saved Database Metadata');
    if (!item || await vscode.window.showWarningMessage('Remove saved metadata for ' + item.database + '?',
      { modal: true }, 'Remove Saved Metadata') !== 'Remove Saved Metadata') return;
    await removeOfflineMetadata(item.id, item.fingerprint);
  });
  const nativeDumps = require('./db/native-dump').createNativeDumps(context.workspaceState, async (action, { write = false } = {}) => {
    assertExclusiveReady();
    if (write && (pendingTableDraft() || [...bindings.values()].some(binding => {
      const session = state.db.getSessionState(binding.id);
      return session.inTransaction || session.outcomeUnknown;
    }))) throw Error('Finish pending drafts and transactions before restoring a native database backup.');
    const { db, epoch } = state, key = 'native-dump';
    state.running.add(key); updateStatus();
    try { return await action({ db, epoch, guard: databaseGuard(db, epoch) }); }
    finally {
      state.running.delete(key);
      updateStatus();
      if (write) await refreshAfterSchemaAttempt(db, epoch);
    }
  });
  require('./db/native-dump-vscode').registerNativeDumpCommands(vscode, command, nativeDumps);
  async function readCatalogOperation(action, needsMysql = false) {
    return runCatalogOperation(state, action, {
      needsMysql, trusted: () => vscode.workspace.isTrusted, busy: exclusiveDatabaseWork, assertReady: assertExclusiveReady, updateStatus
    });
  }
  function publishCatalog(metadata, schema) {
    state.schema = schema;
    state.metadata = metadata;
    schemaTree.refresh();
    connectionEvents.fire({ epoch: state.epoch, mysql: state.mysql, metadata: analysisMetadata() });
  }
  function refreshSchema() {
    return readCatalogOperation(async ({ db, mysql, id, current, assertCurrent }) => {
      const metadata = mysql ? await db.metadata() : null;
      const schema = metadata ? [...metadata.tables, ...metadata.views] : await db.schema();
      assertCurrent();
      catalogFingerprints.clear();
      publishCatalog(metadata, schema);
      if (metadata) await verifySavedMetadata(db, id, metadata, () => current() && state.metadata === metadata);
    });
  }
  function refreshLiveObjects(names) {
    return readCatalogOperation(async ({ db, id, before, current, assertCurrent }) => {
      const { catalog, report, fingerprints, processed } = await db.refreshCatalog({
        before, names, fingerprints: catalogFingerprints, assertCurrent
      });
      assertCurrent();
      catalogFingerprints = fingerprints;
      publishCatalog(catalog, [...catalog.tables, ...catalog.views]);
      if (id && metadataCache.has(id)) {
        try {
          const identity = await observeCatalogIdentity(db, catalog);
          if (await metadataCache.revalidateObjects(id, identity, catalog, processed, () => current() && state.metadata === catalog) === 'invalidated') {
            refreshOfflineDocuments(id);
          }
        } catch { output.appendLine('The saved metadata could not be checked against the refreshed objects.'); }
      }
      return report;
    }, true);
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
      catalogFingerprints.clear();
      state.tableLayoutConnection = tableLayoutConnection;
      state.offlineMetadata = undefined;
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
    const next = new MysqlService(config, { reportActivity: activityLog.createReporter(), reportSession: updateStatus }); state.candidates.add(next);
    try {
      const metadata = await next.metadata();
      const schema = [...metadata.tables,...metadata.views];
      const profile = require('./db/connection-security').connectionProfile(config);
      const layoutConnection = tableLayoutConnectionKey(config, profile);
      const endpoint = require('./db/local-transport').transportLabel(config.transport) || config.host;
      await switchDatabase(next, profile ? profile.name+' · '+config.database : `${config.database} @ ${endpoint}`,
        true, schema, expectedEpoch, metadata, profile, layoutConnection);
      const current = databaseGuard(next, expectedEpoch + 1);
      await verifySavedMetadata(next, layoutConnection, metadata, () => current() && state.metadata === metadata);
    }
    catch (error) { if (state.db !== next) await next.dispose(); throw error; }
    finally { state.candidates.delete(next); }
  }
  async function bind(document) {
    assertNotEventDraft(document);
    if(exclusiveDatabaseWork())throw new Error('Finish the schema operation or pending import transaction before using a console.');
    if (!document || document.languageId !== 'sql') throw new Error('Open a SQL editor first.');
    if (sqlDrafts.isRecovered(document)) throw Error('Open the active database console to run SQL from an offline draft.');
    assertFileRouteIdle(document);
    if (isProfileConsole(document)) throw Error('This operation uses the active database. Use Run Selected SQL in a profile console.');
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
    const document = currentDocument();
    if (!state.mysql && !isProfileConsole(document)) throw new Error('Connect to MySQL or MariaDB to use console transactions.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using a database.');
    const binding = await bindInteractive(document);
    assertBinding(document, binding);
    return withSession(binding.id, action);
  }
  async function bindInteractive(document) {
    if (sqlDrafts.isRecovered(document)) throw Error('This is an offline SQL draft. Copy the reviewed text to a console connected to the intended database.');
    assertFileRouteIdle(document);
    if (!isProfileConsole(document)) return bind(document);
    if (exclusiveDatabaseWork()) throw Error('Finish the schema operation or pending import transaction before using a console.');
    const binding = existingBinding(document);
    if (!binding || document.isClosed || document.languageId !== 'sql') {
      if (fileProfiles.get(document?.uri)) throw Error('The saved file’s profile session is closed. Use Bind SQL File to Database Profile to choose a live session.');
      throw Error('Open a new dedicated console from its database profile.');
    }
    binding.documentClosed = false;
    return binding;
  }
  function assertBinding(document, binding) {
    assertFileRouteIdle(document);
    const current = isProfileConsole(document) ? profileSessions.has(binding.id) : binding.epoch === state.epoch;
    if (state.disposed || state.switching || !current || existingBinding(document) !== binding) throw new Error('The connection changed. Try this console action again.');
  }
  async function withSession(id, action) {
    if(exclusiveDatabaseWork())throw new Error('Finish the schema operation or pending import transaction before using a console.');
    if (state.disposed || state.switching || (!state.mysql && !profileSessions.has(id))) throw new Error('Connect to MySQL or MariaDB first.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using a database.');
    if (state.running.has(id) || state.connecting.has(id)) throw new Error('Cancel or finish the query in this console first.');
    state.running.add(id);
    publishProfileSessions();
    try { return await action(id, consoleDatabase(id)); }
    finally { state.running.delete(id); updateStatus(); }
  }
  async function openSql(text) {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    await bind(document); return editor;
  }
  async function openProfileEditor(id, text, assertSource = () => {}) {
    const record = profileSessions.get(id);
    if (!record) throw Error('Open a new dedicated console from its database profile.');
    const uri = profileFiles.create(record.label, text);
    const key = uri.toString();
    const binding = { id, uri, epoch: record.epoch };
    profileBindings.set(key, binding);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (state.disposed || profileSessions.get(id) !== record || !vscode.workspace.isTrusted) throw Error('The profile console changed while opening.');
      assertSource();
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      assertBinding(document, binding);
      assertSource();
      binding.documentClosed = false;
      return editor;
    } catch (error) {
      profileBindings.delete(key);
      profileFiles.remove(uri);
      throw error;
    }
  }
  async function openProfileConsole(config) {
    if (!vscode.workspace.isTrusted || state.disposed || state.switching) throw connectionError('Trust this open workspace before opening a profile console.');
    if (exclusiveDatabaseWork()) throw connectionError('Finish the current database operation before opening a profile console.');
    if (profileSessions.size + state.connecting.size >= 12) throw connectionError('Close an unused profile console before opening another.');
    const profile = require('./db/connection-security').connectionProfile(config);
    if (!profile?.id) throw connectionError('Choose a saved database profile.');
    const label = profile.name + ' · ' + config.database;
    const db = new MysqlService(config, { reportActivity: activityLog.createReporter(), reportSession: updateStatus });
    const epoch = ++sequence, id = 'profile-console-' + epoch;
    const endpoint = profile.transport?.kind || `${profile.host || config.host}:${profile.port || config.port || 3306}`;
    const record = { db, epoch, label, endpoint, routeKey: tableLayoutConnectionKey(config, profile),
      profile: { id: profile.id, name: profile.name, database: config.database } };
    state.connecting.add(id);
    state.candidates.add(db);
    try {
      await db.openSession(id, { readOnly: true });
      if (!vscode.workspace.isTrusted || state.disposed || state.switching) throw connectionError('The workspace changed while opening the profile console.');
      profileSessions.set(id, record);
      const editor = await openProfileEditor(id, '-- Dedicated profile: ' + label.replace(/[\r\n]/g, ' ') + '\nSELECT DATABASE() AS current_schema;\n');
      return { sessionId: id, uri: editor.document.uri.toString(), profile: { ...record.profile } };
    } catch (error) {
      profileSessions.delete(id);
      await db.dispose();
      throw error;
    } finally {
      state.connecting.delete(id);
      state.candidates.delete(db);
      updateStatus();
    }
  }
  function requireProfileSession(selection) {
    const record = profileSessions.get(selection?.sessionId);
    if (!record || record.profile.id !== selection?.profileId || !vscode.workspace.isTrusted ||
        state.disposed || state.switching) throw Error('The selected profile session is no longer available. Refresh Database Connections.');
    return record;
  }
  function assertFileRouteIdle(document) {
    if (fileProfiles.busy(document?.uri)) throw Error('Finish changing the SQL file’s database profile first.');
  }
  function requireSqlFile(document) {
    if (!vscode.workspace.isTrusted || state.disposed || state.switching || !document || document.isClosed ||
        document.languageId !== 'sql' || document.uri.scheme !== 'file' || !/\.sql$/i.test(document.uri.path) ||
        !vscode.workspace.getWorkspaceFolder(document.uri) || analysisOnlySql(document)) {
      throw Error('Open a saved SQL file in the trusted workspace before changing its profile.');
    }
    assertFileRouteIdle(document);
  }
  function liveFileDestination(selection) {
    const record = requireProfileSession(selection);
    const session = record.db.getSessionState(selection.sessionId);
    if (!record.routeKey || !session.connected || session.needsReconnect || session.outcomeUnknown ||
        state.running.has(selection.sessionId) || state.connecting.has(selection.sessionId)) {
      throw Error('Choose a connected dedicated profile session with a known transaction state.');
    }
    return { record, session };
  }
  async function changeSqlFileProfile(document, selection, confirm) {
    requireSqlFile(document);
    const uri = document.uri, key = uri.toString(), version = document.version;
    const before = fileProfiles.get(uri), binding = existingBinding(document);
    if (!selection && !before) throw Error('This SQL file has no dedicated database profile.');
    const destination = selection && liveFileDestination(selection);
    const route = destination && { id: destination.record.profile.id, key: destination.record.routeKey, label: destination.record.label };
    const approve = await confirm?.({ path: vscode.workspace.asRelativePath(uri), before: before?.label,
      after: route?.label, endpoint: destination?.record.endpoint, routeChanged: before && route && before.key !== route.key,
      readOnly: destination?.session.readOnly, inTransaction: destination?.session.inTransaction });
    if (approve !== true) return { state: 'retained' };
    requireSqlFile(document);
    const latest = selection && liveFileDestination(selection);
    const sameSession = ({ connectionId, readOnly, autocommit, inTransaction }) =>
      [connectionId, readOnly, autocommit, inTransaction].join('/');
    if (document.version !== version || document.uri.toString() !== key ||
        fileProfiles.get(uri) !== before || existingBinding(document) !== binding ||
        (destination && (latest.record !== destination.record || sameSession(latest.session) !== sameSession(destination.session)))) {
      throw Error('The SQL file or selected database session changed. Review the profile again.');
    }
    if (binding && (state.running.has(binding.id) || state.connecting.has(binding.id))) {
      throw Error('Finish the current SQL operation before changing this file’s profile.');
    }
    const unsharedActive = binding && bindings.get(key) === binding && linkedEditors(binding.id).length === 1 && state.mysql;
    if (unsharedActive) {
      const session = state.db.getSessionState(binding.id);
      if (session.inTransaction || session.outcomeUnknown) throw Error('Resolve this file’s active transaction before changing its profile.');
      // Reserve the old session during persistence. Detaching the sole ordinary editor releases it.
      state.running.add(binding.id);
    }
    try {
      await fileProfiles.set(uri, route);
      if (binding === bindings.get(key)) bindings.delete(key);
      if (binding === profileBindings.get(key)) profileBindings.delete(key);
      if (unsharedActive) await state.db.closeSession(binding.id);
      if (!destination) return { state: 'forgotten', uri: key };
      const current = liveFileDestination(selection);
      const { record } = current;
      if (record !== destination.record || document.isClosed || sameSession(current.session) !== sameSession(destination.session)) {
        throw Error('The profile association was saved. Reopen the SQL file and choose its live session again.');
      }
      profileBindings.set(key, { id: selection.sessionId, uri, epoch: record.epoch });
      return { state: 'bound', uri: key, profileId: route.id, sessionId: selection.sessionId };
    } finally {
      if (unsharedActive) state.running.delete(binding.id);
      if (fileProfiles.get(uri) !== before) sqlFileProfileEvents.fire(document);
      updateStatus();
    }
  }
  command('rocketbrain.connections.bindSqlFile', async () => {
    const document = currentDocument();
    requireSqlFile(document);
    const choices = profileSessionList().filter(row => row.connected && !row.needsReconnect && !row.outcomeUnknown)
      .map(row => ({ label: profileSessions.get(row.id).label, description: row.id,
        detail: row.readOnly ? 'Read only' : row.inTransaction ? 'Writes · transaction active' : 'Writes enabled',
        target: { sessionId: row.id, profileId: row.profileId } }));
    if (!choices.length) throw Error('Open a dedicated console for the intended database profile first.');
    const selected = await vscode.window.showQuickPick(choices, { title: 'Choose the Database Session for This SQL File' });
    if (!selected) return;
    return changeSqlFileProfile(document, selected.target, async ({ path, before, after, endpoint, routeChanged, readOnly, inTransaction }) =>
      await vscode.window.showWarningMessage('Bind this SQL file to the selected database session?', { modal: true,
        detail: `${path}\n${before ? 'Previous association: ' + before + '\n' : ''}Destination: ${after} · ${endpoint}\n` +
          (routeChanged ? 'The selected connection differs from the remembered destination.\n' : '') +
          (readOnly ? 'The selected session is read only.' : inTransaction ?
            'This file will use the selected session’s open write transaction.' : 'Writes are enabled in the selected session.') }, 'Bind Database Profile') === 'Bind Database Profile');
  });
  command('rocketbrain.connections.forgetSqlFile', () => changeSqlFileProfile(currentDocument(), undefined, async ({ path, before }) =>
    await vscode.window.showWarningMessage('Remove this SQL file’s database association?', { modal: true,
      detail: `${path}\nDatabase: ${before}\nFuture queries can use the active database. The dedicated session stays open.` },
    'Remove Association') === 'Remove Association'));
  async function revealProfileSession(selection) {
    const record = requireProfileSession(selection);
    const editors = linkedEditors(selection.sessionId), open = openEditorUris();
    const active = currentDocument()?.uri.toString();
    const entry = editors.find(binding => binding.uri.toString() === active) ??
      editors.find(binding => open.has(binding.uri.toString())) ?? editors[0];
    if (!entry) throw Error('No SQL editor is associated with this profile session.');
    const document = await vscode.workspace.openTextDocument(entry.uri);
    if (requireProfileSession(selection) !== record) throw Error('The profile session changed while opening its editor.');
    assertBinding(document, entry);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    assertBinding(editor.document, entry);
    entry.documentClosed = false;
    publishProfileSessions();
    return { sessionId: selection.sessionId, uri: editor.document.uri.toString() };
  }
  async function inspectProfileSessionCatalog(selection) {
    const record = requireProfileSession(selection);
    return withSession(selection.sessionId, async () => {
      const session = record.db.getSessionState(selection.sessionId);
      if (!session.connected || session.needsReconnect || session.outcomeUnknown) {
        throw Error('Resolve the selected profile session before opening its catalog.');
      }
      const catalog = await record.db.metadata();
      if (requireProfileSession(selection) !== record || catalog.database !== record.profile.database) {
        throw Error('The profile session changed during catalog inspection.');
      }
      return { profile: { ...record.profile }, catalog };
    });
  }
  async function closeProfileSession(selection, confirm) {
    const record = requireProfileSession(selection);
    return withSession(selection.sessionId, async id => {
      const { inTransaction, outcomeUnknown } = record.db.getSessionState(id);
      const editorCount = linkedEditors(id).length;
      if ((inTransaction || outcomeUnknown || editorCount > 1) &&
          await confirm?.({ inTransaction, outcomeUnknown, editorCount }) !== true) {
        return { state: 'retained' };
      }
      if (requireProfileSession(selection) !== record) throw Error('The profile session changed before closing.');
      if (!outcomeUnknown && record.db.getSessionState(id).outcomeUnknown) return { state: 'retained' };
      await closeConsoleBindings(id);
      return { state: 'closed' };
    });
  }
  async function openSharedConsole(source) {
    if (!state.mysql && !isProfileConsole(source)) throw Error('Connect to MySQL or MariaDB before opening a shared console.');
    if (!source || source.isClosed || source.languageId !== 'sql' || isVirtualSqlPreview(source)) {
      throw Error('Open the SQL console whose session you want to share.');
    }
    const binding = await bindInteractive(source);
    assertBinding(source, binding);
    return withSession(binding.id, async (id, db) => {
      const session = db.getSessionState(id);
      if (!session.connected || session.needsReconnect || session.outcomeUnknown) {
        throw Error('Resolve the console connection or its uncertain transaction before sharing it.');
      }
      const content = `-- Shares ${id} and its transaction with the source console.\nSELECT CONNECTION_ID() AS connection_id;\n`;
      const assertSource = () => {
        assertBinding(source, binding);
        if (source.isClosed || !vscode.workspace.isTrusted || db.getSessionState(id).connectionId !== session.connectionId) {
          throw Error('The source console changed. Open a shared console again.');
        }
      };
      if (isProfileConsole(source)) return openProfileEditor(id, content, assertSource);
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
      assertSource();
      if (document.isClosed) throw Error('The new console closed while opening.');
      const key = document.uri.toString();
      if (bindings.has(key)) throw Error('The new console already has a session.');
      bindings.set(key, { id, epoch: binding.epoch });
      try {
        return await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        bindings.delete(key);
        throw error;
      }
    });
  }
  async function closeConsoleBindings(id) {
    const target = profileSessions.get(id);
    if (target) {
      profileSessions.delete(id);
      for (const [key, binding] of profileBindings) {
        if (binding.id !== id) continue;
        profileBindings.delete(key);
        if (binding.documentClosed && isVirtualProfileConsole({ uri: binding.uri })) profileFiles.remove(binding.uri);
      }
      return target.db.dispose();
    }
    await state.db.closeSession(id);
    for (const [key, binding] of bindings) if (binding.id === id) bindings.delete(key);
  }
  function savedLogicalRelationships(database, collection = logicalKey) {
    const scope = scopeKey({ database }, state.profile);
    const saved = scope && context.workspaceState.get(collection, []);
    return Array.isArray(saved) && saved.length <= 24 ? saved.find(record => record?.identity === scope)?.value : undefined;
  }
  async function relatedChoices(snapshot) {
    await snapshot.recheck?.();
    const records = savedLogicalRelationships(snapshot.schema);
    const logical = records?.length ? logicalEdges(await snapshot.db.metadata(), records) : [];
    const crossLogical = savedLogicalRelationships(state.profile?.database, crossLogicalKey) || [];
    const catalog = await snapshot.db.relatedRowsCatalog({ schema: snapshot.schema, table: snapshot.table, logical, crossLogical });
    const crossServer = catalog.edges.find(edge => edge.sourceServer)?.sourceServer;
    if (crossServer && (snapshot.server ? snapshot.server !== crossServer
      : !await snapshot.db.matchesRelatedRoute(snapshot.sessionId, crossServer))) {
      catalog.edges = catalog.edges.filter(edge => !edge.sourceServer);
    }
    snapshot.validate();
    return relatedRowsFromObservation(catalog, snapshot.columns, snapshot.values, snapshot.definitions);
  }
  function relateSqlResult(id, sqlSource, result, db, binding, document, version) {
    const rowIds = result.rows.map((row, index) => {
      try { keyParameters(sqlSource, row); return String(index); }
      catch { return null; }
    });
    if (!rowIds.some(rowId => rowId !== null)) return;
    const modelId = randomUUID();
    relatedSources.set(id, { sqlSource, result, db, binding, document, version, modelId, rowIds });
    return { modelId, rowIds };
  }
  function relatedSnapshot(id, selection) {
    const retained = relatedSources.get(id);
    if (!retained) return tableEditor.relatedSnapshot(id, selection);
    const { sqlSource, result, db, binding, document, version, modelId, rowIds } = retained;
    const record = results.history.find(item => item.id === id), index = rowIds.indexOf(selection?.rowId);
    const validate = () => {
      if (!record || !results.history.includes(record) || record.result !== result || record.closing || record.state !== 'done' ||
          relatedSources.get(id) !== retained || index < 0 || typeof selection?.rowId !== 'string' || selection.modelId !== modelId ||
          !databaseGuard(db, binding.epoch)() || document.isClosed || document.version !== version ||
          !db.canFollowSqlResult(binding.id, result.state.connectionId)) {
        throw Error('The captured SQL row, editor or connection changed. Run the query again.');
      }
      assertBinding(document, binding);
    };
    validate();
    const row = result.rows[index];
    return { db, sessionId: binding.id, schema: sqlSource.schema, table: sqlSource.table,
      columns: sqlSource.columns, values: row, definitions: sqlSource.definitions, validate,
      server: sqlSource.server, recheck: () => db.recheckSqlRowSource({ source: sqlSource, row }) };
  }
  async function inspectRelatedRows(id, selection) {
    const snapshot = relatedSnapshot(id, selection);
    return withSession(snapshot.sessionId, async () => {
      return (await relatedChoices(snapshot)).map(({ filters, keys, sourceServer, ...match }) => match);
    });
  }
  async function openRelatedRows(id, selection, key) {
    if (typeof key !== 'string' || key.length > 16384) throw Error('Choose a visible foreign key relation.');
    const snapshot = relatedSnapshot(id, selection);
    return withSession(snapshot.sessionId, async () => {
      const match = (await relatedChoices(snapshot)).find(item => item.key === key);
      if (!match) throw Error('The foreign key or visible row changed. Choose the relation again.');
      const document = await vscode.workspace.openTextDocument({
        language: 'sql', content: '-- Related rows are fetched by the Results view with bound key values.\n'
      });
      const binding = await bind(document);
      let opened;
      try {
        assertBinding(document, binding);
        snapshot.validate();
        await snapshot.recheck?.();
        snapshot.validate();
        opened = await tableEditor.open({ table:match.table, sessionId:binding.id,
          sql:document.getText(), filters:match.filters,
          relation: { schema: match.schema, keys: match.keys, sourceServer: snapshot.server || match.sourceServer,
            origin: { id, modelId: selection.modelId, rowId: selection.rowId } } });
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
  async function returnToRelatedSource(id) {
    const origin = results.history.find(record => record.id === id && !record.closing)?.relatedOrigin;
    if (!origin) throw Error('This preview has no retained source row.');
    const snapshot = relatedSnapshot(origin.id, origin);
    await results.show();
    snapshot.validate();
    await results.activateResult(origin.id, origin);
    return { resultId: origin.id, rowId: origin.rowId };
  }
  async function chooseRelatedRows(id, selection) {
    const matches = await inspectRelatedRows(id, selection);
    if (!matches.length) {
      await vscode.window.showInformationMessage('This row has no relationship with visible tables and usable key values.');
      return;
    }
    const options = matches.map(item => ({ label:item.label,
      description:(item.direction === 'referenced' ? 'Referenced rows' : 'Referencing rows') + (item.kind === 'logical' ? ' · Logical relationship' : ''),
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
    assertRunnable(document);
    const dedicated = isProfileConsole(document);
    if (dedicated && (saved || connectionEpoch !== undefined || connectionKey !== undefined || !userQuery)) {
      throw Error('Use Run Selected SQL in a profile console.');
    }
    if (userQuery && require('./db/federated-select').isFederatedDocument(document)) throw Error('Use Run Federated SELECT to choose both source profiles.');
    if (!dedicated && state.offlineMetadata) throw Error('Connect to run SQL, or close cached metadata to use the SQLite demo.');
    const documentVersion = document?.version;
    if ((state.mysql || dedicated) && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before using a database.');
    if (connectionEpoch !== undefined && (connectionEpoch !== state.epoch ||
        connectionKey !== undefined && connectionKey !== savedQueryTarget().key)) {
      throw new Error('The active database changed. Choose the saved query destination again.');
    }
    const binding = await bindInteractive(document);
    assertBinding(document, binding);
    assertRunnable(document);
    if (!dedicated && state.offlineMetadata) throw Error('The database switched to offline metadata. Connect before running SQL.');
    const db = consoleDatabase(binding.id);
    if (state.running.has(binding.id)) throw new Error('This console already has a running query.');
    const session = state.mysql || dedicated ? db.getSessionState(binding.id) : null;
    const historyTarget = userQuery && !saved && !dedicated && (session?.readOnly ?? true) ? savedQueryTarget() : null;
    if (saved && session && !session.readOnly) throw new Error('Run the saved query in a read-only console.');
    state.running.add(binding.id); updateStatus();
    const source = session ? `${consoleLabel(binding.id)} · ${binding.id} · ${session.readOnly ? 'read only' : session.autocommit ? 'writes · auto commit' : 'writes · manual commit'}` : 'Offline demo · SQLite · sample data';
    let id;
    try {
      const scope = session && !session.readOnly ? inspectDmlScope(sql) : undefined;
      const allowUnboundedDml = scope && !scope.hasWhere;
      if (allowUnboundedDml) {
        const action = 'Run ' + scope.command;
        const accepted = await vscode.window.showWarningMessage(scope.command + ' has no outer WHERE clause.', {
          modal:true,
          detail:source + '\n' + (scope.hasLimit ? 'The statement has a LIMIT but does not filter rows with WHERE.'
            : 'The statement may affect every row in the target tables.')
        }, action);
        if (accepted !== action) return;
      }
      const editor = vscode.window.activeTextEditor;
      await results.show();
      if (editor && (!dedicated || editor.document === document && vscode.window.activeTextEditor === editor)) {
        await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
      }
      if (saved && (!vscode.workspace.isTrusted || document.isClosed || document.getText() !== sql)) throw new Error('The saved SQL changed or the workspace is unavailable.');
      beforeRun?.();
      if (allowUnboundedDml || dedicated) {
        assertBinding(document, binding);
        if (document.isClosed || document.version !== documentVersion || !vscode.workspace.isTrusted) {
          throw Error('The SQL source changed after review. Run it again.');
        }
      }
      id = results.begin(sql, source, { readOnly: session?.readOnly ?? true, sessionId: binding.id,
        ...(document?.languageId === 'sql' && { queryEditor: { uri: document.uri.toString(),
          viewColumn: editor?.document === document ? editor.viewColumn : undefined,
          ...(dedicated && { profileSessionId: binding.id }) } }) });
      const result = await db.query(sql, { sessionId: binding.id, maxRows: 500, timeoutMs: 5000, allowUnboundedDml });
      if (historyTarget && session?.readOnly && document && !document.isClosed && document.version === documentVersion) {
        let sqlSource;
        try { sqlSource = await db.captureSqlRowSource(sql, result, binding.id); }
        catch { /* The user query already completed. Missing provenance only disables related navigation. */ }
        if (sqlSource && document.version === documentVersion && !document.isClosed && databaseGuard(db, binding.epoch)()) {
          const relatedRows = relateSqlResult(id, sqlSource, result, db, binding, document, documentVersion);
          if (relatedRows) result.relatedRows = relatedRows;
        }
      }
      results.finish(id, result);
      if (historyTarget?.key && vscode.workspace.isTrusted && binding.epoch===state.epoch && db===state.db) {
        completedUserSql.fire({ sql, target:historyTarget });
      }
    } catch (error) {
      if (id) results.finish(id, undefined, error instanceof Error ? error.message : String(error), error.state); else throw error;
    } finally { state.running.delete(binding.id); updateStatus(); }
    return id;
  }
  function assertNotEventDraft(document) {
    if (require('./db/object-editor-vscode').isEventSourceDraft(document)) throw Error('Use Review Database Object Source to edit a scheduled event.');
  }
  function assertRunnable(document) {
    assertNotEventDraft(document);
    if (analysisOnlySql(document)) throw Error('Exit the saved virtual schema preview before running SQL from this editor.');
  }
  function selectedSql(editor, { allowProfile = false } = {}) {
    if (!editor || editor.document.isClosed || editor.document.languageId !== 'sql') throw new Error('Open a SQL editor first.');
    assertRunnable(editor.document);
    if (!allowProfile && isProfileConsole(editor.document)) throw Error('This operation requires a console on the active database.');
    return editor.selection.isEmpty ? statementAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active), { dialect: state.mysql || isProfileConsole(editor.document) ? 'mysql' : 'sqlite' }) : editor.document.getText(editor.selection);
  }
  function sqlActionContext(document) {
    if (document?.languageId !== 'sql' || document.isClosed) return null;
    const route = fileProfiles.get(document.uri);
    const dedicated = isProfileConsole(document);
    const binding = existingBinding(document);
    const consoleOpen = Boolean(binding && profileSessions.has(binding.id));
    const session = binding && (consoleOpen || state.mysql && !dedicated) && !state.disposed && !state.switching ?
      consoleDatabase(binding.id).getSessionState(binding.id) : undefined;
    const fileProfileChanging = fileProfiles.busy(document.uri);
    const analysis = analysisOnlySql(document) || isVirtualSqlPreview(document);
    const edit = !analysis && !require('./db/object-editor-vscode').isEventSourceDraft(document);
    const operational = edit && !state.disposed && !state.switching && !fileProfileChanging && !state.running.has(binding?.id) &&
      !sqlDrafts.isRecovered(document) &&
      !require('./db/federated-select').isFederatedDocument(document);
    const live = operational && !dedicated && state.mysql && !state.offlineMetadata && vscode.workspace.isTrusted;
    const run = operational && (dedicated ? vscode.workspace.isTrusted && (Boolean(route) || consoleOpen) :
      !state.offlineMetadata && (vscode.workspace.isTrusted || !state.mysql));
    return { run, edit, live, offlineDemo: !dedicated && !state.mysql && !state.offlineMetadata,
      epoch: state.epoch, binding: binding?.id, profile: route?.id, profileRevision: route?.key,
      session: session && { connection: session.connectionId, schema: session.database, readOnly: session.readOnly,
        autocommit: session.autocommit, inTransaction: session.inTransaction, outcomeUnknown: session.outcomeUnknown,
        needsReconnect: session.needsReconnect } };
  }
  command('rocketbrain.openConsole', async () => {
    if (state.offlineMetadata) {
      return openSql('-- Offline SQL editing · ' + state.offlineMetadata.provenance.database + '\n-- Connect to run SQL.\n');
    }
    await refreshSchema();
    const name = state.schema[0]?.name;
    const sql = state.mysql ? `-- ${state.label}\n-- This editor owns an independent read-only session.\n-- Use Change Console Mode to enable writes; transactions are explicit.\n${name ? `SELECT * FROM \`${name.replace(/`/g, '``')}\` LIMIT 100;` : 'SELECT VERSION() AS server_version;'}` : '-- Offline sample · SQLite\nSELECT * FROM projects;\n\n-- Select SQL or place the cursor in a statement, then press Ctrl+Enter.\n';
    const editor = await openSql(sql); await results.show();
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
  });
  command('rocketbrain.openSharedConsole', () => openSharedConsole(currentDocument()));
  command('rocketbrain.focusQueryResults', () => results.focus());
  command('rocketbrain.focusQueryEditor', () => results.returnToQuery());
  command('rocketbrain.showQueryResults', () => results.show());
  command('rocketbrain.results.returnToQuery', expected => results.returnToQuery(results.requireActionTarget(expected).id));
  command('rocketbrain.results.copyTsv', expected => {
    if (!vscode.workspace.isTrusted) throw Error('Trust the workspace before copying a result from Context Actions.');
    return results.copyResult(results.requireActionTarget(expected));
  });
  command('rocketbrain.runQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    if (sqlDrafts.isRecovered(editor?.document)) {
      void vscode.window.showInformationMessage('This is an offline SQL draft. Copy the reviewed text to a console connected to the intended database.');
      return;
    }
    assertRunnable(editor?.document);
    const dedicated = isProfileConsole(editor?.document);
    if ((state.mysql || dedicated) && editor?.document.languageId === 'sql' &&
        /^\uFEFF?[ \t]*DELIMITER(?=[ \t\r]|$)/im.test(editor.document.getText())) {
      if (dedicated) throw Error('DELIMITER calls and reviewed scripts use the active database console.');
      const {document,selection}=editor;
      const version=document.version;
      const epoch=state.epoch;
      const result=await vscode.commands.executeCommand('rocketbrain.sql.runClientStatement', {
        uri:document.uri.toString(),version,offset:document.offsetAt(selection.active),
        ...(!selection.isEmpty && {selection:{start:document.offsetAt(selection.start),end:document.offsetAt(selection.end)}})
      });
      if (!result?.useDirectSelection) return result;
      if (document.isClosed || document.version !== version) throw Error('The selected SQL changed. Select it again.');
      if (state.epoch !== epoch) throw Error('The SQL connection changed. Select the statement again.');
      return runSql(document.getText(selection),document,{userQuery:true});
    }
    return runSql(selectedSql(editor, {allowProfile:true}), editor.document,{userQuery:true});
  });
  command('rocketbrain.openTable', async name => {
    if (state.offlineMetadata) throw Error('Connect to preview table rows while using cached metadata.');
    if (typeof name !== 'string' || !state.schema.some(table => table.name === name)) return;
    const quoted = state.mysql ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"';
    const sql = `SELECT * FROM ${quoted} LIMIT ${state.mysql ? 200 : 100};`; const editor = await openSql(sql);
    if (state.mysql) {
      const binding = await bind(editor.document); assertBinding(editor.document, binding);
      await results.show(); await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
      await tableEditor.open({ table: name, sessionId: binding.id, sql });
    } else await runSql(sql, editor.document);
  });
  async function openTableSnapshot(name, options) {
    if (!state.mysql || state.offlineMetadata || state.switching || !vscode.workspace.isTrusted) {
      throw Error('Connect to MySQL or MariaDB in a trusted workspace before opening a table snapshot.');
    }
    if (!state.schema.some(table => table.name === name && table.kind === 'table')) {
      throw Error('Choose a table from the active database.');
    }
    const { db, epoch } = state;
    await results.show();
    if (state.db !== db || state.epoch !== epoch || state.switching) throw Error('The active database changed. Open the table snapshot again.');
    return tableEditor.openKeyset({ table: name, options });
  }
  command('rocketbrain.openTableSnapshot', async item => {
    const name = typeof item === 'string' ? item : item?.table?.name;
    const selected = name ?? await vscode.window.showQuickPick(state.schema.filter(table => table.kind === 'table').map(table => table.name),
      { title: 'Choose a Table for a Read Snapshot' });
    if (selected) return openTableSnapshot(selected);
  });
  command('rocketbrain.refresh', async () => { project.refresh(); await refreshSchema(); });
  function describeRefresh(report) {
    const detail = report.refreshed.length + ' refreshed · ' + report.unchanged.length + ' unchanged · ' +
      (report.removedFromView.length + report.notVisible.length) + ' not visible to this account';
    if (report.failed.length || !report.triggerMetadataAvailable || report.routineMetadataAvailable === false) {
      const problems = report.failed.map(item => item.name).slice(0, 12).join(', ');
      void vscode.window.showWarningMessage('Metadata refresh · ' + detail + ' · coverage incomplete' + (problems ? ' · ' + problems : ''));
    } else if (report.definitionsUnavailable.length) {
      void vscode.window.showInformationMessage('Metadata refresh · ' + detail + ' · some source definitions were unavailable');
    } else void vscode.window.showInformationMessage('Metadata refresh · ' + detail);
    return report;
  }
  command('rocketbrain.db.refreshIncrementalMetadata', async () => describeRefresh(await refreshLiveObjects()));
  command('rocketbrain.db.refreshObjectMetadata', async input => {
    let names = input?.table?.name ? [input.table.name] : input?.names;
    if (!names) {
      const epoch = state.epoch;
      const chosen = await vscode.window.showQuickPick(state.schema.map(object => ({ label: object.name, description: object.kind })),
        { title: 'Refresh Selected Table or View Metadata', canPickMany: true });
      if (!chosen?.length) return;
      if (epoch !== state.epoch) throw Error('The connection changed. Choose the objects again.');
      names = chosen.map(item => item.label);
    }
    return describeRefresh(await refreshLiveObjects(names));
  });
  const useDemo = async () => {
    const next = new DatabaseService(); state.candidates.add(next);
    try { await switchDatabase(next, 'Offline demo', false); }
    catch (error) { if (state.db !== next) await next.dispose(); throw error; }
    finally { state.candidates.delete(next); }
  };
  command('rocketbrain.useDemo', useDemo); command('rocketbrain.disconnect', useDemo);
  command('rocketbrain.beginTransaction', () => sessionAction((id, db) => db.begin({ sessionId: id })));
  command('rocketbrain.commit', () => sessionAction((id, db) => db.commit({ sessionId: id })));
  command('rocketbrain.rollback', () => sessionAction((id, db) => db.rollback({ sessionId: id })));
  command('rocketbrain.cancelQuery', async () => {
    const binding = existingBinding();
    if (!binding || (!state.mysql && !profileSessions.has(binding.id)) || !state.running.has(binding.id)) return;
    await consoleDatabase(binding.id).cancel(binding.id);
  });
  command('rocketbrain.reconnectSession', () => sessionAction(async (id, db) => {
    const choice = await vscode.window.showWarningMessage('Reconnect starts a new session. Temporary tables, session variables and uncommitted work from the previous connection are lost. An interrupted write may have an unknown outcome; inspect the server before retrying.', { modal: true }, 'Start New Session');
    if (choice === 'Start New Session' && vscode.workspace.isTrusted) await db.reconnect(id);
  }));
  command('rocketbrain.sessionStatus', async () => {
    if (state.offlineMetadata && !isProfileConsole(currentDocument())) {
      const { database, capturedAt, checkedAt } = state.offlineMetadata.provenance;
      output.appendLine('Offline metadata · ' + database + ' · captured ' + capturedAt + ' · last matched ' + checkedAt);
      output.show(true);
      return;
    }
    const binding = existingBinding();
    const session = binding ? consoleSessions().find(item => item.id === binding.id) : null;
    output.appendLine(JSON.stringify({ source: consoleLabel(binding?.id), console: binding?.id, ...(session || { readOnly: true, engine: state.mysql || isProfileConsole(currentDocument()) ? 'MySQL/MariaDB — open a console' : 'SQLite demo' }) }, null, 2));
    output.show(true);
  });
  command('rocketbrain.manageSessions', async () => {
    if (!state.mysql && !profileSessions.size) throw new Error('Connect to MySQL or MariaDB first.');
    const epoch = state.epoch;
    const sessions = consoleSessions().map(session => ({
      label: session.id,
      detail: consoleLabel(session.id),
      description: `${session.editorCount > 1 ? session.openEditors + ' open / ' + session.editorCount + ' linked editors · ' : session.editorClosed ? 'editor closed · ' : ''}${session.readOnly ? 'read only' : 'writes'}${session.inTransaction ? ' · transaction active' : ''}${session.outcomeUnknown ? ' · outcome unknown' : ''}${session.needsReconnect ? ' · reconnect required' : ''}`
    }));
    const selected = await vscode.window.showQuickPick(sessions, { title: 'Rocketbrain · Console Sessions', placeHolder: 'Closed editors retain their sessions until you explicitly close them.' });
    if (!selected) return;
    if (epoch !== state.epoch || state.disposed || !linkedEditors(selected.label).length) throw new Error('The connection or session changed. Open the session list again.');
    await withSession(selected.label, async (id, db) => {
      const action = await vscode.window.showQuickPick(['Show State', 'Commit', 'Roll Back', 'Close Session'], { title: id });
      if (!vscode.workspace.isTrusted || state.disposed) return;
      if (action === 'Show State') { output.appendLine(JSON.stringify(db.getSessionState(id), null, 2)); output.show(true); }
      else if (action === 'Commit') await db.commit({ sessionId: id });
      else if (action === 'Roll Back') await db.rollback({ sessionId: id });
      else if (action === 'Close Session') {
        const session = db.getSessionState(id);
        const editorCount = linkedEditors(id).length;
        if (session.inTransaction || session.outcomeUnknown || editorCount > 1) {
          const detail = editorCount > 1 ? `This closes the session for all ${editorCount} linked editors. ` : '';
          const accepted = await vscode.window.showWarningMessage(detail + 'Closing loses this session and rolls back uncommitted work. A previously interrupted write may already have committed; closing does not resolve its outcome.', { modal: true }, 'Close Session');
          if (accepted !== 'Close Session') return;
        }
        await closeConsoleBindings(id);
      }
    });
  });
  command('rocketbrain.consoleMode', () => sessionAction(async (id, db) => {
    if (db.getSessionState(id).writeProtection?.connectionReadOnly) {
      void vscode.window.showInformationMessage('This connection profile is locked to read-only mode.');
      return;
    }
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
    if (!vscode.workspace.isTrusted || state.disposed) return;
    await db.setReadOnly(choice.readOnly, { sessionId: id });
    await db.setAutocommit(choice.autocommit, { sessionId: id });
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
  function disposeDatabase(){if(disposePromise)return disposePromise;state.disposed=true;state.epoch++;schemaMigrations.clear();schemaRebuilds.clear();streamReviews.clear();streamTransactions.clear();const databases=new Set([state.db,...state.candidates,...[...profileSessions.values()].map(item=>item.db)]);state.candidates.clear();bindings.clear();profileSessions.clear();profileBindings.clear();disposePromise=(async()=>{const settled=await Promise.allSettled([sqlDrafts.dispose(),...[...databases].map(closeDatabaseResources)]);await activityLog.dispose();const failure=settled.find(item=>item.status==='rejected');if(failure)throw failure.reason;})();return disposePromise;}
  context.subscriptions.push(project, schemaTree, output, status, tableEditor, connectionEvents,
    vscode.window.registerTreeDataProvider('rocketbrain.project', project),
    vscode.window.registerTreeDataProvider('rocketbrain.databases', schemaTree),
    vscode.window.registerWebviewViewProvider('rocketbrain.results', results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.window.tabGroups.onDidChangeTabs(publishProfileSessions), profileSessionEvents,
    vscode.workspace.onDidCloseTextDocument(document => {
      const binding = existingBinding(document), dedicated = isProfileConsole(document);
      if (!binding) {
        if (isVirtualProfileConsole(document)) profileFiles.remove(document.uri);
        return;
      }
      if (state.mysql || dedicated) {
        // A document close is not consent to discard a database transaction.
        binding.documentClosed = true;
        if (!linkedEditors(binding.id).some(member => !member.documentClosed)) {
          output.appendLine(`${binding.id}: all editors closed; server session retained. Use Manage Console Sessions to commit, roll back or close it.`);
          if (consoleDatabase(binding.id).getSessionState(binding.id).inTransaction) void vscode.window.showWarningMessage(`${binding.id} retains an open transaction. Use Rocketbrain: Manage Console Sessions to finish it.`);
        }
      } else bindings.delete(document.uri.toString());
      updateStatus();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => project.refresh()),
    vscode.workspace.onDidCreateFiles(() => project.refresh()), vscode.workspace.onDidDeleteFiles(() => project.refresh()), vscode.workspace.onDidRenameFiles(() => project.refresh()),
    vscode.languages.registerCompletionItemProvider('sql', { provideCompletionItems(document, position) {
      if(state.mysql||state.offlineMetadata||isProfileConsole(document)||isVirtualSqlPreview(document))return [];
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
  async function inspectRelationshipCatalog(request, method) {
    if (exclusiveDatabaseWork() || !state.mysql || !vscode.workspace.isTrusted) {
      throw Error('Use a trusted MySQL or MariaDB workspace connection to inspect the relationship.');
    }
    const { db, epoch } = state;
    const current = databaseGuard(db, epoch);
    if (!current()) throw Error('The database connection is unavailable. Inspect again.');
    const result = await db[method](request);
    if (!current()) throw Error('The database changed during relationship inspection. Compare again.');
    return result;
  }

  const api = {
    ...require('./db/authoring-facade').authoringFacade({state,assertReady:assertExclusiveReady,pendingDraft:pendingTableDraft,isTrusted:()=>vscode.workspace.isTrusted,sessions:()=>[...bindings.values()].map(binding=>state.db.getSessionState(binding.id)),updateStatus,refresh:refreshAfterSchemaAttempt}),
    dispose:disposeDatabase,disconnectMysql:useDemo,activityLog,activeConnectionProfile:()=>state.profile?structuredClone(state.profile):null,
    openProfileConsole,sqlDrafts,
    profileSessionList, revealProfileSession, inspectProfileSessionCatalog, closeProfileSession,
    isProfileSql: document => isProfileConsole(document) || fileProfiles.busy(document?.uri),
    changeSqlFileProfile, onDidChangeSqlFileProfile: sqlFileProfileEvents.event,
    onDidChangeProfileSessions: profileSessionEvents.event,
    hasProfileConsole: id => [...profileSessions.values()].some(item => item.profile.id === id),
    schema: () => structuredClone(state.schema),
    catalogSnapshot:()=>analysisMetadata()?structuredClone(analysisMetadata()):null,
    liveCatalogSnapshot:()=>state.mysql&&!state.offlineMetadata&&state.metadata?structuredClone(state.metadata):null,
    liveCatalogIdentity:()=>state.mysql&&!state.disposed&&!state.switching&&state.metadata&&state.tableLayoutConnection
      ? { connection:state.tableLayoutConnection,epoch:state.epoch,database:state.metadata.database } : null,
    refreshObjects: ({ names } = {}) => {
      if (!names) throw Error('Select tables or views to refresh.');
      return refreshLiveObjects(names);
    },
    refreshIncremental: () => refreshLiveObjects(),
    cachedMetadata: {
      list: metadataCache.list, capture: captureOfflineMetadata, open: openOfflineMetadata,
      close: closeOfflineMetadata, remove: removeOfflineMetadata
    },
    nativeDumps,
    queryDemo: sql => state.mysql ? Promise.reject(new Error('Demo checks require the demo connection.')) : state.db.query(sql),
    source: () => state.label, results: () => structuredClone(results.history), connectMysql,
    sqlActionContext, resultActionContext: () => results.actionContext(),
    exportResult: (id, format, destination) => results.exportSnapshot(id, format, destination), resultSnapshots, gridReviewRecovery,
    dataExtractors,
    analyzeResult: (id, options) => results.analyzeSnapshot(id, options),
    mapResult: (id, column, revision) => structuredClone(results.mapSnapshot(id, column, revision)),
    compareDatasets: (targetId, sourceId, mapping) => results.compareDatasets(targetId,sourceId,mapping),
    stageDatasetComparison: (id, input) => results.stageDatasetComparison(id,input),
    datasetWorkflows,
    savedResultLayout: id => results.savedLayout(id),
    saveResultLayout: (id, modelId, columns) => results.saveLayout(id, modelId, columns),
    inspectRelatedRows, openRelatedRows, returnToRelatedSource,
    onDidChangeDatabase: connectionEvents.event,
    onDidCompleteUserSql: completedUserSql.event,
    async withDatabaseAdmin(action,{write=false}={}){
      if(typeof action!=='function')throw Error('Choose a database catalog or privilege operation.');
      assertExclusiveReady();
      const protection = state.db.getSessionState().writeProtection;
      if (write && protection) {
        throw Error(protection.connectionReadOnly ? 'This connection profile is locked to read-only mode.'
          : 'Database-wide writes are unavailable while this profile protects tables.');
      }
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
    async explainGroundedQuery(scope, proposal, fingerprint, { signal, current } = {}) {
      assertExclusiveReady();
      const { db, epoch } = state, key = 'visual-explain';
      const guard = () => databaseGuard(db, epoch)() && (current?.() ?? true);
      state.running.add(key); updateStatus();
      try { return await db.explainGroundedQuery(scope, proposal, fingerprint, { guard, signal }); }
      finally { state.running.delete(key); updateStatus(); }
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
    relationshipTargetCatalog: request => inspectRelationshipCatalog(request, 'relationshipTargetCatalog'),
    relationshipJoinCatalog: request => inspectRelationshipCatalog(request, 'relationshipJoinCatalog'),
    crossLogicalEndpoint: request => inspectRelationshipCatalog(request, 'crossLogicalEndpoint'),
    inspectCrossLogical: request => inspectRelationshipCatalog(request, 'inspectCrossLogical'),
    joinCompletionCatalog: request => inspectRelationshipCatalog(request, 'joinCompletionCatalog'),
    joinLogicalRelationships(catalog) {
      if (!state.mysql || state.offlineMetadata || !vscode.workspace.isTrusted || catalog?.database !== state.profile?.database) return [];
      const records = savedLogicalRelationships(catalog.database);
      return records?.length ? logicalEdges(catalog, records) : [];
    },
    sessionState() {
      const binding = existingBinding();
      return binding && (state.mysql || profileSessions.has(binding.id)) ? consoleDatabase(binding.id).getSessionState(binding.id) : null;
    },
    sessions: consoleSessions,
    async inspectConsoleIsolation(document = currentDocument()) {
      if (!state.mysql && !isProfileConsole(document)) throw new Error('Connect to MySQL or MariaDB before choosing an isolation level.');
      if (!document || document.isClosed || document.languageId !== 'sql') throw new Error('Open a SQL editor first.');
      const binding = await bindInteractive(document);
      assertBinding(document, binding);
      return withSession(binding.id, async (id, db) => ({
        ...await db.getTransactionIsolation({ sessionId: id }), connectionEpoch: binding.epoch
      }));
    },
    async setConsoleIsolation(document, level, observed) {
      const binding = document && existingBinding(document);
      if (!binding || document.isClosed || document.languageId !== 'sql' || binding.id !== observed?.id || binding.epoch !== observed?.connectionEpoch) {
        throw new Error('This SQL console changed. Open the isolation picker again.');
      }
      assertBinding(document, binding);
      return withSession(binding.id, async (id, db) => {
        const beforeChange = () => {
          if (document.isClosed || !vscode.workspace.isTrusted) throw new Error('This SQL console is unavailable. Open the isolation picker again.');
          assertBinding(document, binding);
          if (pendingTableDraft()) throw new Error('Apply or discard pending table drafts before changing transaction isolation.');
        };
        beforeChange();
        const next = await db.setTransactionIsolation(level, {
          sessionId: id, expectedConnectionId: observed.connectionId,
          expectedIsolation: observed.transactionIsolation, beforeChange
        });
        return { ...next, connectionEpoch: binding.epoch };
      });
    },
    selectedSql,
    savedQueryTarget,
    async querySqlNotebook(sql, { connectionEpoch, signal, assertSource } = {}) {
      const { db, epoch } = state;
      const check = () => {
        if (signal?.aborted) throw Error('SQL notebook execution was cancelled.');
        if (connectionEpoch !== epoch || !databaseGuard(db, epoch)()) {
          throw Error('The active database changed. Run the notebook cell again.');
        }
        assertSource?.();
      };
      const id = 'notebook-' + (++sequence);
      return withSession(id, async () => {
        check();
        const cancel = () => { void db.cancel(id).catch(() => {}); };
        try {
          await db.openSession(id, { readOnly:true });
          signal?.addEventListener('abort', cancel, { once:true });
          check();
          const result = await db.query(sql, { sessionId:id, maxRows:128, timeoutMs:5000 });
          check();
          return result;
        } finally {
          signal?.removeEventListener('abort', cancel);
          await db.closeSession(id);
        }
      });
    },
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
    async describeSqlScript(sql,{document=currentDocument(),inspectParameters=false}={}) {
      if(!state.mysql)throw new Error('Connect to MySQL or MariaDB before running a SQL script.');
      const binding=await bind(document);assertBinding(document,binding);
      return withSession(binding.id, async () => {
        const described = await state.db.describeScript(sql, { sessionId: binding.id, inspectParameters });
        assertBinding(document, binding);
        const scope = described.parameterAccountScope && state.tableLayoutConnection;
        const parameterScope = scope ? require('./db/sql-script').digest(JSON.stringify([
          state.tableLayoutConnection, described.parameterAccountScope
        ])) : undefined;
        return { ...described, connectionEpoch: binding.epoch, documentUri: document.uri.toString(),
          ...(parameterScope && { parameterScope }) };
      });
    },
    async previewSqlScript(sql,{document=currentDocument(),parameters,connectionEpoch,maxRows,timeoutMs,totalTimeoutMs,presetContext}={}) {
      if(!state.mysql||connectionEpoch!==undefined&&connectionEpoch!==state.epoch)throw new Error('The database connection changed. Prepare the script again.');
      const binding=await bind(document);assertBinding(document,binding);
      return withSession(binding.id,async()=>({...await state.db.previewScript(sql,{sessionId:binding.id,parameters,maxRows,timeoutMs,totalTimeoutMs,presetContext}),connectionEpoch:state.epoch,documentUri:document.uri.toString()}));
    },
    async runSqlScript(request) {
      if(fileProfiles.get(request.documentUri)||fileProfiles.busy(request.documentUri))throw Error('Use the active database SQL editor to run this reviewed script.');
      if(!state.mysql||request.connectionEpoch!==state.epoch)throw new Error('The database connection changed. Preview the script again.');
      const binding=bindings.get(request.documentUri);
      if(!binding||binding.id!==request.sessionId||binding.epoch!==state.epoch)throw new Error('The SQL console changed. Preview the script again.');
      const db=state.db;return withSession(binding.id,()=>db.runScript({reviewId:request.reviewId,
        allowImplicitCommit:request.allowImplicitCommit===true,allowUnboundedDml:request.allowUnboundedDml===true,
        allowTransactionCommit:request.allowTransactionCommit===true,
        cancellation:request.cancellation}));
    },
    discardSqlScript(reviewId, connectionEpoch) {
      return state.mysql && state.epoch === connectionEpoch ? state.db.discardScript(reviewId) : false;
    },
    async captureSchemaSnapshot(options={}) {
      if(!vscode.workspace.isTrusted||!state.mysql||state.disposed||state.switching)throw new Error('Connect to MySQL or MariaDB in a trusted workspace first.');
      if(state.running.size||state.connecting.size)throw new Error('Finish running database operations before capturing a schema snapshot.');
      const {db,epoch}=state,key='schema-snapshot';state.running.add(key);updateStatus();
      try {
        const snapshot = await require('./db/schema-diff').captureSchema(db, options);
        if (options.includeStored === true) {
          snapshot.ddlPrograms = await require('./db/schema-ddl-programs').captureDdlPrograms(
            (sql, values) => db._metadataQuery(sql, values), snapshot);
        }
        if (state.disposed || db !== state.db || epoch !== state.epoch) throw new Error('The database changed while capturing the schema. Capture again.');
        return snapshot;
      } finally { state.running.delete(key); updateStatus(); }
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
    scriptStatementResult: (id,index,resultSet) => results.findStatement(id,index,resultSet),
    activateResult: id => results.activateResult(id),
    setResultTab: (id, settings) => results.setResultTab(id, settings),
    savedResultFilters: id => results.savedFilters(id),
    saveResultFilter: (id, modelId, name) => results.saveFilterPreset(id, modelId, name),
    removeResultFilter: (id, modelId, name) => results.removeFilterPreset(id, modelId, name),
    savedResultSorts: id => results.savedSorts(id),
    saveResultSort: (id, modelId, name) => results.saveSortPreset(id, modelId, name),
    removeResultSort: (id, modelId, name) => results.removeSortPreset(id, modelId, name),
    showResults:()=>results.show(),
    openTableSnapshot,
    async configureConsoleSession(sessionId,{readOnly,autocommit}={}) {
      if(!linkedEditors(sessionId).length)throw new Error('Unknown SQL console.');
      return withSession(sessionId,async(id, db)=>{if(readOnly!==undefined)await db.setReadOnly(readOnly,{sessionId:id});if(autocommit!==undefined)await db.setAutocommit(autocommit,{sessionId:id});return db.getSessionState(id);});
    },
    async controlConsoleSession(sessionId,action) {
      if(!linkedEditors(sessionId).length||!['begin','commit','rollback'].includes(action))throw new Error('Choose a managed transaction control for an existing console.');
      return withSession(sessionId,(id, db)=>db[action]({sessionId:id}));
    },
    reconnectConsoleSession(sessionId) {
      if (!linkedEditors(sessionId).length) throw Error('Choose an existing console to reconnect.');
      return withSession(sessionId, (id, db) => db.reconnect(id));
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
      if (!linkedEditors(id).length) throw new Error('Unknown console session.');
      await closeConsoleBindings(id);
    })
  };
  Object.defineProperty(api, 'setDatasetProfileSource', { value: source => { datasetProfileSource = source; } });
  return api;
}

module.exports = { registerDatabaseWorkbench };
