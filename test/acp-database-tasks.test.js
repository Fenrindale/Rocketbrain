'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { relationshipOptions } = require('../src/db/local-sql-grounding');
const { prepareDatabaseAgents, prepareDatabaseTasks, createDatabaseTaskReview } = require('../src/db/acp-database-tasks');

const column = (name, type = 'int') => ({ name, type });
const catalog = { database: 'owned', dialect: 'mysql', serverVersion: '8.4.13', sqlMode: [], semanticContextObserved: true,
  coverage: { tables: 'loaded', columns: 'loaded', foreignKeys: 'loaded' }, tables: [
    { name: 'tickets', kind: 'table', engine: 'InnoDB', columns: [column('team_id'), column('id'), column('private_fixture')],
      foreignKeys: [{ name: 'ticket_team', referencedSchema: 'owned', referencedTable: 'teams',
        columns: [{ name: 'team_id', referencedColumn: 'id', ordinal: 1 }] }] },
    { name: 'teams', kind: 'table', engine: 'InnoDB', columns: [column('id'), column('name', 'varchar(40)')], foreignKeys: [] }
  ] };
const choices = { root: 'tickets', edgeIds: relationshipOptions(catalog).map(edge => edge.id),
  selections: [{ table: 'tickets', columns: ['id'] }, { table: 'teams', columns: ['name'] }] };

test('an independent ACP process cannot use editor APIs and a cancelled peer does not interrupt the other task', async () => {
  const unique = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-standalone-acp-test-'));
  const marker = path.join(unique, 'started');
  const previous = process.env.ROCKETBRAIN_PRIVATE_ACP_TEST;
  process.env.ROCKETBRAIN_PRIVATE_ACP_TEST = 'fixture-process-parent-only';
  try {
    const peer = path.join(__dirname, 'fixtures', 'acp-db-peer.cjs');
    const agents = await prepareDatabaseAgents([{
      label: 'Fast peer', executable: process.execPath, args: [peer, 'fast', marker]
    }, { label: 'Slow peer', executable: process.execPath, args: [peer, 'slow', marker] }]);
    const tasks = [{ profile: 'Fast peer', input: 'Count the tickets by team' }, { profile: 'Slow peer', input: 'List the teams' }];
    const prepared = prepareDatabaseTasks({ catalog, choices, agents, tasks });
    assert.equal(prepared.preview.tasks.length, 2);
    assert.ok(!JSON.stringify(prepared.preview).includes('private_fixture'));
    const review = createDatabaseTaskReview(prepared);
    const result = review.start();
    const until = Date.now() + 10000;
    while (Date.now() < until && !await fs.stat(marker).catch(() => null)) await pause(20);
    assert.equal(await fs.readFile(marker, 'utf8'), 'started');
    review.cancel(review.snapshot().jobs[1].id);
    const { jobs } = await result;
    assert.deepEqual(jobs.map(job => job.status), ['ready', 'cancelled']);
    assert.equal(await fs.readFile(marker, 'utf8'), 'started cancelled');
    assert.equal(jobs[0].result.denied, 1);
    assert.equal(jobs[0].result.explanation, 'Isolated environment and denied tool requests.');
    assert.match(jobs[0].result.sql, /INNER JOIN `owned`\.`teams`/);
    assert.throws(() => review.accept(jobs[0].id), /exact SQL fingerprint/);
    assert.throws(() => review.accept(jobs[0].id, 'a'.repeat(64)), /no longer available/);
    review.accept(jobs[0].id, jobs[0].result.fingerprint);
    assert.equal(review.result(jobs[0].id, jobs[0].result.fingerprint, true).plan.limit, 20);
    review.invalidate();
    assert.throws(() => review.result(jobs[0].id, jobs[0].result.fingerprint, true), /no longer available/);
  } finally {
    if (previous === undefined) delete process.env.ROCKETBRAIN_PRIVATE_ACP_TEST;
    else process.env.ROCKETBRAIN_PRIVATE_ACP_TEST = previous;
    await fs.rm(unique, { recursive: true, maxRetries: 5 });
  }
});

test('the reviewed peer executable is rehashed before spawn and OpenCode selection has no arbitrary argument channel', async () => {
  const unique = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-acp-authority-'));
  try {
    const executable = path.join(unique, 'opencode.exe');
    await fs.writeFile(executable, 'owned first executable fixture');
    const profile = { label: 'Reviewed test peer', executable, adapter: 'opencode-local' };
    const loopback = { endpoint: 'http://127.0.0.1:31089/v1/chat/completions', model: 'owned-fixture' };
    await assert.rejects(prepareDatabaseAgents([{ ...profile, args: ['--extra'] }], loopback), /without custom arguments/);
    await assert.rejects(prepareDatabaseAgents([profile], { ...loopback, endpoint: loopback.endpoint.replace('127.0.0.1','example.invalid') }), /loopback/);
    const agents = await prepareDatabaseAgents([profile], loopback);
    assert.deepEqual(agents[0].args, ['acp','--pure']);
    const jobs = prepareDatabaseTasks({ catalog, choices, agents, tasks: [
      { profile: profile.label, input: 'Count tickets' }, { profile: profile.label, input: 'List the teams' }
    ] });
    await fs.writeFile(executable, 'different fixture executable bytes');
    const state = await createDatabaseTaskReview(jobs).start();
    assert.deepEqual(state.jobs.map(job => job.status), ['failed', 'failed']);
    for (const job of state.jobs) assert.match(job.failure, /reviewed ACP executable changed/);
  } finally { await fs.rm(unique, { recursive: true, maxRetries: 5 }); }
});
