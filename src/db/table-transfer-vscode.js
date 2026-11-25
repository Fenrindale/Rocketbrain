'use strict';

const path = require('node:path');
const { createTableTransfer } = require('./table-transfer');
const { createTransferRecovery } = require('./table-transfer-recovery');
const { createTransferHistory, historyLimits, verificationReviewDecisions, publishNewJson } = require('./table-transfer-history');
const { createTransferRuns, transferRunLimits } = require('./table-transfer-runs');

const historyCommand = 'rocketbrain.data.transferVerificationHistory';
const reviewCommand = 'rocketbrain.data.reviewTransferVerification';
const exportCommand = 'rocketbrain.data.exportTransferVerificationHistory';
const fullVerificationCommand = 'rocketbrain.data.verifyAllTransferKeys';
const recoveryPlanCommand = 'rocketbrain.data.previewTransferRecovery';
const runsCommand = 'rocketbrain.data.showTransferVerificationRuns';
const recoverySqlCommand = 'rocketbrain.data.previewTransferRecoverySql';
const historyScheme = 'rocketbrain-table-copy-history';
const recoveryPlanScheme = 'rocketbrain-table-copy-recovery';
const runsScheme = 'rocketbrain-table-copy-runs';
const recoverySqlScheme = 'rocketbrain-table-copy-recovery-sql';
const statusLabels = { matching: 'Matching', missing: 'Missing keys', mismatch: 'Different values', inconclusive: 'Inconclusive' };
const runLabels = { running: 'Running in this window', 'last-checkpoint': 'Last checkpoint without a local run',
  cancelled: 'Cancelled', complete: 'Complete', inconclusive: 'Inconclusive', failed: 'Failed' };
const statementLabels = { 'audit-key': 'Read the current mapped values for one reviewed key',
  'insert-missing-key': 'Insert one reviewed key if it is still absent',
  'update-unchanged-key': 'Update one reviewed key if its mapped values still match the audit' };
const reviewDetails = {
  acknowledged: 'Record that you read the destination observation.',
  'follow-up-required': 'Flag the observation for further investigation.',
  'external-resolution-recorded': 'Record that the case was handled outside Rocketbrain.'
};
const reasons = {
  'missing-review-evidence': 'This saved transfer has no destination evidence.',
  'primary-key-not-mapped': 'The review did not map every destination primary-key column.',
  'no-bounded-keys': 'The sampled destination keys exceeded the verification limit.',
  'destination-identity-changed': 'Connect to the reviewed server, database, endpoint and account.',
  'destination-definition-changed': 'The reviewed table definition is different or unavailable.',
  'destination-unavailable': 'The reviewed destination could not be opened for a read-only check.',
  'sample-unreadable': 'The sampled destination rows could not be read exactly.',
  'full-evidence-unavailable': 'Full key verification needs a retained snapshot with a complete mapping reviewed by this version.',
  'retained-snapshot-unavailable': 'The encrypted source snapshot could not be authenticated and read to the end.',
  'retained-snapshot-metadata-changed': 'The encrypted source file identity changed before or during verification.',
  'retained-snapshot-authentication-failed': 'The encrypted source rows failed authentication.',
  'retained-evidence-changed': 'The retained commit evidence changed during verification.',
  'destination-verification-interrupted': 'The dedicated read-only verification connection closed or stopped being current.',
  'full-page-unreadable': 'A destination key page could not be compared exactly.'
};
const recoveryStepLabels = {
  'verify-all-keys': 'Run Verify All Table Copy Keys with the reviewed destination connected.',
  'recheck-destination': 'Confirm the server, account and table definition used in the original review.',
  'investigate-missing-keys': 'Investigate missing keys and later deletions with the destination owner.',
  'investigate-different-values': 'Check later edits and the expected mapped values with the destination owner.',
  'review-observation': 'Use Review Table Copy Verification to record your review of this observation.',
  'confirm-transaction-externally': 'Use independent transaction records to establish the original Commit outcome.',
  'retain-replay-fence': 'Keep the saved snapshot locked while deciding on any recovery outside this preview.'
};

