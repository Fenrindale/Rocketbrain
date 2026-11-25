'use strict';

const { randomUUID } = require('node:crypto');

const keyPrefix = 'rocketbrain.grid.review.v1:';
const scheme = 'rocketbrain-saved-grid-review';
const idPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const digestPattern = /^[a-f\d]{64}$/;
const sizeLimit = 1024 * 1024;
const maxReviews = 12;
const boundedString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

function validArchive(value) {
  if (!value || !boundedString(value.schema, 64) || !boundedString(value.table, 64) || !digestPattern.test(value.server ?? '') ||
      !digestPattern.test(value.definition ?? '') || !Array.isArray(value.operations) ||
      value.operations.length < 1 || value.operations.length > 500) return false;
  const scalar = item => item === null || typeof item === 'string' || Number.isFinite(item);
  return value.operations.every(item => {
    if (!item || !['update', 'insert', 'delete'].includes(item.type) || !boundedString(item.sql, 65536) ||
        !Array.isArray(item.parameters) || !item.parameters.every(scalar)) return false;
    if (item.exactDatasetDelete !== undefined && (item.type !== 'delete' || item.exactDatasetDelete !== true)) return false;
    if (item.type !== 'insert' && (!digestPattern.test(item.key ?? '') || !digestPattern.test(item.row ?? ''))) return false;
    return item.type === 'delete' || item.values && !Array.isArray(item.values) && typeof item.values === 'object' &&
      Object.entries(item.values).every(([name, cell]) => boundedString(name, 64) && (cell === null || typeof cell === 'string'));
  });
}

function createGridReviewStore(state, permitted) {
  let pending = Promise.resolve();
  const serialize = work => {
    const running = pending.then(work);
    pending = running.catch(() => {});
    return running;
  };
  const guard = () => { if (!permitted()) throw Error('Open a trusted workspace folder to use saved table reviews.'); };

  function get(id) {
    guard();
    if (typeof id !== 'string' || !idPattern.test(id)) return undefined;
    const item = state.get(keyPrefix + id);
    if (!item || item.id !== id || !boundedString(item.title, 96) || !Number.isFinite(item.capturedAt) ||
        item.capturedAt < 0 || item.capturedAt > 8640000000000000 ||
        !validArchive(item.archive) || Buffer.byteLength(JSON.stringify(item)) > sizeLimit) return undefined;
    return structuredClone(item);
  }

  function requireReview(id) {
    const item = get(id);
    if (!item) throw Error('The saved table edit review is unavailable.');
    return item;
  }

  function list() {
    guard();
    return state.keys().filter(key => key.startsWith(keyPrefix)).map(key => get(key.slice(keyPrefix.length))).filter(Boolean)
      .sort((a, b) => b.capturedAt - a.capturedAt).map(item => ({
        id: item.id, title: item.title, capturedAt: item.capturedAt, schema: item.archive.schema,
        table: item.archive.table, operations: item.archive.operations.length
      }));
  }

  const save = (title, archive) => serialize(async () => {
    guard();
    if (!validArchive(archive)) throw Error('The selected edit review is incomplete.');
    const name = typeof title === 'string' ? title.trim().replace(/[\x00-\x1f]/g, ' ').slice(0, 96) : '';
    const item = { id: randomUUID(), title: name || archive.table, capturedAt: Date.now(), archive };
    if (Buffer.byteLength(JSON.stringify(item)) > sizeLimit || list().length >= maxReviews) {
      throw Error('Save up to 12 table reviews of 1 MiB each. Remove an earlier review or reduce the changes.');
    }
    await state.update(keyPrefix + item.id, item);
    return { id: item.id, title: item.title, operations: archive.operations.length };
  });
  const remove = id => serialize(async () => {
    requireReview(id);
    await state.update(keyPrefix + id, undefined);
  });

  return { get, requireReview, list, save, remove };
}

