'use strict';

const { maxTables } = require('./native-dump');

function registerNativeDumpCommands(vscode, command, nativeDumps) {
  async function toolDirectory() {
    const [selected] = await vscode.window.showOpenDialog({ title: 'Choose MySQL or MariaDB Client Bin Directory',
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use Vendor Clients' }) || [];
    return selected?.scheme === 'file' ? selected.fsPath : undefined;
  }

  function progress(title, action) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (status, cancellation) => {
        const cancellationSource = new AbortController();
        const cancel = cancellation.onCancellationRequested(() => cancellationSource.abort());
        if (cancellation.isCancellationRequested) cancellationSource.abort();
        try {
          return await action({ signal: cancellationSource.signal,
            onProgress: bytes => status.report({ message: (bytes / (1024 * 1024)).toFixed(1) + ' MiB' }) });
        } finally { cancel.dispose(); }
      });
  }

  command('rocketbrain.db.nativeDump', async () => {
    const { database, dialect, tables, objects: candidates, connectionEpoch } = await nativeDumps.listTables();
    if (!tables.length) throw Error('No supported InnoDB base tables are visible in this database.');
    const selected = await vscode.window.showQuickPick(tables, { title: 'Choose Tables from ' + database,
      placeHolder: 'Include all referenced tables in ' + database + ' (up to ' + maxTables + ')', canPickMany: true });
    if (!selected?.length) return;
    let objects = [];
    if (candidates.length) {
      const mode = await vscode.window.showQuickPick(['Selected tables only', 'Add schema objects'], { title: 'Native Backup Scope' });
      if (!mode) return;
      if (mode === 'Add schema objects') {
        const choices = await vscode.window.showQuickPick(candidates.map(item => ({ label: item.name, description: item.kind, item })),
          { title: 'Choose Objects from ' + database, placeHolder: 'Include every referenced view and procedure, and each matching trigger group', canPickMany: true });
        if (!choices?.length) return;
        objects = choices.map(item => item.item);
      }
    }
    const tools = await toolDirectory();
    if (!tools) return;
    const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === 'file');
    const file = await vscode.window.showSaveDialog({ title: 'Save Native ' + dialect + ' Backup', filters: { SQL: ['sql'] },
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, database + '-backup.sql') : undefined });
    if (file?.scheme !== 'file') return;
    const report = await progress('Writing Native Database Backup', options =>
      nativeDumps.dump({ tools, file: file.fsPath, tables: selected, connectionEpoch, objects }, options));
    await vscode.window.showInformationMessage('Saved ' + report.tables.length + ' tables' +
      (report.graph ? ' and ' + report.graph.objects.length + ' schema objects' : '') + ' in ' + report.bytes +
      ' bytes. SHA-256 ' + report.sha256 + '.' + (report.warnings ? ' The vendor tool reported a warning.' : ''));
    return report;
  });

  command('rocketbrain.db.nativeRestore', async () => {
    const [file] = await vscode.window.showOpenDialog({ title: 'Choose a Rocketbrain Native Backup',
      canSelectMany: false, filters: { SQL: ['sql'] } }) || [];
    if (file?.scheme !== 'file') return;
    const tools = await toolDirectory();
    if (!tools) return;
    const review = await progress('Reviewing Native Database Backup', options =>
      nativeDumps.previewRestore({ tools, file: file.fsPath }, options));
    const destination = review.destinationDatabase + ' @ ' + review.destinationEndpoint;
    const approved = await vscode.window.showWarningMessage('Restore ' + review.tables.length + ' tables into ' + destination + '?',
      { modal: true, detail: ['Backup ' + review.file, 'Source schema ' + review.sourceDatabase,
        'Tables ' + review.tables.join(', '), ...(review.objects ? ['Objects ' + review.objects.map(item => item.kind + ' ' + item.name).join(', '),
          'The reviewed objects retain their effective definer on the same server.'] : []),
        'SHA-256 ' + review.sha256, 'Client version ' + review.clientVersion,
        'The destination must still be empty. Table creation commits immediately. Cancellation or an error may leave partial changes.'].join('\n') },
      'Restore into Empty Schema');
    if (approved !== 'Restore into Empty Schema') return;
    const report = await progress('Restoring into ' + destination, options => nativeDumps.restore({ reviewId: review.reviewId,
      destinationDatabase: review.destinationDatabase, allowWrite: true }, options));
    await vscode.window.showInformationMessage('Restored ' + report.tables.length + ' tables' +
      (report.graphVerified ? ' and verified ' + report.objects.length + ' schema objects' : '') + ' into ' + report.database + '.' +
      (report.warnings ? ' The vendor tool reported a warning.' : ''));
    return report;
  });
}

module.exports = { registerNativeDumpCommands };
