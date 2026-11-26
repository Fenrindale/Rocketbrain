'use strict';

const { randomUUID } = require('node:crypto');
const { posix } = require('node:path');
const { digest } = require('./ssh-workspace');
const { maxBatchBytes, maxBatchFiles, text } = require('./ssh-batch');

const reviewLifetime = 10 * 60 * 1000;
const receiptLifetime = 30 * 60 * 1000;
const maximumStored = 8;
const statusLabel = {
  applied: 'All replacements confirmed',
  refused: 'No files were written',
  partial: 'Some replacements confirmed',
  unconfirmed: 'Replacement outcome unconfirmed',
  'not-written': 'No replacement attempted',
  confirmed: 'Written and verified',
  preimage: 'Reviewed original still present',
  'replacement-bytes': 'Reviewed replacement bytes present',
  different: 'Current file differs from the review',
  missing: 'File missing',
  unavailable: 'File unavailable'
};
const reasonLabel = {
  'preimage-changed': 'A remote preimage changed before its replacement.',
  'staging-failed': 'The remote server could not stage the complete batch.',
  'replace-interrupted': 'A remote rename did not confirm completion.',
  'readback-changed': 'A renamed file could not be verified.',
  'reply-unverified': 'The SSH server reply could not be verified.',
  'connection-interrupted': 'SSH stopped before returning a verified outcome.',
  'root-changed': 'The observed remote root changed.'
};