function previewText(item) {
  const { title, archive } = item;
  const lines = [title, archive.schema + '.' + archive.table, new Date(item.capturedAt).toISOString(),
    '', 'Saved review for reference. Stage it on a matching editable grid and run a fresh review before applying.', ''];
  for (const [index, operation] of archive.operations.entries()) {
    lines.push((index + 1) + '. ' + operation.sql, '    ' + JSON.stringify(operation.parameters), '');
  }
  return lines.join('\n');
}

function registerGridReviewRecovery(context, vscode, tableEditor, results, command) {
  const store = createGridReviewStore(context.workspaceState,
    () => vscode.workspace.isTrusted && Boolean(vscode.workspace.workspaceFolders?.length));
  const changes = new vscode.EventEmitter();
  const uriFor = id => vscode.Uri.from({ scheme, path: '/' + id + '.txt' });
  context.subscriptions.push(changes, vscode.workspace.registerTextDocumentContentProvider(scheme, {
    onDidChange: changes.event,
    provideTextDocumentContent(uri) {
      const item = store.get(uri.path.slice(1, -4));
      return item ? previewText(item) : 'The saved table edit review is unavailable.';
    }
  }));

  async function save(resultId, reviewId, title) {
    const archive = await tableEditor.captureReview(resultId, reviewId);
    return store.save(title, archive);
  }
  async function open(id) {
    const item = store.requireReview(id), uri = uriFor(id);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    return { id, documentUri: uri.toString(), operations: item.archive.operations.length, executedSql: false };
  }
  async function stage(id, resultId) {
    const item = store.requireReview(id);
    await tableEditor.restoreReview(resultId, item.archive, () => { store.requireReview(id); });
    await results.activateResult(resultId);
    return { id, resultId, operations: item.archive.operations.length, appliedChanges: false };
  }
  async function remove(id) {
    await store.remove(id);
    changes.fire(uriFor(id));
  }
  async function choose(title) {
    const items = store.list().map(item => ({ label: item.title, detail: item.schema + '.' + item.table + ' · ' + item.operations + ' changes', item }));
    if (!items.length) throw Error('There are no saved table edit reviews in this workspace.');
    return (await vscode.window.showQuickPick(items, { title }))?.item;
  }
  command('rocketbrain.results.saveEditReview', async () => {
    const items = results.history.filter(record => record.review && record.result?.edit?.table && tableEditor.contexts.has(record.id))
      .map(record => ({ label: record.result.edit.table, description: record.tabName, record }));
    if (!items.length) throw Error('Review the current table edits before saving them.');
    const chosen = await vscode.window.showQuickPick(items, { title: 'Save Table Edit Review' });
    if (!chosen) return;
    const { record } = chosen, reviewId = record.review?.reviewId;
    const title = await vscode.window.showInputBox({ title: 'Name the Saved Table Review', value: chosen.label,
      prompt: 'Statement parameters are stored locally in this workspace.' });
    if (title !== undefined) return save(record.id, reviewId, title);
  });
  command('rocketbrain.results.openEditReview', async () => {
    const chosen = await choose('Open Saved Table Edit Review');
    if (chosen) return open(chosen.id);
  });
  command('rocketbrain.results.stageEditReview', async () => {
    const chosen = await choose('Stage Saved Table Edit Review');
    if (!chosen) return;
    const grids = results.history.filter(record => record.result?.edit?.table === chosen.table && record.result.edit.canEdit &&
      !record.readOnly && tableEditor.contexts.has(record.id))
      .map(record => ({ label: record.tabName || record.result.edit.table, description: record.source, id: record.id }));
    if (!grids.length) throw Error('Open the matching table and enable editing on its current page.');
    const selected = await vscode.window.showQuickPick(grids, { title: 'Choose the Matching Editable Grid' });
    if (selected) return stage(chosen.id, selected.id);
  });
  command('rocketbrain.results.removeEditReview', async () => {
    const chosen = await choose('Remove Saved Table Edit Review');
    if (chosen && await vscode.window.showWarningMessage('Remove ' + chosen.title + '?', { modal: true }, 'Remove') === 'Remove') {
      return remove(chosen.id);
    }
  });
  return { save, open, stage, remove, list: store.list };
}

module.exports = { createGridReviewStore, registerGridReviewRecovery };
