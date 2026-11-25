'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { prepareLocalSqlRequest, executeLocalSqlRequest, reviewSelect } = require('./local-sql-assistant');

function prepareSqlProposalBatch({ catalog, endpoint, model, selections, requests }) {
  if (!Array.isArray(requests) || requests.length < 2 || requests.length > 3 ||
      requests.some(value => typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024) ||
      new Set(requests.map(value => value.trim())).size !== requests.length) {
    throw Error('Enter two or three different proposal requests, each at most 1 KiB.');
  }
  const drafts = requests.map(input => prepareLocalSqlRequest({ catalog, endpoint, model, selections, input, mode: 'draft' }));
  const { preview: { request, ...schema }, target } = drafts[0];
  return { drafts, preview: { endpoint: target.endpoint, model: target.model, schema, requests: drafts.map(draft => draft.preview.request) } };
}

function createSqlProposalReview(prepared, { onChange = () => {}, infer = executeLocalSqlRequest } = {}) {
  const { preview, drafts } = prepared;
  const id = randomUUID();
  const jobs = drafts.map((draft, index) => ({ id: randomUUID(), slot: index + 1, status: 'pending', draft }));
  let started = false;
  let invalidated = false;

  function snapshot() {
    return structuredClone({ id, invalidated, model: preview.model, endpoint: preview.endpoint,
      dialect: preview.schema.dialect, schema: preview.schema.schema, tables: preview.schema.tables.map(table => table.name),
      jobs: jobs.map(({ id, slot, status, result, failure }) => ({ id, slot, status,
        request: invalidated ? undefined : preview.requests[slot - 1], result, failure })) });
  }

  function publish() { onChange(snapshot()); }

  function jobAt(reviewId, jobId, states) {
    const job = !invalidated && reviewId === id && jobs.find(item => item.id === jobId);
    if (!job || !states.includes(job.status)) throw Error('That proposal is no longer available for this action.');
    return job;
  }

  function stop(job, status) {
    job.status = status;
    job.controller?.abort();
    job.controller = undefined;
    job.draft = undefined;
    job.result = undefined;
    job.failure = undefined;
  }

  async function run(job) {
    const controller = new AbortController();
    const draft = job.draft;
    job.draft = undefined;
    job.controller = controller;
    job.status = 'running';
    publish();
    try {
      const answer = await infer(draft, { signal: controller.signal });
      if (job.status !== 'running' || invalidated) return;
      const verified = reviewSelect(answer.sql, draft.scope);
      const fingerprint = createHash('sha256').update(verified.sql).digest('hex');
      job.result = { sql: verified.sql, fingerprint, tables: verified.tables, explanation: answer.explanation };
      job.status = 'ready';
    } catch {
      if (job.status !== 'running' || invalidated) return;
      job.status = 'failed';
      job.failure = 'The local model did not return a statically reviewable SQL proposal.';
    } finally {
      if (job.controller === controller) job.controller = undefined;
      publish();
    }
  }

  return {
    snapshot,
    async start() {
      if (started || invalidated) throw Error('This proposal batch has already started or closed.');
      started = true;
      await Promise.all(jobs.map(run));
      return snapshot();
    },
    cancel(reviewId, jobId) {
      stop(jobAt(reviewId, jobId, ['running']), 'cancelled');
      publish();
    },
    reject(reviewId, jobId, fingerprint) {
      const job = jobAt(reviewId, jobId, ['ready', 'reviewed']);
      if (job.result.fingerprint !== fingerprint) throw Error('Review the current SQL proposal again.');
      stop(job, 'rejected');
      publish();
    },
    read(reviewId, jobId, fingerprint, { reviewedOnly = false } = {}) {
      const job = jobAt(reviewId, jobId, reviewedOnly ? ['reviewed'] : ['ready', 'reviewed']);
      if (job.result.fingerprint !== fingerprint) throw Error('Review the current SQL proposal again.');
      return structuredClone(job.result);
    },
    accept(reviewId, jobId, fingerprint) {
      const job = jobAt(reviewId, jobId, ['ready']);
      if (job.result.fingerprint !== fingerprint) throw Error('Review the current SQL proposal again.');
      job.status = 'reviewed';
      publish();
    },
    invalidate() {
      if (!invalidated) {
        invalidated = true;
        for (const job of jobs) stop(job, 'stale');
        publish();
      }
    }
  };
}

module.exports = { prepareSqlProposalBatch, createSqlProposalReview };
