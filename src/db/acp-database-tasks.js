'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { agentProgram, runAgent } = require('../ai/acp-process');
const { normalizeLocalChatTarget } = require('../ai/local-chat');
const { projectGrounding, prepareGroundedIntent, compileGroundedQuery } = require('./local-sql-grounding');

async function executableDigest(executable) {
  if ((await fs.stat(executable)).size > 256 * 1024 * 1024) throw Error('Select a standalone ACP executable of at most 256 MiB.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  return hash.digest('hex');
}

async function prepareDatabaseAgents(profiles, localModel) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 3) throw Error('Select up to three database ACP profiles.');
  const agents = await Promise.all(profiles.map(async input => {
    const adapter = input?.adapter ?? 'stdio';
    if (!['stdio', 'opencode-local'].includes(adapter)) throw Error('Select a stable ACP v1 stdio agent adapter.');
    const profile = await agentProgram(input);
    if (adapter === 'opencode-local' && (!/^opencode(?:\.exe)?$/i.test(path.basename(profile.executable)) || profile.args.length)) {
      throw Error('Provide the OpenCode executable without custom arguments for the local OpenCode adapter.');
    }
    if (adapter === 'opencode-local') profile.args = ['acp', '--pure'];
    return { ...profile, adapter, sha256: await executableDigest(profile.executable),
      ...(adapter === 'opencode-local' && { localModel: normalizeLocalChatTarget(localModel?.endpoint, localModel?.model) }) };
  }));
  if (new Set(agents.map(agent => agent.label)).size !== agents.length) throw Error('Choose distinctly named ACP profiles.');
  return agents;
}

function isolatedEnvironment(folder) {
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(Path|SystemRoot|ComSpec|windir|PATHEXT|LANG|LC_ALL)$/i.test(key)));
  // A peer inherits bootstrap paths only, plus its own temporary profile directories.
  return { ...system, HOME: folder, USERPROFILE: folder, LOCALAPPDATA: folder, APPDATA: folder, TEMP: folder, TMP: folder,
    XDG_CONFIG_HOME: folder, XDG_STATE_HOME: folder, XDG_DATA_HOME: folder, XDG_CACHE_HOME: folder };
}

async function executeDatabaseAgent(agent, intent, { signal, onUpdate } = {}) {
  signal?.throwIfAborted();
  if (await executableDigest(agent.executable) !== agent.sha256) throw Error('The reviewed ACP executable changed. Review it again.');
  signal?.throwIfAborted();
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'rocketbrain-db-acp-'));
  try {
    const env = isolatedEnvironment(folder);
    if (agent.adapter === 'opencode-local') {
      const { endpoint, model } = agent.localModel;
      const config = { model: 'rocketbrain/' + model, enabled_providers: ['rocketbrain'], autoupdate: false, snapshot: false,
        default_agent: 'plan', agent: { plan: { temperature: 0, top_p: 1 } },
        permission: 'deny', provider: { rocketbrain: { name: 'Approved loopback model', npm: '@ai-sdk/openai-compatible',
          options: { baseURL: endpoint.replace('/chat/completions', ''), apiKey: 'local-loopback' },
          models: { [model]: { name: model, tool_call: false, limit: { context: 4096, output: 1024 } } } } } };
      const filename = path.join(folder, 'opencode.json');
      await fs.writeFile(filename, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      Object.assign(env, { OPENCODE_CONFIG: filename, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1' });
    }
    const reply = await runAgent(agent, { cwd: folder, env, text: intent.text, signal, onUpdate });
    if (reply.stopReason !== 'end_turn') throw Error('The ACP job finished before returning an SQL proposal.');
    const text = reply.output.trim();
    const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
    let answer;
    try { answer = JSON.parse(fenced?.[1] ?? text); }
    catch { throw Error('The ACP peer did not return one structured SQL plan.'); }
    const result = compileGroundedQuery(intent.scope, answer);
    return { ...result, denied: reply.denied, stopReason: reply.stopReason };
  } finally {
    const current = await fs.realpath(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (current && (current !== folder || path.dirname(current) !== parent || !path.basename(current).startsWith('rocketbrain-db-acp-'))) {
      throw Error('The isolated database ACP directory changed before cleanup.');
    }
    if (current) await fs.rm(current, { recursive: true, maxRetries: 6, retryDelay: 150 });
  }
}

function prepareDatabaseTasks({ catalog, choices, agents, tasks }) {
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 3) throw Error('Prepare two or three reviewed ACP database tasks.');
  const scope = projectGrounding(catalog, choices);
  const jobs = tasks.map(({ profile, input }) => {
    const agent = agents.find(item => item.label === profile);
    if (!agent) throw Error('Select a configured database ACP profile for each task.');
    const { preview, instructions } = prepareGroundedIntent(scope, input);
    const text = `${instructions}\nWrite the explanation in one sentence under 140 characters. ` +
      'Always include all five keys. Use [] for an empty list. Return only a JSON object with this shape. ' +
      '{"columns":["table.column"],"measures":[{"column":"table.column","function":"COUNT"}],' +
      '"sort":[{"key":"table.column","direction":"ASC"}],"limit":100,"explanation":"brief summary"}\n' + JSON.stringify(preview);
    return { agent, intent: { scope, text }, request: preview.request };
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
