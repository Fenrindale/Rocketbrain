'use strict';

const { createDatasetWorkflows, limits } = require('./dataset-workflow');
const { createDatasetBatches } = require('./dataset-workflow-batches');

function registerDatasetWorkflows(context, vscode, command, options) {
  const scheme = 'rocketbrain-dataset-workflow';
  const workflows = createDatasetWorkflows(context.workspaceState, options.withConnection, options.profileSource);
  const batches = createDatasetBatches(context.workspaceState, workflows);
  let visible, visibleBatch, comparing = false;
  const list = () => {
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before opening saved dataset comparisons.');
    return workflows.list();
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) {
      if (vscode.workspace.isTrusted) {
        const target = uri.toString();
        if (visible?.uri.toString() === target) return visible.text;
        if (visibleBatch?.uri.toString() === target) return visibleBatch.text;
      }
      return 'Replay this saved comparison to see the current report.';
    }
  }));

  async function compare(action) {
    list();
    if (comparing) throw Error('Wait for the current dataset comparison to finish.');
    comparing = true;
    try { return await action(); }
    finally { comparing = false; }
  }

  const storedItem = async placeHolder => (await vscode.window.showQuickPick(list().map(item => ({
    label: item.name, description: `${item.source} → ${item.target}${item.sourceProfile ? ' · separate server' : ''}`, item
  })), { placeHolder }))?.item;

  async function replay(id, { cancellation, onProgress } = {}) {
    return compare(async () => {
      const report = await workflows.replay(id, { cancellation, onProgress });
      const uri = vscode.Uri.from({ scheme, path: `/${report.id}/Dataset comparison.json` });
      const timing = report.snapshots ? { workflowName: report.workflowName, snapshotScope: report.snapshotScope, snapshots: report.snapshots }
        : { snapshotStartedAt: report.snapshotStartedAt };
      visible = { uri, report, text: JSON.stringify({ ...timing, comparisonCompletedAt: report.created,
        source: report.source, destination: report.target,
        summary: report.summary, oneSided: report.oneSided, omittedDifferences: report.omitted, sample: report.sample }, null, 2) + '\n' };
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      return { ...structuredClone(report), uri: uri.toString() };
    });
  }

  const listBatches = () => { list(); return batches.list(); };
  const saveBatch = (name, ids) => { list(); return batches.save(name, ids); };
  const removeBatch = id => { list(); return batches.remove(id); };
  const pickBatch = async placeHolder => (await vscode.window.showQuickPick(listBatches().map(item => ({
    label: item.name, description: item.workflows.length + ' comparisons', item
  })), { placeHolder }))?.item;

  async function replayBatch(id, { cancellation, onProgress } = {}) {
    return compare(async () => {
      visible = undefined;
      const report = await batches.replay(id, { cancellation, onProgress });
      const uri = vscode.Uri.from({ scheme, path: `/${report.id}/Dataset batch report.json` });
      visibleBatch = { uri, text: JSON.stringify(report, null, 2) + '\n' };
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      return { ...structuredClone(report), uri: uri.toString() };
    });
  }

  command('rocketbrain.createDatasetBatch', async () => {
    const selected = await vscode.window.showQuickPick(list().map(item => ({
      label: item.name, description: `${item.source} → ${item.target}`, id: item.id
    })), { canPickMany: true, placeHolder: 'Choose saved comparisons to run in one batch' });
    if (!selected?.length) return;
    const name = await vscode.window.showInputBox({ title: 'Save Dataset Batch', prompt: 'Name this collection of saved comparisons' });
    if (name === undefined) return;
    return saveBatch(name, selected.map(item => item.id));
  });

  command('rocketbrain.replayDatasetBatch', async id => {
    id ||= (await pickBatch('Choose a saved dataset batch'))?.id;
    if (!id) return;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Compare dataset batch', cancellable: true },
      (progress, cancellation) => replayBatch(id, { cancellation, onProgress: ({ index, total, name, comparedKeys }) =>
        progress.report({ message: `${index}/${total} · ${name} · ${comparedKeys} primary keys compared` }) }));
  });

  command('rocketbrain.removeDatasetBatch', async () => {
    const selected = await pickBatch('Choose a dataset batch to remove');
    if (selected) return removeBatch(selected.id);
  });

  command('rocketbrain.createDatasetWorkflow', async () => {
    const names = options.tableNames();
    const target = await vscode.window.showQuickPick(names, { placeHolder: 'Choose the destination table' });
    if (!target) return;
    const profiles = workflows.sourceProfiles();
    const choice = profiles.length ? await vscode.window.showQuickPick([
      { label: 'Active database schema' }, ...profiles.map(profile => ({ label: profile.label, description: profile.description, profile }))
    ], { placeHolder: 'Choose the source schema or saved profile on a separate server' }) : {};
    if (!choice) return;
    const sourceProfile = choice.profile && { id: choice.profile.id, revision: choice.profile.revision };
    const sources = sourceProfile ? await workflows.sourceTableNames(sourceProfile) : names.filter(name => name !== target);
    const source = await vscode.window.showQuickPick(sources, { placeHolder: 'Choose the source table' });
    if (!source) return;
    const selection = { target, source, ...(sourceProfile && { sourceProfile }) };
    const offered = await workflows.inspect(selection);
    const columns = offered.matches ?? offered.payload.map(pair => ({ target: pair.target, sources: [pair.source] }));
    const picked = await vscode.window.showQuickPick(columns.map(column => ({ label: column.target, column })), {
      placeHolder: 'Select destination payload columns for comparison', canPickMany: true
    });
    if (!picked?.length) return;
    if (picked.length + offered.keys.length > limits.columns) throw Error('Compare at most 32 mapped columns, including the primary key.');
    const mapping = [];
    for (const { column } of picked) {
      const used = new Set(mapping.map(pair => pair.source));
      const choices = column.sources.filter(name => !used.has(name)).sort((a, b) => (b === column.target) - (a === column.target));
      if (!choices.length) throw Error('Choose a distinct compatible source column for each destination column.');
      const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices,
        { placeHolder: `Choose the source column for ${column.target}` });
      if (!selected) return;
      mapping.push({ target: column.target, source: selected });
    }
    const value = `${choice.profile ? choice.profile.label + ' / ' : ''}${source} → ${target}`.slice(0, 80);
    const name = await vscode.window.showInputBox({ title: 'Save Dataset Comparison', prompt: 'Name the table and column mapping', value });
    if (name === undefined) return;
    const id = await workflows.save({ ...selection, name, mapping });
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
  async function stage(reportId, recordId, indices, selection) {
    if (comparing) throw Error('Wait for the current dataset comparison to finish.');
    return options.stage(recordId, async (target, assertCurrent) => workflows.reconcile(reportId, target, indices, assertCurrent, selection));
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
    const chosen = await vscode.window.showQuickPick(report.sample.filter(row => row.state === 'changed' || row.operation).map(row => ({
      label: row.key.join(' · '),
      description: { insert: 'Insert source row', delete: 'Delete destination row' }[row.operation] ??
        'Update ' + row.changes.map(change => change.target).join(', '),
      index: row.index
    })), { canPickMany: true, placeHolder: 'Select destination operations to stage for SQL review' });
    if (!chosen?.length) return;
    await stage(report.id, target.id, chosen.map(item => item.index), { includeOneSided: true });
  });

  const remove = id => { list(); return workflows.remove(id); };
  return { list, inspect: workflows.inspect, save: workflows.save, remove, replay, stage,
    batches: { list: listBatches, save: saveBatch, remove: removeBatch, replay: replayBatch },
    sourceProfiles: workflows.sourceProfiles, sourceTableNames: workflows.sourceTableNames };
}

module.exports = { registerDatasetWorkflows };
