'use strict';
const vscode = require('vscode');
const { registerNavigation } = require('./navigation');
const { registerJavaFeatures } = require('./java');

class ProjectTree {
  constructor() { this.events = new vscode.EventEmitter(); this.onDidChangeTreeData = this.events.event; }
  getTreeItem(item) { return item; }
  async getChildren(parent) {
    if (!parent) return (vscode.workspace.workspaceFolders || []).map(f => { const item = this.item(f.uri, true, f.name); item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded; return item; });
    try {
      const hidden = new Set(['.git', '.idea', 'node_modules', 'dist', 'target', '.vscode-test']);
      return (await vscode.workspace.fs.readDirectory(parent.resourceUri)).filter(([name]) => !hidden.has(name)).sort((a, b) => Number(b[1] === vscode.FileType.Directory) - Number(a[1] === vscode.FileType.Directory) || a[0].localeCompare(b[0])).map(([name, kind]) => this.item(vscode.Uri.joinPath(parent.resourceUri, name), kind === vscode.FileType.Directory, name));
    } catch { return []; }
  }
  item(uri, directory, label) {
    const item = new vscode.TreeItem(label, directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = uri.toString(); item.resourceUri = uri;
    if (!directory) item.command = { command: 'vscode.open', title: 'Open File', arguments: [uri] };
    return item;
  }
  refresh() { this.events.fire(); }
  dispose() { this.events.dispose(); }
}
class SchemaTree {
  constructor(state) { this.state = state; this.events = new vscode.EventEmitter(); this.onDidChangeTreeData = this.events.event; }
  getTreeItem(item) { return item; }
  getChildren(parent) {
    if (!parent) {
      const root = new vscode.TreeItem(this.state.label, vscode.TreeItemCollapsibleState.Expanded);
      root.kind = 'database'; root.iconPath = new vscode.ThemeIcon('database'); root.description = this.state.mysql ? 'MySQL / MariaDB · console sessions' : 'SQLite · sample data'; return [root];
    }
    if (parent.kind === 'database') {
      const stale = new Map((this.state.metadata?.refresh?.staleObjects ?? []).map(item => [item.name, item.reason]));
      return this.state.schema.map(table => {
        const item = new vscode.TreeItem(table.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.kind = 'table'; item.contextValue='rocketbrain.table'; item.table = table; item.iconPath = new vscode.ThemeIcon('table');
        item.description = `${table.columns.length} columns` + (stale.has(table.name) ? ' · last known' : '');
        if (stale.has(table.name)) item.tooltip = stale.get(table.name);
        item.command = { command: 'rocketbrain.openTable', title: 'Preview Table', arguments: [table.name] }; return item;
      });
    }
    return (parent.table?.columns || []).map(col => { const item = new vscode.TreeItem(col.name); item.description = col.type + (col.primaryKey ? ' · PK' : ''); item.iconPath = new vscode.ThemeIcon(col.primaryKey ? 'key' : 'symbol-field'); return item; });
  }
  refresh() { this.events.fire(); }
  dispose() { this.events.dispose(); }
}
let activeJava,activeJavaTesting,activeJavaUtilities,activeJavaNavigation,activeJavaInspections,activeJavaSourceAnalysis,activeJvmDiagnostics,activeSchemaRename,activeSqlScripts,activeSchemaComparison,activeStreamImports,activeTableTransfer,activeSchemaPrograms,activeSchemaCoordinator,activeSchemaDiagrams,activeSchemaDdlExport,activeDatabase,activeDbConnections,activeDbAuthoring,activeDbSessionTools,activeSpringProjects;
async function activate(context) {
  let sqlAnalysis;
  const database = await require("./database-workbench").registerDatabaseWorkbench(context, vscode, ProjectTree, SchemaTree,
    document=>sqlAnalysis?.virtualActive(document),document=>sqlAnalysis?.analysisOnly(document));
  activeDatabase=database;
  const duckdb = require('./db/duckdb-vscode').registerDuckDb(context, vscode);
  const sqlite = require('./db/sqlite-file-vscode').registerSqliteFile(context, vscode, database);
  const mongoDb = require('./db/mongodb-vscode').registerMongoDb(context, vscode);
  const jdbc = require('./db/jdbc-vscode').registerJdbc(vscode, context);
  const embeddedLanguage = require('./db/embedded-language-vscode').registerEmbeddedLanguage(vscode, { catalogSnapshot: database.catalogSnapshot });
  context.subscriptions.push(embeddedLanguage);
  const dbConnections=require('./db/connection-profiles-vscode').registerConnectionProfiles(context,vscode,{database});activeDbConnections=dbConnections;
  const federation = require('./db/federated-select-vscode').registerFederatedSelect(vscode, dbConnections);
  context.subscriptions.push(federation);
  const dbAuthoring=require('./db/db-authoring-vscode').registerDatabaseAuthoring(context,vscode,{database});activeDbAuthoring=dbAuthoring;
  const dbSessionTools = require('./db/session-tools-vscode').registerDbSessionTools(context, vscode, { database });
  activeDbSessionTools = dbSessionTools;
  context.subscriptions.push(dbSessionTools);
  const dbAdmin=require('./db/database-admin-vscode').registerDatabaseAdmin(context,vscode,{database});
  context.subscriptions.push(dbAdmin);
  const lazyCatalog=require('./db/lazy-catalog-vscode').registerLazyCatalog(context,vscode,{database});
  const objectSources = require('./db/object-source-vscode').registerObjectSources(vscode, { database,
    captureFileUsages: (...args) => sqlAnalysis.captureCatalogFileUsages(...args) });
  const routineCalls = require('./db/routine-call-vscode').registerRoutineCalls(vscode, { database });
  context.subscriptions.push(routineCalls);
  const schemaCatalog = require('./db/schema-catalog-vscode').registerSchemaCatalog(context, vscode, { database, objectSources });
  const databaseSearch = require('./db/unified-search-vscode').registerUnifiedSearch(context, vscode, { database, objectSources, schemaCatalog });
  const explainPlans=require('./db/explain-plan-vscode').registerExplainPlans(context,vscode,{database});
  const localSqlAssistant = require('./db/local-sql-assistant-vscode').registerLocalSqlAssistant(context, vscode, database);
  localSqlAssistant.grounded = require('./db/local-sql-grounding-vscode').registerGroundedSqlAssistant(context, vscode, database);
  const sqlProposalReview = require('./db/sql-proposal-review-vscode').registerSqlProposalReview(context, vscode, database);
  context.subscriptions.push(lazyCatalog,objectSources,schemaCatalog,explainPlans);
  const tableTransfer=require('./db/table-transfer-vscode').registerTableTransfer(context,vscode,{database});
  activeTableTransfer=tableTransfer;
  context.subscriptions.push(tableTransfer);
  const schemaDiagrams = require('./db/schema-erd-vscode').registerSchemaDiagrams(context, vscode, { database });
  activeSchemaDiagrams = schemaDiagrams;
  context.subscriptions.push(schemaDiagrams);
  const schemaDdlExport = require('./db/schema-ddl-export-vscode').registerSchemaDdlExport(context, vscode, { database });
  activeSchemaDdlExport = schemaDdlExport;
  context.subscriptions.push(schemaDdlExport);
  const navigation = registerNavigation(vscode, context, { databaseSearch, hasLiveDatabase: () => Boolean(database.liveCatalogSnapshot()) });
  context.subscriptions.push(navigation);
  const changelists = require('./vcs/changelists-vscode').registerChangelists(context, vscode);
  context.subscriptions.push(changelists);
  const codeReview = require('./vcs/code-review-vscode').registerCodeReview(context,vscode);
  context.subscriptions.push(codeReview);
  const codeModel = require('./ai/editor-model-vscode').registerEditorModel(vscode);
  const sshWorkspace = require('./remote/ssh-workspace-vscode').registerSshWorkspace(context, vscode);
  const acpReview = require('./ai/acp-vscode').registerAcpReview(context,vscode);
  acpReview.database = require('./db/acp-database-vscode').registerDatabaseAcp(context,vscode,database);
  acpReview.workspaceEdits = require('./ai/acp-workspace-edit-vscode').registerWorkspaceAcpEdits(context,vscode);
  acpReview.savedSessions = require('./ai/acp-recovery-vscode').registerAcpRecovery(context,vscode);
  context.subscriptions.push(codeModel);
  const docker = require('./docker/vscode').registerDockerWorkbench(vscode);
  context.subscriptions.push(docker);
  const kubernetes = require('./infra/kubernetes-vscode').registerKubernetesExplorer(context, vscode);
  const java = registerJavaFeatures(context, vscode);
  const gitWorktrees=require('./vcs/worktree-context-vscode').registerWorktreeContexts(context,vscode,{java,dbConnections});
  context.subscriptions.push(gitWorktrees);
  const javaFx = require('./java/javafx-vscode').registerJavaFx(vscode, { java });
  java.fx = javaFx;
  context.subscriptions.push(javaFx);
  java.dependencyAdvisories = require('./java/dependency-advisories-vscode').registerDependencyAdvisories(vscode);
  context.subscriptions.push(java.dependencyAdvisories);
  activeJava = java;
  const javaInspections=require('./java/inspections-vscode').registerJavaInspections(context,vscode);
  activeJavaInspections=javaInspections;
  context.subscriptions.push(javaInspections);
  const javaSourceAnalysis=require('./java/source-analysis-vscode').registerJavaSourceAnalysis(context,vscode,{java});
  activeJavaSourceAnalysis=javaSourceAnalysis;
  context.subscriptions.push(javaSourceAnalysis);
  const jvmDiagnostics=require('./java/jvm-diagnostics-vscode').registerJvmDiagnostics(context,vscode,{java});
  activeJvmDiagnostics=jvmDiagnostics;
  context.subscriptions.push(jvmDiagnostics);
  const javaNavigation = require('./java/navigation-vscode').registerJavaNavigation(context, vscode, { java });
  activeJavaNavigation = javaNavigation;
  context.subscriptions.push(javaNavigation);
  const javaEditing = require('./java/editing-vscode').registerJavaEditing(context,vscode,{java});
  context.subscriptions.push(javaEditing);
  const javaUtilities = require('./java/utilities-vscode').registerJavaUtilities(context, vscode, { java });
  activeJavaUtilities = javaUtilities;
  context.subscriptions.push(javaUtilities);
  const springProjects=require('./spring/project-vscode').registerSpringProjectTools(context,vscode,{java});activeSpringProjects=springProjects;
  context.subscriptions.push(java);
  const javaTesting=require('./java/testing-vscode').registerJavaTesting(context,vscode,{java});
  activeJavaTesting=javaTesting;context.subscriptions.push(javaTesting);
  const httpTools = require('./http/vscode').registerHttpTools(context,vscode);
  const webdav = require('./http/webdav-vscode').registerWebDav(context,vscode);
  context.subscriptions.push(webdav);
  const openApi = require('./http/openapi-vscode').registerOpenApiTools(context,vscode);
  context.subscriptions.push(httpTools,openApi);
  const jpa = require('./jpa/vscode').registerJPAFeatures(context, vscode, { catalog: database.databaseCatalog });
  context.subscriptions.push(jpa);
  const jpaScaffold=require('./jpa/entity-scaffold-vscode').registerEntityScaffolding(context,vscode,{database,java});
  context.subscriptions.push(jpaScaffold);
  const analysis = require('./analysis-tree').registerAnalysisTree(context, vscode, { spring: java.spring, jpa });
  context.subscriptions.push(analysis);
  sqlAnalysis=require('./db/sql-vscode').registerSQLAnalysis(context,vscode,{catalog:database.databaseCatalog,catalogSnapshot:database.catalogSnapshot,onDidChangeDatabase:database.onDidChangeDatabase,
    joinCatalog:database.joinCompletionCatalog,joinLogicalRelationships:database.joinLogicalRelationships,
    objectDefinition:objectSources.definition,objectColumnOrigin:objectSources.columnOrigin,liveCatalogIdentity:database.liveCatalogIdentity});
  context.subscriptions.push(sqlAnalysis);
  const sqlCollations = require('./db/sql-collation-vscode').registerSqlCollations(vscode, {
    database, virtualActive: sqlAnalysis.virtualActive, onDidChangeAnalysis: sqlAnalysis.onDidChange
  });
  context.subscriptions.push(sqlCollations);
  const sqlEditing=require('./db/sql-editing-vscode').registerSqlEditing(context,vscode,{database,sqlAnalysis,openDesigner:dbAuthoring.openDesigner});
  context.subscriptions.push(sqlEditing);
  const schemaRename=require('./db/schema-vscode').registerSchemaRename(context,vscode,{database,sqlAnalysis});
  activeSchemaRename=schemaRename;context.subscriptions.push(schemaRename);
  const sqlScripts=require('./db/sql-script-vscode').registerSqlScripts(context,vscode,{database,analysisOnly:sqlAnalysis.analysisOnly});
  activeSqlScripts=sqlScripts;context.subscriptions.push(sqlScripts);
  const sqlNotebook = require('./db/sql-notebook-vscode').registerSqlNotebook(vscode, { database });
  context.subscriptions.push(sqlNotebook);
  const jupyter = require('./python/jupyter-vscode').registerJupyter(vscode);
  context.subscriptions.push(jupyter);
  const python = require('./python/python-vscode').registerPython(vscode);
  const vue = require('./web/vue-vscode').registerVueWorkbench(context, vscode);
  context.subscriptions.push(python);
  const devContainers = require('./devcontainer/vscode').registerDevContainers(context, vscode);
  context.subscriptions.push(devContainers);
  const schemaComparison=require('./db/schema-diff-vscode').registerSchemaComparison(context,vscode,{
    capture:options=>database.captureSchemaSnapshot(options),
    prepare:request=>database.previewSchemaMigration(request),
    apply:request=>database.applySchemaMigration(request),
    discard:reviewId=>database.discardSchemaMigration(reviewId),
    prepareRebuild:request=>database.previewSchemaRebuild(request),
    applyRebuild:request=>database.applySchemaRebuild(request),
    recoverRebuild:request=>database.recoverSchemaRebuild(request),
    listRecoveries:()=>database.listSchemaRecoveries(),discardRebuild:reviewId=>database.discardSchemaRebuild(reviewId)
  });
  activeSchemaComparison=schemaComparison;context.subscriptions.push(schemaComparison);
  const schemaPrograms=require('./db/schema-programs-vscode').registerSchemaPrograms(context,vscode,{list:()=>database.listSchemaPrograms(),analyze:request=>database.analyzeSchemaPrograms(request),onDidChangeDatabase:database.onDidChangeDatabase});
  activeSchemaPrograms=schemaPrograms;context.subscriptions.push(schemaPrograms);
  const schemaCoordinator=require('./db/schema-coordinator-vscode').registerSchemaCoordinator(context,vscode,{withExclusiveSchemaWork:database.withExclusiveSchemaWork,activityLog:database.activityLog});
  activeSchemaCoordinator=schemaCoordinator;context.subscriptions.push(schemaCoordinator);
  const streamImports=require('./db/import-stream-vscode').registerStreamImports(context,vscode,{
    inspect:request=>database.inspectStreamImport(request),prepare:request=>database.prepareStreamImport(request),
    run:request=>database.runStreamImport(request),commit:request=>database.commitStreamImport(request),
    rollback:request=>database.rollbackStreamImport(request),discard:reviewId=>database.discardStreamImport(reviewId),
    pending:()=>database.pendingStreamImports(),tables:()=>database.schema().filter(table=>table.kind==='table'&&String(table.engine).toUpperCase()==='INNODB'&&!table.name.startsWith('__rb_')),dispose:()=>database.disposeStreamImports()
  });
  activeStreamImports=streamImports;context.subscriptions.push(streamImports);
  context.subscriptions.push(database.onDidChangeDatabase(() => { jpa.invalidateCatalog(); analysis.clearCatalog(); }));
  const wsl = require('./remote/wsl-vscode').registerWslWorkbench(vscode);
  context.subscriptions.push(wsl);
  return { ...database, navigation, duckdb, sqlite, mongoDb, jdbc, java, javaTesting, javaUtilities, javaNavigation, javaEditing, javaInspections, javaSourceAnalysis, jvmDiagnostics, httpTools, webdav, openApi, jpa, jpaScaffold, analysis, sqlAnalysis, sqlCollations, sqlEditing, embeddedLanguage, schemaRename, sqlScripts, sqlNotebook, jupyter, python, vue, devContainers, schemaComparison, streamImports, tableTransfer, schemaPrograms, schemaCoordinator, schemaDiagrams, schemaDdlExport, dbConnections, dbAuthoring, dbSessionTools, dbAdmin, lazyCatalog, objectSources, routineCalls, schemaCatalog, databaseSearch, explainPlans, localSqlAssistant, sqlProposalReview, springProjects, gitWorktrees, changelists, codeReview, codeModel, sshWorkspace, acpReview, docker, kubernetes, federation, wsl };
}
async function deactivate() {
  const sourceAnalysis=activeJavaSourceAnalysis;
  activeJavaSourceAnalysis=undefined;
  if(sourceAnalysis)await sourceAnalysis.dispose();
  const inspections=activeJavaInspections;
  activeJavaInspections=undefined;
  if(inspections)await inspections.dispose();
  const diagnostics=activeJvmDiagnostics;
  activeJvmDiagnostics=undefined;
  if(diagnostics)await diagnostics.dispose();
  const transfer=activeTableTransfer;
  activeTableTransfer=undefined;
  if(transfer)await transfer.dispose();
  const ddlExport = activeSchemaDdlExport;
  activeSchemaDdlExport = undefined;
  if (ddlExport) await ddlExport.dispose();
  const diagrams = activeSchemaDiagrams;
  activeSchemaDiagrams = undefined;
  if (diagrams) await diagrams.dispose();
  const sessionTools = activeDbSessionTools;
  activeDbSessionTools = undefined;
  if (sessionTools) await sessionTools.dispose();
  const connections=activeDbConnections;activeDbConnections=undefined;if(connections)await connections.dispose();
  const authoring=activeDbAuthoring;activeDbAuthoring=undefined;if(authoring)await authoring.dispose();
  const springProjects=activeSpringProjects;activeSpringProjects=undefined;if(springProjects)await springProjects.dispose();
  const coordinator=activeSchemaCoordinator;activeSchemaCoordinator=undefined;if(coordinator)await coordinator.dispose();
  const programs=activeSchemaPrograms;activeSchemaPrograms=undefined;if(programs)await programs.dispose();
  const imports=activeStreamImports;activeStreamImports=undefined;if(imports)await imports.dispose();
  const scripts=activeSqlScripts;activeSqlScripts=undefined;if(scripts)await scripts.dispose();
  const comparison=activeSchemaComparison;activeSchemaComparison=undefined;if(comparison)await comparison.dispose();
  const schemaRename=activeSchemaRename;activeSchemaRename=undefined;if(schemaRename)await schemaRename.dispose();
  const java = activeJava;
  const navigation = activeJavaNavigation;
  activeJavaNavigation = undefined;
  if (navigation) navigation.dispose();
  const utilities = activeJavaUtilities;
  activeJavaUtilities = undefined;
  const testing=activeJavaTesting;activeJavaTesting=undefined;
  activeJava = undefined;
  if (utilities) await utilities.dispose();
  if(testing)await testing.dispose();
  if (java) await java.dispose();
  const database=activeDatabase;activeDatabase=undefined;if(database)await database.dispose();
}
module.exports = { activate, deactivate };