function registerSshBatch(vscode, { command, requireConnection, currentConnection, uriFor, localText, notify }) {
  const reviews = new Map(), receipts = new Map();
  const output = vscode.window.createOutputChannel('Rocketbrain SSH Replacements');
  let active = false;

  function remember(map, id, value, lifetime) {
    for (const [key, record] of map) if (record.expiresAt < Date.now()) map.delete(key);
    while (map.size >= maximumStored) map.delete(map.keys().next().value);
    map.set(id, { ...value, expiresAt: Date.now() + lifetime });
  }

  function saved(uri) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.toString() === uri.toString())) {
      throw Error('Save the local files before reviewing or applying SSH replacements.');
    }
  }

  async function localRows(pairs) {
    let total = 0;
    const result = [];
    for (const pair of pairs) {
      saved(pair.local);
      const data = text(await localText(pair.local));
      saved(pair.local);
      total += data.length;
      if (total > maxBatchBytes) throw Error('The total local SSH batch replacements exceed 2 MiB.');
      result.push({ data, after: digest(data) });
    }
    return result;
  }

  function authorize(pairs) {
    const client = requireConnection(pairs[0].remote);
    for (const item of pairs) if (requireConnection(item.remote) !== client) throw Error('Choose files from one current SSH workspace.');
    return client;
  }

  async function reviewBatch(requested) {
    if (!Array.isArray(requested) || requested.length < 2 || requested.length > maxBatchFiles ||
        requested.some(item => !item?.remote || item.local?.scheme !== 'file') ||
        new Set(requested.map(item => item.remote.path)).size !== requested.length) {
      throw Error('Map two to eight distinct remote SSH files to saved local copies.');
    }
    const pairs = requested.map(({ remote, local }) => ({ remote, local }));
    const client = authorize(pairs);
    const [review, locals] = await Promise.all([client.inspectBatch(pairs.map(item => item.remote.path)), localRows(pairs)]);
    if (authorize(pairs) !== client) throw Error('The reviewed SSH workspace changed.');
    const entries = pairs.map(({ remote, local }, index) => {
      const before = review.rows[index], after = locals[index].after;
      if (before.sha256 === after) throw Error('Remove files with identical replacement bytes from this SSH batch.');
      return { path: remote.path, local, remote, before, after };
    });
    const id = randomUUID();
    remember(reviews, id, { client, entries, rootKey: review.rootKey }, reviewLifetime);
    return { id, host: client.host, rows: entries.map(item => ({
      path: item.path, remote: item.remote, local: item.local, before: item.before.sha256, after: item.after
    })) };
  }

  async function applyBatch(id, { allowReplacement } = {}) {
    if (allowReplacement !== true) throw Error('Approve the reviewed SSH batch explicitly.');
    if (active) throw Error('Wait for the current SSH batch replacement to finish.');
    const review = reviews.get(id);
    reviews.delete(id);
    if (!review || review.expiresAt < Date.now() || authorize(review.entries) !== review.client) {
      throw Error('Review the current SSH batch again.');
    }
    active = true;
    try {
      const local = await localRows(review.entries);
      if (authorize(review.entries) !== review.client || local.some((entry, index) => entry.after !== review.entries[index].after)) {
        throw Error('The local batch files or SSH connection changed after review.');
      }
      const entries = review.entries.map(({ path, before, after }, index) => ({ path, before, after, data: local[index].data }));
      const result = await review.client.replaceBatch({ rootKey: review.rootKey, entries });
      const plan = { rootKey: review.rootKey, entries: entries.map(({ path, before, after }) => ({ path, before, after })) };
      remember(receipts, id, { binding: review.client.batchBinding, plan, state: result.state }, receiptLifetime);
      if (currentConnection() === review.client) {
        notify(result.rows.flatMap(({ state }, index) =>
          state === 'confirmed' ? [{ uri: review.entries[index].remote, type: 'changed' }] : []));
      }
      return { id, state: result.state, ...(result.reason && { reason: result.reason }),
        rows: result.rows.map((row, index) => ({ ...row, path: entries[index].path })) };
    } finally { active = false; }
  }

  async function readbackBatch(id) {
    const stored = receipts.get(id);
    const client = currentConnection();
    if (!stored || stored.expiresAt < Date.now() || !client || stored.binding !== client.batchBinding) {
      throw Error('Reconnect to the same pinned SSH workspace and choose a current batch receipt.');
    }
    const rows = await client.readbackBatch(stored.plan);
    if (currentConnection() !== client) throw Error('The SSH workspace changed during batch readback.');
    return { id, rows: rows.map((row, index) => ({ ...row, path: stored.plan.entries[index].path })) };
  }

  function show(result) {
    output.clear();
    if (result.state) output.appendLine(statusLabel[result.state]);
    if (result.reason) output.appendLine(reasonLabel[result.reason]);
    for (const row of result.rows) {
      output.appendLine(row.path + ' · ' + statusLabel[row.state] + (row.sha256 ? ' · SHA-256 ' + row.sha256 : ''));
    }
    output.show(true);
  }

  async function choosePairs(client) {
    const pairs = [];
    while (pairs.length < maxBatchFiles) {
      const file = await vscode.window.showInputBox({ title: 'Remote File for SSH Replacement',
        prompt: 'Enter a file path relative to the selected SSH workspace root, starting with /.', placeHolder: '/src/Example.java' });
      if (!file) return;
      const remote = uriFor(client.authority, file);
      requireConnection(remote);
      const [local] = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select Replacement for ' + posix.basename(file) }) || [];
      if (!local) return;
      pairs.push({ remote, local });
      if (pairs.length === maxBatchFiles) break;
      if (pairs.length >= 2) {
        const next = await vscode.window.showQuickPick(['Review File Pairs', 'Add Another File'], { title: 'SSH Batch Replacements' });
        if (!next) return;
        if (next === 'Review File Pairs') break;
      }
    }
    return pairs;
  }

  const launch = command('uploadBatch', async () => {
    const client = currentConnection();
    if (!client) throw Error('Open the SSH workspace before reviewing replacements.');
    const pairs = await choosePairs(client);
    if (!pairs) return;
    const review = await reviewBatch(pairs);
    try {
      output.clear();
      for (const row of review.rows) {
        output.appendLine(row.path + '\nOriginal SHA-256 ' + row.before + '\nReplacement SHA-256 ' + row.after);
      }
      for (const row of review.rows) {
        await vscode.commands.executeCommand('vscode.diff', row.remote, row.local, 'SSH replacement · ' + row.path);
        const seen = await vscode.window.showInformationMessage('Review ' + row.path + ' and its replacement.', 'Review Next');
        if (seen !== 'Review Next') return;
      }
      const approved = await vscode.window.showWarningMessage('Apply the reviewed SSH file replacements?', {
        modal: true,
        detail: review.host + '\n' + review.rows.map(row => row.path).join('\n') +
          '\nEach file is replaced separately. A failure or disconnect can leave a partially applied batch.'
      }, 'Apply Reviewed Replacements');
      if (approved !== 'Apply Reviewed Replacements') return;
      const result = await applyBatch(review.id, { allowReplacement: true });
      show(result);
      return result;
    } finally { reviews.delete(review.id); }
  });

  const readback = command('checkBatch', async () => {
    const client = currentConnection();
    if (!client) throw Error('Open the same pinned SSH workspace to check the batch.');
    const choices = [...receipts].filter(([, item]) => item.expiresAt >= Date.now() && item.binding === client.batchBinding)
      .reverse().map(([id, item]) => ({ id, label: item.plan.entries[0].path,
        description: item.plan.entries.length + ' files · ' + statusLabel[item.state] }));
    if (!choices.length) throw Error('There are no current batch receipts for this pinned SSH workspace.');
    const choice = await vscode.window.showQuickPick(choices, { title: 'Check Applied SSH Replacements' });
    if (!choice) return;
    const result = await readbackBatch(choice.id);
    show(result);
    return result;
  });

  return { reviewBatch, applyBatch, readbackBatch, retire() { reviews.clear(); },
    dispose() { launch.dispose(); readback.dispose(); output.dispose(); reviews.clear(); receipts.clear(); } };
}

module.exports = { registerSshBatch };
