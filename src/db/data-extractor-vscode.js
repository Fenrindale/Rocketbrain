'use strict';

const { createExtractorReviews, loadExtractor } = require('./data-extractor-review');

const scheme = 'rocketbrain-extractor-preview';

function registerDataExtractors(context, vscode, command, results) {
  const captures = () => results.history.filter(record => results.exportable(record));
  const api = createExtractorReviews({ getCapture: id => captures().find(record => record.id === id)?.result,
    canRead: () => vscode.workspace.isTrusted });
  context.subscriptions.push(api, vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) {
      try {
        const report = api.preview(uri.path.slice(1));
        return ['Custom extractor preview · ' + report.script,
          'Captured input: ' + report.rowCount + ' rows' + (report.partial ? ' · captured page or truncated result' : ''),
          'Source schema: ' + (report.schema || 'multiple or unobserved'),
          'Output: ' + report.bytes + ' bytes · .' + report.extension, 'Script SHA-256 ' + report.scriptSha256,
          'Output SHA-256 ' + report.sha256, 'Review expires ' + report.expires,
          report.previewClipped ? 'First 8 KiB of output' : 'Complete output', '', report.preview].join('\n');
      } catch { return 'This custom extractor review is no longer available.'; }
    }
  }));

  function withProgress(title, action) {
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true },
      async (_, cancellation) => {
        const controller = new AbortController();
        const subscription = cancellation.onCancellationRequested(() => controller.abort());
        if (cancellation.isCancellationRequested) controller.abort();
        try { return await action(controller.signal); }
        finally { subscription.dispose(); }
      });
  }

  command('rocketbrain.db.newDataExtractor', async () => {
    const program = { version: 1, name: 'Typed result lines', extension: 'txt',
      header: ['Schema ', { meta: 'source.schema' }, '\n', { columns: { template: [
        { meta: 'column.name' }, ' (', { meta: 'column.kind' }, ')'
      ], separator: ' · ' } }, '\n'],
      row: [{ meta: 'row.number' }, '\t', { cell: 1, as: 'json' }, '\n'],
      footer: ['Rows emitted ', { meta: 'rows.emitted' }, '\n'] };
    const editor = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(program, null, 2) + '\n' });
    await vscode.window.showTextDocument(editor);
    await vscode.window.showInformationMessage('Save this workspace extractor with the .rbextract.json extension.');
  });

  command('rocketbrain.db.exportWithExtractor', async resultId => {
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before running a custom extractor.');
    if (!Number.isInteger(resultId)) {
      const choices = captures().map(record => ({ label: record.tabName || record.sql.replace(/\s+/g, ' ').slice(0, 100),
        description: record.result.rows.length + ' rows · ' + record.source, id: record.id }));
      if (!choices.length) throw Error('Run a query and select a completed result first.');
      const selected = await vscode.window.showQuickPick(choices, { title: 'Choose Captured Result for Extraction' });
      if (!selected) return;
      resultId = selected.id;
    }
    const [file] = await vscode.window.showOpenDialog({ title: 'Choose a Custom .rbextract.json Script',
      filters: { 'Extractor JSON': ['json'] }, canSelectMany: false }) || [];
    if (file?.scheme !== 'file' || file.authority) return;
    const script = await loadExtractor(file.fsPath);
    const report = await withProgress('Preparing Captured Result with Extractor', signal => api.prepare(resultId, script, { signal }));
    const uri = vscode.Uri.from({ scheme, path: '/' + report.id });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    const save = 'Save Reviewed Export';
    if (await vscode.window.showInformationMessage('Prepared ' + report.bytes + ' output bytes from ' + report.rowCount +
       ' captured rows.' + (report.partial ? ' This is a partial result.' : ''), save) !== save) return report;
    const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === 'file' && !item.uri.authority);
    const target = await vscode.window.showSaveDialog({ title: 'Save Reviewed Extractor Output', filters: { Output: [report.extension] },
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'query-results.' + report.extension) : undefined });
    if (target?.scheme !== 'file' || target.authority) return report;
    const written = await withProgress('Writing Reviewed Extractor Output', signal => api.write(report.id, target.fsPath, { confirmed: true, signal }));
    await vscode.window.showInformationMessage('Saved ' + written.bytes + ' reviewed extractor bytes.');
    return written;
  });

  return api;
}

module.exports = { registerDataExtractors };
