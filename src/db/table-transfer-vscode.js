'use strict';

const { createTableTransfer } = require('./table-transfer');
const { createTransferRecovery } = require('./table-transfer-recovery');
const { createTransferHistory, historyLimits } = require('./table-transfer-history');

const historyCommand = 'rocketbrain.data.transferVerificationHistory';
const historyScheme = 'rocketbrain-table-copy-history';
const statusLabels = { matching: 'Matching', missing: 'Missing keys', mismatch: 'Different values', inconclusive: 'Inconclusive' };
const reasons = {
  'missing-review-evidence': 'This saved transfer has no destination evidence.',
  'primary-key-not-mapped': 'The review did not map every destination primary-key column.',
  'no-bounded-keys': 'The sampled destination keys exceeded the verification limit.',
  'destination-identity-changed': 'Connect to the reviewed server, database, endpoint and account.',
  'destination-definition-changed': 'The reviewed table definition is different or unavailable.',
  'destination-unavailable': 'The reviewed destination could not be opened for a read-only check.',
  'sample-unreadable': 'The sampled destination rows could not be read exactly.'
};

function checkSummary(result) {
  const scope = result.coverage === 'all-reviewed-keys' ? 'all reviewed keys' : 'sampled reviewed keys';
  return result.checkedKeys + ' / ' + result.rows + ' keys checked (' + scope + ') · ' +
    result.matching + ' matching · ' + result.missing + ' missing · ' + result.mismatch + ' different.';
}

