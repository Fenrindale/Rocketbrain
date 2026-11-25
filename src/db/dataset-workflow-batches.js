'use strict';

const { randomUUID } = require('node:crypto');

const storageKey = 'rocketbrain.datasetComparison.batches.v1';
const limits = { batches: 20, workflows: 16, durationMs: 30 * 60 * 1000 };
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const counts = ['equal', 'changed', 'targetOnly', 'sourceOnly'];
const validName = name => typeof name === 'string' && name.trim().length > 0 &&
  name.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(name);
const validIds = ids => Array.isArray(ids) && ids.length >= 2 && ids.length <= limits.workflows &&
  ids.every(id => typeof id === 'string' && idPattern.test(id)) && new Set(ids).size === ids.length;

function createDatasetBatches(storage, workflows) {
  let pendingUpdate = Promise.resolve();
  const list = () => {
    const loaded = storage.get(storageKey, []);
    if (!Array.isArray(loaded)) return [];
    return loaded.filter(item => item && typeof item.id === 'string' && idPattern.test(item.id) &&
      validName(item.name) && validIds(item.workflows)).slice(0, limits.batches)
      .map(({ id, name, workflows }) => ({ id, name, workflows: [...workflows] }));
  };
  function write(change) {
    const result = pendingUpdate.then(() => storage.update(storageKey, change(list())));
    pendingUpdate = result.catch(() => {});
    return result;
  }
  async function save(name, ids) {
    if (!validName(name)) throw Error('Enter a dataset batch name of 1–80 characters.');
    if (!validIds(ids)) throw Error('Choose 2–16 distinct saved comparisons.');
    const batch = { id: randomUUID(), name: name.trim(), workflows: [...ids] };
    await write(current => {
      const available = new Set(workflows.list().map(item => item.id));
      if (batch.workflows.some(id => !available.has(id))) throw Error('Choose current saved comparisons for this batch.');
      if (current.length >= limits.batches) throw Error('Remove an unused dataset batch before saving another.');
      return [...current, batch];
    });
    return structuredClone(batch);
  }
  function remove(id) {
    return write(current => {
      if (!current.some(item => item.id === id)) throw Error('Choose a current dataset batch.');
      return current.filter(item => item.id !== id);
    });
  }
  async function replay(id, { cancellation, onProgress } = {}) {
    const batch = list().find(item => item.id === id);
    if (!batch) throw Error('Choose a current dataset batch.');
    const workflowsAtStart = new Map(workflows.list().map(item => [item.id, item]));
    const startedAt = new Date().toISOString(), deadline = performance.now() + limits.durationMs;
    const results = [], totals = Object.fromEntries(counts.map(key => [key, 0]));
    const stop = { get isCancellationRequested() { return Boolean(cancellation?.isCancellationRequested) || performance.now() >= deadline; } };
    for (const [index, workflowId] of batch.workflows.entries()) {
      if (stop.isCancellationRequested) break;
      const workflow = workflowsAtStart.get(workflowId);
      if (!workflow) {
        results.push({ workflowId, state: 'unavailable' });
        continue;
      }
      const position = { index: index + 1, total: batch.workflows.length, workflowId, name: workflow.name };
      await onProgress?.({ ...position, comparedKeys: 0 });
      if (stop.isCancellationRequested) break;
      try {
        const report = await workflows.replay(workflowId, { cancellation: stop,
          onProgress: comparedKeys => onProgress?.({ ...position, comparedKeys }) });
        for (const key of counts) totals[key] += report.summary[key];
        results.push({ workflowId, name: workflow.name, source: report.source, target: report.target, state: 'completed',
          summary: report.summary, omittedDifferences: report.omitted,
          ...(report.snapshots ? { snapshots: report.snapshots } : { snapshotStartedAt: report.snapshotStartedAt }) });
      } catch (error) {
        if (stop.isCancellationRequested) break;
        results.push({ workflowId, name: workflow.name, state: 'failed',
          message: error?.code === 'ROCKETBRAIN_DATASET_WORKFLOW' ? error.message : 'This saved comparison could not be replayed.' });
      }
    }
    const completed = results.filter(item => item.state === 'completed').length;
    let state = completed === batch.workflows.length ? 'completed' : completed ? 'partial' : 'failed';
    if (results.length < batch.workflows.length && stop.isCancellationRequested) {
      state = cancellation?.isCancellationRequested ? 'cancelled' : 'timed-out';
    }
    return { id: randomUUID(), batch, startedAt, finishedAt: new Date().toISOString(), state, completed,
      remaining: batch.workflows.length - results.length, totals, results };
  }
  return { list, save, remove, replay };
}

module.exports = { createDatasetBatches };
