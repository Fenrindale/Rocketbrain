'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { prepareIsolatedAgent, runIsolatedAgent } = require('../ai/acp-isolated-peer');
const { projectGrounding, prepareGroundedIntent, compileGroundedQuery } = require('./local-sql-grounding');

async function prepareDatabaseAgents(profiles, localModel) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 3) throw Error('Select up to three database ACP profiles.');
  const agents = await Promise.all(profiles.map(input => prepareIsolatedAgent(input, localModel)));
  if (new Set(agents.map(agent => agent.label)).size !== agents.length) throw Error('Choose distinctly named ACP profiles.');
  return agents;
}

async function executeDatabaseAgent(agent, intent, { signal, onUpdate } = {}) {
  const reply = await runIsolatedAgent(agent, { text: intent.text, schema: intent.schema, schemaName: 'rocketbrain_acp_sql', signal, onUpdate });
  if (reply.stopReason !== 'end_turn') throw Error('The ACP job finished before returning an SQL proposal.');
  const text = reply.output.trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  let answer;
  try { answer = JSON.parse(fenced?.[1] ?? text); }
  catch { throw Error('The ACP peer did not return one structured SQL plan.'); }
  const result = compileGroundedQuery(intent.scope, answer);
  return { ...result, denied: reply.denied, stopReason: reply.stopReason };
}

function prepareDatabaseTasks({ catalog, choices, agents, tasks }) {
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 3) throw Error('Prepare two or three reviewed ACP database tasks.');
  const scope = projectGrounding(catalog, choices);
  const jobs = tasks.map(({ profile, input }) => {
    const agent = agents.find(item => item.label === profile);
    if (!agent) throw Error('Select a configured database ACP profile for each task.');
    const { preview, instructions, schema } = prepareGroundedIntent(scope, input);
    const text = `${instructions}\nWrite the explanation in one sentence under 140 characters. ` +
      'Always include the five keys columns, measures, sort, limit, explanation. Use [] for an empty array. ' +
      'A measure has column and function keys. A sort entry has key and direction keys, and key must exactly equal a selected column or measure expression. ' +
      'Use the exact requested aggregate function. Read the request after the available columns.\n' + JSON.stringify(preview);
    return { agent, intent: { scope, text, schema }, request: preview.request };
  });
  const keys = jobs.map(job => JSON.stringify([job.agent.label, job.request]));
  if (new Set(keys).size !== jobs.length) throw Error('Each ACP agent and request combination must be distinct.');
  return { scope, jobs, choices: structuredClone(choices), preview: { context: scope.shared, tasks: jobs.map(job => ({
    agent: job.agent.label, executable: job.agent.executable, args: job.agent.args, sha256: job.agent.sha256,
    ...(job.agent.localModel && { model: job.agent.localModel.model, endpoint: job.agent.localModel.endpoint }), text: job.intent.text
  })) } };
}

function createDatabaseTaskReview(batch, { execute = executeDatabaseAgent, onChange = () => {} } = {}) {
  const id = randomUUID();
  const jobs = batch.jobs.map((task, index) => ({ ...task, id: randomUUID(), slot: index + 1, status: 'pending' }));
  let invalidated = false, started = false;

  function snapshot() {
    return structuredClone({ id, invalidated, dialect: batch.scope.shared.dialect, schema: batch.scope.shared.schema, tables: batch.scope.names,
      model: 'Database ACP', endpoint: 'local stdio', jobs: jobs.map(job => ({ id: job.id, slot: job.slot, status: job.status,
        agent: job.agent.label, request: invalidated ? undefined : job.request, result: job.result, failure: job.failure })) });
  }

  function find(jobId, statuses, fingerprint) {
    const job = !invalidated && jobs.find(item => item.id === jobId);
    if (!job || !statuses.includes(job.status) || fingerprint !== undefined && job.result?.fingerprint !== fingerprint) {
      throw Error('That database task or exact reviewed SQL is no longer available.');
    }
    return job;
  }

  function stop(job, status) {
    job.status = status;
    job.controller?.abort();
    job.result = job.plan = job.failure = undefined;
  }

  function exact(jobId, statuses, fingerprint) {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error('Review the exact SQL fingerprint first.');
    return find(jobId, statuses, fingerprint);
  }

  async function run(job) {
    const intent = job.intent;
    job.intent = undefined;
    job.controller = new AbortController();
    job.status = 'running';
    onChange(snapshot());
    try {
      const answer = await execute(job.agent, intent, { signal: job.controller.signal });
      if (job.status !== 'running') return;
      const verified = compileGroundedQuery(batch.scope, answer.plan);
      job.plan = verified.plan;
      job.result = { sql: verified.sql, tables: verified.tables, explanation: verified.plan.explanation,
        fingerprint: createHash('sha256').update(verified.sql).digest('hex'), denied: answer.denied, stopReason: answer.stopReason };
      job.status = 'ready';
    } catch (error) {
      if (job.status !== 'running') return;
      job.status = 'failed';
      job.failure = error.message;
    } finally { job.controller = undefined; onChange(snapshot()); }
  }

  return { snapshot,
    async start() {
      if (started || invalidated) throw Error('This database task review has already started or closed.');
      started = true;
      await Promise.all(jobs.map(run));
      return snapshot();
    },
    cancel(jobId) { stop(find(jobId, ['running']), 'cancelled'); onChange(snapshot()); },
    reject(jobId, fingerprint) { stop(exact(jobId, ['ready', 'reviewed'], fingerprint), 'rejected'); onChange(snapshot()); },
    accept(jobId, fingerprint) {
      const job = exact(jobId, ['ready'], fingerprint);
      job.status = 'reviewed';
      onChange(snapshot());
    },
    result(jobId, fingerprint, reviewed = false) {
      const job = exact(jobId, reviewed ? ['reviewed'] : ['ready', 'reviewed'], fingerprint);
      return structuredClone({ ...job.result, plan: job.plan });
    },
    invalidate() {
      invalidated = true;
      for (const job of jobs) { stop(job, 'stale'); job.request = job.intent = undefined; }
      onChange(snapshot());
    }
  };
}

module.exports = { prepareDatabaseAgents, prepareDatabaseTasks, createDatabaseTaskReview, executeDatabaseAgent };