function registerTableTransfer(context, vscode, { database }) {
  const storagePath = context.storageUri?.fsPath;
  const isTrusted = () => !closed && vscode.workspace.isTrusted;
  const recovery = createTransferRecovery({ storagePath, secrets: context.secrets, isTrusted });
  const history = storagePath && createTransferHistory({ storagePath, isTrusted });
  const core = createTableTransfer(database, { recovery, history });
  const subscriptions = [], documents = new Map();
  let closed = false, historyText = '';

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
      plan.source.recoveryState ? '-- Source rows use a saved encrypted snapshot. A resumed copy starts a fresh destination transaction.' :
        plan.source.mode === 'stream' ? '-- Source rows use an encrypted temporary snapshot. Destination batches use bound parameters.' :
        '-- The source rows are kept in memory. The statement uses bound parameters.',
      '',
      plan.sql + ';'
    ].join('\n');
  }

  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-table-copy', {
    provideTextDocumentContent(uri) { return reviewText(uri.path.split('/').filter(Boolean)[0]); }
  }));
  const historyUri = vscode.Uri.parse(historyScheme + ':/Table Copy Verification History.txt');
  const historyChanged = new vscode.EventEmitter();
  subscriptions.push(historyChanged, vscode.workspace.registerTextDocumentContentProvider(historyScheme, {
    onDidChange: historyChanged.event,
    provideTextDocumentContent(uri) {
      if (!isTrusted() || uri.toString() !== historyUri.toString()) return '';
      return historyText;
    }
  }));

  async function showTransferHistory(captureId) {
    const entries = await core.listTransferVerificationHistory({ captureId });
    trusted();
    historyText = [
      'Table Copy Verification History',
      'This workspace retains ' + historyLimits.entries + ' observations for up to ' + historyLimits.ageMs / 86400000 + ' days.',
      'Observations report the destination at the time of each check. Commit history remains unconfirmed and replay stays blocked.',
      ...(captureId ? ['Capture ' + captureId] : []),
      '',
      ...(entries.length ? entries.flatMap(entry => [
        entry.recordedAt + ' · ' + statusLabels[entry.status] + ' · Capture ' + entry.captureId,
        entry.reason ? reasons[entry.reason] : checkSummary(entry), ''
      ]) : ['No verification observations are available.'])
    ].join('\n');
    historyChanged.fire(historyUri);
    const document = await vscode.workspace.openTextDocument(historyUri);
    await vscode.window.showTextDocument(document, { preview: false });
    return entries;
  }
  command(historyCommand, () => showTransferHistory());

  command('rocketbrain.data.captureTransferSource', async item => {
    const selected = item?.table?.name || (await vscode.window.showQuickPick(tableChoices(), { title: 'Select Source Table' }))?.label;
    if (!selected) return;
    const choice = await vscode.window.showQuickPick([
      { label: 'Small Snapshot', description: 'Retain up to 500 rows in memory', mode: 'captured' },
      { label: 'Stream Large Table', description: 'Retain up to 1,000,000 rows in an encrypted temporary snapshot of at most 1 GiB', mode: 'stream' },
      ...(core.canRecover ? [{ label: 'Stream and Save for Resume', description: 'Keep the encrypted snapshot in this workspace for up to 24 hours',
        mode: 'stream', recoverable: true }] : [])
    ], { title: 'Capture Source Rows' });
    if (!choice) return;
    trusted();
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Capturing committed source rows', cancellable: true
    }, (progress, cancellation) => core.capture({ table: selected, mode: choice.mode, recoverable: choice.recoverable, cancellation,
      onProgress: ({ rows }) => progress.report({ message: rows + ' rows captured' }) }));
    await vscode.window.showInformationMessage(result.rowCount + ' rows captured from ' + result.database + '.' + result.table +
      '. Connect to the destination and run Copy Captured Rows.' +
      (result.omittedColumns ? ' Unsupported or generated columns: ' + result.omittedColumns + '.' : ''));
    return result;
  });

  async function verifyDestination(captureId) {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Checking the reviewed destination rows', cancellable: true },
    (_, cancellation) => core.verifyUncertainCommit({ captureId, cancellation }));
    const destination = result.destination ? result.destination.database + '.' + result.destination.table + ': ' : '';
    const limit = 'This observes current rows. Commit history remains unconfirmed and replay stays blocked.';
    const details = result.status === 'inconclusive' ? (reasons[result.reason] || reasons['destination-unavailable']) : checkSummary(result);
    const message = destination + details + ' ' + limit + (result.historyRecorded ? '' : ' The local observation could not be saved.');
    const actions = result.historyRecorded ? ['Show Verification History'] : [];
    const selected = result.status === 'matching' ? await vscode.window.showInformationMessage(message, ...actions)
      : await vscode.window.showWarningMessage(message, ...actions);
    if (selected === 'Show Verification History') await showTransferHistory(captureId);
    return result;
  }

  command('rocketbrain.data.verifyTransferDestination', async () => {
    const saved = core.canRecover ? await core.listRecoverableSources() : [];
    const pending = saved.filter(source => source.recoveryState === 'settlement-unconfirmed');
    if (!pending.length) throw new Error('There are no saved transfers with an unconfirmed Commit.');
    const choices = pending.map(capture => ({ label: capture.database + '.' + capture.table,
      description: capture.verificationTarget && ('Destination ' + capture.verificationTarget.engine + ' · ' +
        capture.verificationTarget.database + '.' + capture.verificationTarget.table), captureId: capture.id }));
    const selected = await vscode.window.showQuickPick(choices, { title: 'Select a Transfer with an Unconfirmed Commit' });
    if (selected) return verifyDestination(selected.captureId);
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
    if (report.state === 'uncertain' && report.captureId) {
      const choice = await vscode.window.showWarningMessage(report.error.message, 'Verify Destination Rows');
      if (choice === 'Verify Destination Rows') await verifyDestination(report.captureId);
    } else if (report.state === 'uncertain') await vscode.window.showWarningMessage(report.error.message);
    else await vscode.window.showInformationMessage('Table copy ' + report.state + '.');
    return report;
  }
  command('rocketbrain.data.finishTransfer', finish);

  async function discardSaved(saved) {
    const item = await vscode.window.showQuickPick(saved.map(source => ({ label: source.database + '.' + source.table,
      description: source.recoveryState === 'settlement-unconfirmed' ? 'Commit unconfirmed' : 'Saved snapshot', source })),
    { title: 'Select a Saved Snapshot to Discard' });
    if (!item) return;
    const question = item.source.recoveryState === 'settlement-unconfirmed' ?
      'Check the destination rows before discarding the snapshot for an unconfirmed commit. Discard this snapshot?' :
      'Discard this saved snapshot?';
    const answer = await vscode.window.showWarningMessage(question, { modal: true }, 'Discard Snapshot');
    if (answer === 'Discard Snapshot') return core.discardRecoverableSource({ captureId: item.source.id });
  }

  command('rocketbrain.data.transfer', async item => {
    if (core.pending()) return finish();
    const saved = core.canRecover ? await core.listRecoverableSources() : [];
    const sources = [...core.listSources().filter(capture => !capture.recoveryState), ...saved].map(capture => ({
      label: capture.database + '.' + capture.table,
      description: capture.engine + ' · ' + capture.rowCount + ' rows' + (capture.recoveryState === 'settlement-unconfirmed' ? ' · verify destination rows' :
        capture.recoveryState ? ' · saved' : capture.mode === 'stream' ? ' · streamed' : ''), capture }));
    if (saved.length) sources.push({ label: 'Discard a Saved Snapshot', discard: true });
    if (!sources.length) throw new Error('Capture a source table with Capture Table Copy Source first.');
    const selected = await vscode.window.showQuickPick(sources, { title: 'Select Captured Source' });
    if (!selected) return;
    if (selected.discard) return discardSaved(saved);
    if (selected.capture.recoveryState === 'settlement-unconfirmed') return verifyDestination(selected.capture.id);
    const table = item?.table?.name || (await vscode.window.showQuickPick(tableChoices(), { title: 'Select Destination Table' }))?.label;
    if (!table) return;
    trusted();
    const capture = selected.capture.recoveryState ? await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Authenticating the saved source snapshot', cancellable: true
    }, (_, cancellation) => core.resumeSource({ captureId: selected.capture.id, cancellation })) : selected.capture;
    const destination = await core.inspectDestination({ captureId: capture.id, table });
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
    historyText = '';
  } };
}

module.exports = { registerTableTransfer };
