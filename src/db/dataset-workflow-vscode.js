'use strict';

const { createDatasetWorkflows, limits } = require('./dataset-workflow');

function registerDatasetWorkflows(context, vscode, command, options) {
  const scheme = 'rocketbrain-dataset-workflow';
  const workflows = createDatasetWorkflows(context.workspaceState, options.withConnection);
  let visible;
  const list = () => {
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before opening saved dataset comparisons.');
    return workflows.list();
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) {
      if (!vscode.workspace.isTrusted || visible?.uri.toString() !== uri.toString()) return 'Replay this saved comparison to see the current report.';
      return visible.text;
    }
  }));

  const storedItem = async placeHolder => (await vscode.window.showQuickPick(list().map(item => ({
    label: item.name, description: `${item.source} → ${item.target}`, item
  })), { placeHolder }))?.item;

  async function replay(id, { cancellation, onProgress } = {}) {
    const report = await workflows.replay(id, { cancellation, onProgress });
    const uri = vscode.Uri.from({ scheme, path: `/${report.id}/Dataset comparison.json` });
    visible = { uri, report, text: JSON.stringify({ snapshotStartedAt: report.snapshotStartedAt, comparisonCompletedAt: report.created,
      source: report.source, destination: report.target,
      summary: report.summary, omittedDifferences: report.omitted, sample: report.sample }, null, 2) + '\n' };
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return { ...structuredClone(report), uri: uri.toString() };
  }

  command('rocketbrain.createDatasetWorkflow', async () => {
    const names = options.tableNames();
    const target = await vscode.window.showQuickPick(names, { placeHolder: 'Choose the destination table' });
    if (!target) return;
    const source = await vscode.window.showQuickPick(names.filter(name => name !== target), { placeHolder: 'Choose the source table' });
    if (!source) return;
    const offered = await workflows.inspect({ target, source });
    const picked = await vscode.window.showQuickPick(offered.payload.map(pair => ({ label: pair.target, pair })), {
      placeHolder: 'Select matching payload columns for comparison', canPickMany: true
    });
    if (!picked?.length) return;
    if (picked.length + offered.keys.length > limits.columns) throw Error('Compare at most 32 mapped columns, including the primary key.');
    const name = await vscode.window.showInputBox({ title: 'Save Dataset Comparison', prompt: 'Name the table and column mapping', value: `${source} → ${target}` });
    if (name === undefined) return;
    const id = await workflows.save({ target, source, name, mapping: picked.map(item => item.pair) });
    await vscode.window.showInformationMessage('Saved the dataset comparison for this workspace. Run it from Replay Saved Dataset Comparison.');
    return id;
  });
  command('rocketbrain.replayDatasetWorkflow', async id => {
    id ||= (await storedItem('Choose a saved dataset comparison'))?.id;
    if (!id) return;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Compare saved datasets', cancellable: true },
      (progress, cancellation) => replay(id, { cancellation, onProgress: compared => progress.report({ message: `${compared} primary keys compared` }) }));
  });
  command('rocketbrain.removeDatasetWorkflow', async () => {
    const selected = await storedItem('Choose a saved comparison to remove');
    if (selected) await workflows.remove(selected.id);
  });
  async function stage(reportId, recordId, indices) {
    return options.stage(recordId, async (target, assertCurrent) => workflows.reconcile(reportId, target, indices, assertCurrent));
  }
  command('rocketbrain.stageDatasetWorkflow', async () => {
    const report = visible?.report;
    if (!report || vscode.window.activeTextEditor?.document.uri.toString() !== visible.uri.toString()) {
      throw Error('Open the current saved comparison report before staging changes.');
    }
    const targets = options.openTargets(report.target);
    if (!targets.length) throw Error('Open the destination table and enable editing before staging changes.');
    const target = targets.length === 1 ? targets[0] : (await vscode.window.showQuickPick(targets.map(item => ({
      label: `Table result ${item.id}`, detail: item.label, item
    })), { placeHolder: 'Choose the current editable destination page' }))?.item;
    if (!target) return;
    const chosen = await vscode.window.showQuickPick(report.sample.filter(row => row.state === 'changed').map(row => ({
      label: row.key.join(' · '), description: row.changes.map(change => change.target).join(', '), index: row.index
    })), { canPickMany: true, placeHolder: 'Select changed rows visible on the destination page' });
    if (!chosen?.length) return;
    await stage(report.id, target.id, chosen.map(item => item.index));
  });

  const remove = id => { list(); return workflows.remove(id); };
  return { list, inspect: workflows.inspect, save: workflows.save, remove, replay, stage };
}

module.exports = { registerDatasetWorkflows };
