'use strict';

const { observeCollationRegistry, inspectCollations } = require('./sql-collation-checks');
const { isProfileConsole: isVirtualProfileConsole } = require('./profile-console-files');
const { isFederatedDocument } = require('./federated-select');

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function registerSqlCollations(vscode, { database, virtualActive = () => false, onDidChangeAnalysis } = {}) {
  const isProfileConsole = database?.isProfileSql ?? isVirtualProfileConsole;
  const collection = vscode.languages.createDiagnosticCollection('rocketbrain-sql-collations');
  const subscriptions = [collection];
  let disposed = false, generation = 0, pending = 0, snapshot;

  function eligible(document) {
    return !disposed && vscode.workspace.isTrusted && document?.languageId === 'sql' && !document.isClosed &&
      !isProfileConsole(document) && !isFederatedDocument(document) && !virtualActive(document) &&
      vscode.workspace.getConfiguration('rocketbrain.sql.analysis').get('enabled', true);
  }

  function inspect(document) {
    if (!eligible(document) || !snapshot || !same(database.liveCatalogIdentity(), snapshot.identity)) {
      if (document && !disposed) collection.delete(document.uri);
      return [];
    }
    const issues = inspectCollations(document.getText(), snapshot.catalog, snapshot.registry);
    collection.set(document.uri, issues.map(issue => {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
        issue.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'Rocketbrain SQL (observed collation)';
      diagnostic.code = issue.code;
      return diagnostic;
    }));
    return issues;
  }

  function update() {
    for (const document of vscode.workspace.textDocuments) if (document.languageId === 'sql') inspect(document);
  }

  async function refresh() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before reading SQL collation metadata.');
    const identity = database.liveCatalogIdentity(), catalog = database.liveCatalogSnapshot();
    if (!identity || !catalog?.semanticContextObserved || catalog.database !== identity.database ||
        !['mysql','mariadb'].includes(catalog.dialect) || catalog.coverage?.tables !== 'loaded' || catalog.coverage?.columns !== 'loaded')
      throw Error('Connect and refresh a visible MySQL or MariaDB catalog before reading collation rules.');
    const ticket = generation, sequence = ++pending;
    const current = () => !disposed && vscode.workspace.isTrusted && ticket === generation && sequence === pending &&
      same(database.liveCatalogIdentity(), identity);
    const registry = await database.withDatabaseAdmin(async lease => {
      let connection;
      const read = async (sql, values) => {
        if (!lease.guard() || !current()) throw Error('The SQL metadata session changed. Refresh collation rules again.');
        const result = await lease.db._metadataQuery(sql, values), observed = lease.db._metadataSession.connection;
        if (result.truncated || !observed || connection && connection !== observed || !lease.guard() || !current())
          throw Error('The SQL metadata session changed or exceeded its observed limit.');
        connection = observed;
        return result.rows;
      };
      const rows = await read('SELECT VERSION(), DATABASE(), @@SESSION.sql_mode');
      if (rows.length !== 1 || rows[0][0] !== catalog.serverVersion || rows[0][1] !== catalog.database ||
          !same(String(rows[0][2]).split(',').filter(Boolean), catalog.sqlMode)) {
        throw Error('The observed server, schema or SQL mode changed. Refresh catalog metadata first.');
      }
      return observeCollationRegistry(read, catalog.dialect);
    });
    if (!current()) throw Error('The database changed during collation refresh. Refresh again.');
    snapshot = { identity, catalog, registry };
    update();
    return { dialect: catalog.dialect, database: catalog.database, collations: registry.collations.size, executedSql: false };
  }

  subscriptions.push(database.onDidChangeDatabase(() => { generation++; snapshot = undefined; collection.clear(); }));
  subscriptions.push(vscode.workspace.onDidOpenTextDocument(inspect));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(({ document }) => inspect(document)));
  subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => collection.delete(document.uri)));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('rocketbrain.sql.analysis')) update(); }));
  if (onDidChangeAnalysis) subscriptions.push(onDidChangeAnalysis(document => document ? inspect(document) : update()));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.sql.refreshCollationChecks', async () => {
    try {
      const value = await refresh();
      vscode.window.setStatusBarMessage('SQL collation checks · ' + value.collations + ' observed names', 6000);
      return value;
    } catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain SQL: ' + error.message); }
  }));
  return { refresh, inspect, dispose() {
    disposed = true;
    snapshot = undefined;
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { registerSqlCollations };