function checkSummary(result) {
  const scope = result.coverage === 'all-reviewed-keys' ? 'all reviewed keys' : 'sampled reviewed keys';
  const pages = result.method === 'full-mapped-keys' ? ' · ' + result.pages + ' pages' : '';
  return result.checkedKeys + ' / ' + result.rows + ' keys checked (' + scope + ') · ' +
    result.matching + ' matching · ' + result.missing + ' missing · ' + result.mismatch + ' different' + pages + '.';
}

function observationDetail(entry) {
  return entry.reason ? reasons[entry.reason] : checkSummary(entry);
}

function registerTableTransfer(context, vscode, { database }) {
  const storagePath = context.storageUri?.fsPath;
  const isTrusted = () => !closed && vscode.workspace.isTrusted;
  const recovery = createTransferRecovery({ storagePath, secrets: context.secrets, isTrusted });
  const history = storagePath && createTransferHistory({ storagePath, isTrusted });
  const runs = storagePath && createTransferRuns({ storagePath, isTrusted });
  const core = createTableTransfer(database, { recovery, history, runs });
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
    const entries = await core.listTransferVerificationEvidence({ captureId });
    trusted();
    historyText = [
      'Table Copy Verification History',
      'This workspace retains ' + historyLimits.entries + ' observations for up to ' + historyLimits.ageMs / 86400000 + ' days.',
      'Observations report the destination at the time of each check. Commit history remains unconfirmed and replay stays blocked.',
      'Use Review Table Copy Verification to record one decision per latest observation. Use Export Table Copy Verification History to save this evidence as JSON.',
      ...(captureId ? ['Capture ' + captureId] : []),
      '',
      ...(entries.length ? entries.flatMap(entry => [
        entry.recordedAt + ' · ' + statusLabels[entry.status] + ' · Capture ' + entry.captureId,
        observationDetail(entry),
        ...(entry.review ? ['Review · ' + verificationReviewDecisions[entry.review.decision] + ' · ' + entry.review.reviewedAt] : []),
        ''
      ]) : ['No verification observations are available.'])
    ].join('\n');
    historyChanged.fire(historyUri);
    const document = await vscode.workspace.openTextDocument(historyUri);
    await vscode.window.showTextDocument(document, { preview: false });
    return entries;
  }
  command(historyCommand, () => showTransferHistory());

  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(runsScheme, {
    async provideTextDocumentContent(uri) {
      if (!isTrusted()) return '';
      const captureId = uri.path.split('/').filter(Boolean)[0];
      const entries = await core.listTransferVerificationRuns({ captureId: captureId === 'all' ? undefined : captureId });
      return [
        'Table Copy Verification Runs',
        'The workspace keeps up to ' + transferRunLimits.entries + ' runs for ' + transferRunLimits.days + ' days.',
        'Each attempt opens a fresh read-only destination snapshot. Pages from earlier attempts are historical progress.',
        'Use Table Copy Verification History for completed observations. Run this command again to refresh the checkpoints.',
        '',
        ...(entries.length ? entries.flatMap(entry => [
          runLabels[entry.state] + ' · Capture ' + entry.captureId,
          'Started ' + entry.startedAt + ' · Checkpoint ' + entry.checkpointAt,
          entry.checkedKeys + ' / ' + entry.rows + ' keys examined · ' + entry.pages + ' pages',
          ''
        ]) : ['No verification runs are available.'])
      ].join('\n');
    }
  }));

  async function showTransferVerificationRuns(captureId) {
    const entries = await core.listTransferVerificationRuns({ captureId });
    const uri = vscode.Uri.parse(runsScheme + ':/' + (captureId || 'all') + '/Table Copy Verification Runs.txt')
      .with({ query: String(Date.now()) });
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    return entries;
  }
  command(runsCommand, showTransferVerificationRuns);

  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(recoveryPlanScheme, {
    async provideTextDocumentContent(uri) {
      if (!isTrusted()) return '';
      try {
        const plan = await core.validateTransferRecoveryPlan({ planId: uri.path.split('/').filter(Boolean)[0] });
        const { observation } = plan;
        return [
          'Table Copy Recovery Preview',
          'Capture ' + plan.captureId,
          'Observation ' + observation.recordedAt + ' · ' + statusLabels[observation.status],
          observationDetail(observation),
          observation.review ? 'Operator review · ' + verificationReviewDecisions[observation.review.decision] +
            ' · ' + observation.review.reviewedAt : 'Operator review pending.',
          plan.snapshot.retained ? 'Saved source retained through ' + new Date(plan.snapshot.expiresAt).toISOString() + '.' :
            'Saved source unavailable. This preview uses retained verification history.',
          'The observation describes the destination at check time. Commit history remains unconfirmed and replay stays blocked.',
          '',
          ...plan.steps.map((step, index) => (index + 1) + '. ' + recoveryStepLabels[step]),
          '',
          'Open a new preview after recording another observation or review.'
        ].join('\n');
      } catch {
        return 'Recovery evidence changed or the preview expired. Run Preview Table Copy Recovery again.';
      }
    }
  }));

  async function previewTransferRecovery(captureId) {
    if (captureId === undefined) {
      const latest = new Map();
      for (const entry of await core.listTransferVerificationEvidence()) {
        if (!latest.has(entry.captureId)) latest.set(entry.captureId, entry);
      }
      const choices = [...latest.values()].map(entry => ({ label: statusLabels[entry.status] + ' · ' + entry.recordedAt,
        description: 'Capture ' + entry.captureId, detail: observationDetail(entry), captureId: entry.captureId }));
      if (!choices.length) throw Error('Verify destination rows before preparing a recovery preview.');
      const choice = await vscode.window.showQuickPick(choices, { title: 'Choose a Transfer Recovery Preview' });
      if (!choice) return;
      captureId = choice.captureId;
    }
    const plan = await core.prepareTransferRecoveryPlan({ captureId });
    const uri = vscode.Uri.parse(recoveryPlanScheme + ':/' + plan.planId + '/Table Copy Recovery.txt');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return plan;
  }
  command(recoveryPlanCommand, captureId => previewTransferRecovery(captureId));

  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(recoverySqlScheme, {
    async provideTextDocumentContent(uri) {
      if (!isTrusted()) return '';
      try {
        const plan = await core.validateTransferRecoverySql({ reviewId: uri.path.split('/').filter(Boolean)[0] });
        const { observation, destination } = plan;
        return [
          'Table Copy Recovery SQL Review',
          'Capture ' + plan.captureId + ' · Observation ' + observation.observationId,
          destination.engine + ' · ' + destination.database + '.' + destination.table,
          observationDetail(observation),
          'Marked for follow-up ' + observation.review.reviewedAt + ' · Review expires ' + new Date(plan.expiresAt).toISOString(),
          '',
          'Confirm the original Commit outcome using independent transaction records. The replay fence remains active.',
          'Coordinate any external patch with the destination owner after reviewing later edits, key collisions, constraints and defaults.',
          'Bind one exact reviewed key and compare the current key and mapped values with the source. An audit overflow flag of 1 means the values are unavailable.',
          'For a missing row, bind desired values from that source row, including the identical reviewed key. For a changed row, bind the exact values from a fresh audit.',
          'Use a prepared statement with explicit SQL NULLs and exact numeric strings or binary buffers as appropriate.',
          'If the destination owner approves an external patch, check the affected row and resulting values before committing.',
          'Rocketbrain displays these templates in a read-only document.',
          ...plan.statements.flatMap(statement => [
            '', statementLabels[statement.kind], statement.sql,
            ...(statement.overflowFlag ? ['Audit overflow flag ' + statement.overflowFlag] : []),
            ...statement.parameters.map(({ column, type, value }, index) =>
              (index + 1) + '. ' + value + ' · ' + JSON.stringify(column) + ' · ' + type)
          ])
        ].join('\n');
      } catch {
        return 'The destination or verification evidence changed, or the review expired. Run Review Table Copy Recovery SQL again.';
      }
    }
  }));

  async function previewTransferRecoverySql(captureId) {
    if (captureId === undefined) {
      const latest = new Map();
      for (const entry of await core.listTransferVerificationEvidence()) {
        if (!latest.has(entry.captureId)) latest.set(entry.captureId, entry);
      }
      const choices = [...latest.values()].filter(entry => entry.coverage === 'all-reviewed-keys' &&
        entry.review?.decision === 'follow-up-required' && (entry.missing || entry.mismatch))
        .map(entry => ({ label: statusLabels[entry.status] + ' · ' + entry.recordedAt,
          description: 'Capture ' + entry.captureId, detail: observationDetail(entry), captureId: entry.captureId }));
      if (!choices.length) throw Error('Verify all destination keys and mark the latest discrepancy for follow-up.');
      const choice = await vscode.window.showQuickPick(choices, { title: 'Choose a Reviewed Transfer Discrepancy' });
      if (!choice) return;
      captureId = choice.captureId;
    }
    const plan = await core.prepareTransferRecoverySql({ captureId });
    const uri = vscode.Uri.parse(recoverySqlScheme + ':/' + plan.reviewId + '/Table Copy Recovery SQL.txt');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    return plan;
  }
  command(recoverySqlCommand, previewTransferRecoverySql);

  async function reviewTransferVerification(captureId) {
    if (captureId === undefined) {
      const latest = new Map();
      for (const entry of await core.listTransferVerificationEvidence()) {
        if (!latest.has(entry.captureId)) latest.set(entry.captureId, entry);
      }
      const choices = [...latest.values()].filter(entry => !entry.review).map(entry => ({
        label: statusLabels[entry.status] + ' · ' + entry.recordedAt,
        description: 'Capture ' + entry.captureId,
        detail: observationDetail(entry),
        captureId: entry.captureId
      }));
      if (!choices.length) throw Error('There are no latest observations awaiting an operator review.');
      const selected = await vscode.window.showQuickPick(choices, { title: 'Select Verification Evidence to Review' });
      if (!selected) return;
      captureId = selected.captureId;
    }
    const { reviewId, observation } = await core.prepareTransferVerificationReview({ captureId });
    const choices = Object.entries(verificationReviewDecisions).map(([decision, label]) => ({ decision, label, detail: reviewDetails[decision] }));
    const choice = await vscode.window.showQuickPick(choices, {
      title: 'Verification Review · ' + statusLabels[observation.status] + ' · ' + observation.recordedAt
    });
    if (!choice) return;
    const answer = await vscode.window.showWarningMessage(choice.label + '?', {
      modal: true,
      detail: 'Capture ' + captureId + '\n' + observationDetail(observation) +
        '\nThe decision is recorded with this observation. Commit history remains unconfirmed and replay stays blocked.'
    }, 'Record Review');
    if (answer !== 'Record Review') return;
    trusted();
    const reviewed = await core.recordTransferVerificationReview({ reviewId, decision: choice.decision });
    await showTransferHistory(captureId);
    return reviewed;
  }
  command(reviewCommand, () => reviewTransferVerification());

  async function exportTransferVerificationHistory({ uri, captureId } = {}) {
    trusted();
    if (uri?.scheme !== 'file' || uri.authority || typeof uri.fsPath !== 'string' ||
        !path.isAbsolute(uri.fsPath) || path.extname(uri.fsPath).toLowerCase() !== '.json') {
      throw Error('Choose a local JSON file for the table copy verification history.');
    }
    const observations = await core.listTransferVerificationEvidence({ captureId });
    const report = {
      format: 'RocketbrainTableCopyVerificationHistory', version: 1, exportedAt: new Date().toISOString(), observations
    };
    try { await publishNewJson(uri.fsPath, report, trusted); }
    catch (error) {
      if (error.code === 'EEXIST') throw Error('Choose a new file name to preserve the existing export.');
      throw error;
    }
    return { uri: uri.toString(), observations: observations.length, reviewed: observations.filter(item => item.review).length };
  }
  command(exportCommand, async () => {
    const uri = await vscode.window.showSaveDialog({ title: 'Export Table Copy Verification History', filters: { JSON: ['json'] } });
    if (!uri) return;
    const result = await exportTransferVerificationHistory({ uri });
    await vscode.window.showInformationMessage(result.observations + ' table copy verification observations exported.');
    return result;
  });

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

  async function verifyDestination(captureId, full = false) {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: full ? 'Checking all reviewed destination keys' : 'Checking the reviewed destination rows', cancellable: true },
    (progress, cancellation) => full ? core.verifyAllTransferKeys({ captureId, cancellation, onProgress: state => {
      progress.report({ message: state.stage === 'inspect-destination' ? 'Checking the reviewed destination' :
        state.checkedKeys + ' / ' + state.rows + ' keys examined' });
    } }) : core.verifyUncertainCommit({ captureId, cancellation }));
    const destination = result.destination ? result.destination.database + '.' + result.destination.table + ': ' : '';
    const limit = 'This observes current rows. Commit history remains unconfirmed and replay stays blocked.';
    const details = result.status === 'inconclusive' ? (reasons[result.reason] || reasons['destination-unavailable']) : checkSummary(result);
    const message = destination + details + ' ' + limit + (result.historyRecorded ? '' : ' The local observation could not be saved.') +
      (full && !result.runRecorded ? ' The final run checkpoint could not be saved.' : '');
    const actions = result.historyRecorded ? ['Review Evidence', 'Preview Recovery', 'Show Verification History'] : [];
    if (full && result.runRecorded) actions.push('Show Verification Runs');
    const selected = result.status === 'matching' ? await vscode.window.showInformationMessage(message, ...actions)
      : await vscode.window.showWarningMessage(message, ...actions);
    if (selected === 'Review Evidence') await reviewTransferVerification(captureId);
    else if (selected === 'Preview Recovery') await previewTransferRecovery(captureId);
    else if (selected === 'Show Verification History') await showTransferHistory(captureId);
    else if (selected === 'Show Verification Runs') await showTransferVerificationRuns(captureId);
    return result;
  }

  async function chooseDestinationVerification(full = false) {
    const saved = core.canRecover ? await core.listRecoverableSources() : [];
    const pending = saved.filter(source => source.recoveryState === 'settlement-unconfirmed' && (!full || source.fullVerificationAvailable));
    if (!pending.length) throw new Error(full ? 'No saved unconfirmed transfer has a complete reviewed key mapping for full verification.' :
      'There are no saved transfers with an unconfirmed Commit.');
    const choices = pending.map(capture => ({ label: capture.database + '.' + capture.table,
      description: capture.verificationTarget && ('Destination ' + capture.verificationTarget.engine + ' · ' +
        capture.verificationTarget.database + '.' + capture.verificationTarget.table), captureId: capture.id }));
    const selected = await vscode.window.showQuickPick(choices, { title: 'Select a Transfer with an Unconfirmed Commit' });
    if (selected) return verifyDestination(selected.captureId, full);
  }
  command('rocketbrain.data.verifyTransferDestination', () => chooseDestinationVerification());
  command(fullVerificationCommand, () => chooseDestinationVerification(true));

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

  return { ...core, exportTransferVerificationHistory, async dispose() {
    if (closed) return;
    closed = true;
    for (const subscription of subscriptions) subscription.dispose();
    await core.dispose();
    documents.clear();
    historyText = '';
  } };
}

module.exports = { registerTableTransfer };
