'use strict';

const { createTableTransfer } = require('./table-transfer');

function registerTableTransfer(context, vscode, { database }) {
  const core = createTableTransfer(database);
  const subscriptions = [], documents = new Map();
  let closed = false;

  function trusted() {
    if (closed || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace to copy database rows.');
  }

  function remember(plan) {
    for (const [id, prior] of documents) if (prior.expiresAt <= Date.now()) documents.delete(id);
    while (documents.size >= 4) documents.delete(documents.keys().next().value);
    documents.set(plan.reviewId, structuredClone(plan));
  }

  function tableChoices() {
    const catalog = database.catalogSnapshot();
    if (!catalog) throw new Error('Connect to MySQL or MariaDB.');
    return catalog.tables.filter(item => item.kind === 'table' && String(item.engine).toUpperCase() === 'INNODB' && !/^__rb_/i.test(item.name))
      .map(item => ({ label: item.name, description: catalog.database }));
  }

  function command(id, action) {
    const subscription = vscode.commands.registerCommand(id, async (...args) => {
      try { trusted(); return await action(...args); }
      catch (error) { if (!closed) await vscode.window.showErrorMessage('Rocketbrain Table Copy: ' + error.message); }
    });
    subscriptions.push(subscription);
  }

  function reviewText(id) {
    const plan = documents.get(id);
    if (closed || !vscode.workspace.isTrusted || !plan || plan.expiresAt <= Date.now()) return '-- Prepare a new table copy review.';
    return [
      '-- Rocketbrain table copy review',
      '-- Source ' + plan.source.engine + ' · ' + JSON.stringify([plan.source.database, plan.source.table]),
      '-- Destination ' + JSON.stringify([plan.destination.database, plan.destination.table]),
      '-- Rows ' + plan.rowCount + ' · Source SHA-256 ' + plan.source.sourceHash,
      '-- Column mapping ' + JSON.stringify(plan.mapping),
      '-- Commit or roll back the destination transaction after staging.',
      plan.source.mode === 'stream' ? '-- Source rows use an encrypted temporary snapshot. Destination batches use bound parameters.' :
        '-- The source rows are kept in memory. The statement uses bound parameters.',
      '',
      plan.sql + ';'
    ].join('\n');
  }

  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-table-copy', {
    provideTextDocumentContent(uri) { return reviewText(uri.path.split('/').filter(Boolean)[0]); }
  }));

  command('rocketbrain.data.captureTransferSource', async item => {
    const selected = item?.table?.name || (await vscode.window.showQuickPick(tableChoices(), { title: 'Select Source Table' }))?.label;
    if (!selected) return;
    const choice = await vscode.window.showQuickPick([
      { label: 'Small Snapshot', description: 'Retain up to 500 rows in memory', mode: 'captured' },
      { label: 'Stream Large Table', description: 'Retain up to 1,000,000 rows in an encrypted temporary snapshot of at most 1 GiB', mode: 'stream' }
    ], { title: 'Capture Source Rows' });
    if (!choice) return;
    trusted();
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Capturing committed source rows', cancellable: true
    }, (progress, cancellation) => core.capture({ table: selected, mode: choice.mode, cancellation,
      onProgress: ({ rows }) => progress.report({ message: rows + ' rows captured' }) }));
    await vscode.window.showInformationMessage(result.rowCount + ' rows captured from ' + result.database + '.' + result.table +
      '. Connect to the destination and run Copy Captured Rows.' +
      (result.omittedColumns ? ' Unsupported or generated columns: ' + result.omittedColumns + '.' : ''));
    return result;
  });

  async function finish() {
    const pending = core.pending();
    if (!pending) throw new Error('No pending table copy remains.');
    const action = await vscode.window.showQuickPick(['Commit Inserted Rows', 'Roll Back Copy', 'Leave Pending'], {
      title: pending.rows + ' uncommitted rows · ' + pending.database + '.' + pending.table
    });
    if (!action || action === 'Leave Pending') return pending;
    trusted();
    const report = await core.settle({ transactionId: pending.transactionId, commit: action === 'Commit Inserted Rows' });
    if (report.state === 'uncertain') await vscode.window.showWarningMessage(report.error.message);
    else await vscode.window.showInformationMessage('Table copy ' + report.state + '.');
    return report;
  }
  command('rocketbrain.data.finishTransfer', finish);

  command('rocketbrain.data.transfer', async item => {
    if (core.pending()) return finish();
    const sources = core.listSources().map(capture => ({ label: capture.database + '.' + capture.table,
      description: capture.engine + ' · ' + capture.rowCount + ' rows' + (capture.mode === 'stream' ? ' · streamed' : ''), capture }));
    if (!sources.length) throw new Error('Capture a source table with Capture Table Copy Source first.');
    const selected = await vscode.window.showQuickPick(sources, { title: 'Select Captured Source' });
    if (!selected) return;
    const table = item?.table?.name || (await vscode.window.showQuickPick(tableChoices(), { title: 'Select Destination Table' }))?.label;
    if (!table) return;
    trusted();
    const { capture } = selected, destination = await core.inspectDestination({ captureId: capture.id, table });
    const mapping = [], used = new Set();
    for (const source of capture.columns) {
      const available = destination.columns.filter(column => column.insertable && !used.has(column.name));
      available.sort((a, b) => Number(b.name === source.name) - Number(a.name === source.name));
      const choices = available.map(column => ({ label: column.name, description: column.type + (column.required ? ' · required' : ''), target: column.name }));
      choices.push({ label: 'Ignore Source Column', target: null });
      const choice = await vscode.window.showQuickPick(choices, { title: 'Map ' + source.name + ' · ' + source.type });
      if (!choice) return;
      if (choice.target !== null) used.add(choice.target);
      mapping.push({ source: source.name, target: choice.target });
    }
    trusted();
    const plan = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Validating the reviewed column mapping', cancellable: true
    }, (_, cancellation) => core.preview({ captureId: capture.id, destinationId: destination.id, mapping, cancellation }));
    remember(plan);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-table-copy:/' + plan.reviewId + '/review.sql'));
    await vscode.window.showTextDocument(document, { preview: false });
    const approved = await vscode.window.showWarningMessage('Stage ' + plan.rowCount + ' rows in ' + destination.database + '.' + destination.table + '?',
      { modal: true }, 'Stage Reviewed Copy');
    if (approved !== 'Stage Reviewed Copy') { await core.discardReview(plan.reviewId); return; }
    trusted();
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Staging reviewed copy in the destination transaction', cancellable: true
    }, (progress, cancellation) => core.run({ reviewId: plan.reviewId, cancellation,
      onProgress: update => progress.report({ message: update.rows + ' / ' + update.totalRows + ' rows' }) }));
    if (result.state === 'awaiting-commit') return finish();
    await vscode.window.showWarningMessage('Table copy ' + result.state + ': ' + result.error?.message);
    return result;
  });

  return { ...core, async dispose() {
    if (closed) return;
    closed = true;
    for (const subscription of subscriptions) subscription.dispose();
    await core.dispose();
    documents.clear();
  } };
}

module.exports = { registerTableTransfer };
