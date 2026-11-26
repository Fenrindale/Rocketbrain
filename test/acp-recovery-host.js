'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createAcpCheckpointStore } = require('../src/ai/acp-checkpoints');
const { prepareIsolatedAgent, runSavedOpenCodeAgent } = require('../src/ai/acp-isolated-peer');
const { observePeer } = require('./acp-database-host');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

const fixtureMarker = 'RB-OWNED-271';
const firstPrompt = `Remember this synthetic local fixture identifier: ${fixtureMarker}. Reply with exactly ${fixtureMarker}.`;
const followup = 'What was the synthetic fixture identifier in my preceding request? Reply with that exact identifier only.';

async function verifySavedSession(peer, model) {
  const parent = await fs.realpath(os.tmpdir()), location = await fs.mkdtemp(path.join(parent, 'rb-acp-recovery-test-'));
  const memory = new Map();
  const secrets = { get: async key => memory.get(key), store: async (key, value) => memory.set(key, value) };
  const scope = 'owned-spring-project-' + randomBytes(4).toString('hex');
  const agent = await prepareIsolatedAgent({ label: 'Local OpenCode', executable: peer.executable, adapter: 'opencode-local' }, model);
  const pids = [];
  const execute = (agent, options) => runSavedOpenCodeAgent(agent, { ...options, async onStarted(pid) {
    pids.push(pid);
    await options.onStarted(pid);
  } });
  try {
    const initial = createAcpCheckpointStore({ location, scope, secrets });
    assert.deepEqual(await initial.list(), []);
    const first = await initial.create({ agent, input: firstPrompt, label: 'Owned paired Spring ACP' }, execute);
    assert.equal(first.turns, 1);
    assert.equal(first.resumed, false);
    assert.match(first.output, new RegExp(fixtureMarker));
    assert.deepEqual(first.replay, []);
    assert.equal(memory.size, 1);
    const actual = path.join(location, 'acp-checkpoints-v1', first.id);
    const relative = 'session.v1.enc';
    const before = await fs.readFile(path.join(actual, relative));
    assert.deepEqual(await fs.readdir(actual), [relative]);
    assert.ok(!before.includes(fixtureMarker) && !before.includes(firstPrompt));
    const restarted = createAcpCheckpointStore({ location, scope, secrets });
    const [observed] = await restarted.list();
    assert.equal(observed.id, first.id);
    const mismatch = await prepareIsolatedAgent({ label: 'Local OpenCode', executable: peer.executable, adapter: 'opencode-local' },
      { ...model, model: model.model + '-changed' });
    await assert.rejects(restarted.continue(first.id, { agent: mismatch, input: followup }, execute), /loopback model changed/);
    await assert.rejects(restarted.continue(first.id, { agent, input: followup, expected: { ...observed, turns: 2 } }, execute), /changed after review/);
    assert.equal(pids.length, 1);
    const second = await restarted.continue(first.id, { agent, input: followup, expected: observed }, execute);
    assert.equal(second.turns, 2);
    assert.equal(second.resumed, true);
    assert.equal(new Set(pids).size, 2);
    assert.match(second.replay.find(item => item.role === 'user').text, new RegExp(fixtureMarker));
    assert.match(second.replay.find(item => item.role === 'agent').text, new RegExp(fixtureMarker));
    assert.match(second.output, new RegExp(fixtureMarker));
    const after = await fs.readFile(path.join(actual, relative));
    assert.notDeepEqual(after, before);
    assert.ok(!after.includes(fixtureMarker) && !after.includes(followup));
    assert.deepEqual(await fs.readdir(actual), [relative]);
    const other = createAcpCheckpointStore({ location, scope: scope + '-other', secrets });
    await assert.rejects(other.list(), /private key.*unavailable/);
    await restarted.remove(first.id);
    assert.deepEqual(await restarted.list(), []);
    return { encryptedCheckpoint: true, separateWorkspaceKey: true, agentProcessRestarted: true, priorHistoryReplayed: true,
      followupUsedPreviousPrompt: true, changedModelAndCheckpointRejected: true, removed: true, peerVersion: peer.version,
      jdbc: await jdbcReadback() };
  } finally {
    const safe = await fs.realpath(location);
    assert.equal(path.dirname(safe), parent);
    assert.match(path.basename(safe), /^rb-acp-recovery-test-/);
    await fs.rm(safe, { recursive: true, maxRetries: 6, retryDelay: 150 });
  }
}

async function runAcpRecoveryChecks(api, vscode, checks) {
  await fixtureConfig();
  const peer = await observePeer(), model = await startLocalModel();
  const acp = vscode.workspace.getConfiguration('rocketbrain.acp');
  const preferences = vscode.workspace.getConfiguration('rocketbrain.localCodeModel');
  const previous = Object.fromEntries(['endpoint','model'].map(name => [name, preferences.inspect(name)?.workspaceValue]));
  const executable = acp.inspect('workspaceEditOpenCodePath')?.workspaceValue;
  const adapter = api.acpReview.savedSessions;
  let id;
  try {
    await acp.update('workspaceEditOpenCodePath', peer.executable, vscode.ConfigurationTarget.Workspace);
    for (const name of ['model','endpoint']) await preferences.update(name, model[name], vscode.ConfigurationTarget.Workspace);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.acp.savedSession') && commands.includes('rocketbrain.acp.removeSavedSession'));
    const label = 'Owned Spring ACP ' + randomBytes(4).toString('hex');
    const preview = await adapter.stage({ text: firstPrompt, label });
    assert.equal(preview.endpoint, model.endpoint);
    await assert.rejects(adapter.dispatch(preview.offerId, { confirmed: false }), /Approve the exact prompt/);
    const first = await adapter.dispatch(preview.offerId, { confirmed: true });
    id = first.id;
    await assert.rejects(adapter.dispatch(preview.offerId, { confirmed: true }), /expired/);
    assert.equal((await adapter.list()).find(item => item.id === id).turns, 1);
    const next = await adapter.stage({ id, text: followup });
    const second = await adapter.dispatch(next.offerId, { confirmed: true });
    assert.equal(second.id, id);
    assert.equal(second.resumed, true);
    assert.match(second.output, new RegExp(fixtureMarker));
    const document = await vscode.workspace.openTextDocument(second.uri);
    assert.match(document.getText(), /User[\s\S]+RB-OWNED-271[\s\S]+Current reply[\s\S]+RB-OWNED-271/u);
    await assert.rejects(adapter.remove(id, { confirmed: false }), /Confirm removal/);
    await adapter.remove(id, { confirmed: true });
    id = undefined;
    checks.push('Local OpenCode reloaded encrypted workspace history in a separate process and answered from prior authorized context. VS Code presented the recovered transcript separately from the new reply and required explicit removal.');
    return { nativeTranscript: true, priorHistoryReplayed: true, followupUsedPreviousPrompt: true, removed: true,
      peerVersion: peer.version, jdbc: await jdbcReadback() };
  } finally {
    try {
      if (id) await adapter.remove(id, { confirmed: true });
      await acp.update('workspaceEditOpenCodePath', executable, vscode.ConfigurationTarget.Workspace);
      for (const name of ['model','endpoint']) await preferences.update(name, previous[name], vscode.ConfigurationTarget.Workspace);
    } finally { await model.close(); }
  }
}

if (require.main === module) fixtureConfig().then(async () => {
  const peer = await observePeer(), model = await startLocalModel();
  try { console.log(JSON.stringify(await verifySavedSession(peer, model))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runAcpRecoveryChecks, verifySavedSession };
