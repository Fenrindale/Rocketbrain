'use strict';

const { randomUUID } = require('node:crypto');
const { prepareIsolatedAgent, runSavedOpenCodeAgent } = require('./acp-isolated-peer');
const { createAcpCheckpointStore } = require('./acp-checkpoints');

const settingsSection = 'rocketbrain.acp';
const modelSection = 'rocketbrain.localCodeModel';
const transcriptScheme = 'rocketbrain-acp-session-history';

function boundedText(text, limit, description) {
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.includes('\0') || Buffer.byteLength(text) > limit) {
    throw Error(`Enter ${description} of at most ${limit} UTF-8 bytes.`);
  }
  return text.trim();
}

function registerAcpRecovery(context, vscode) {
  const offers = new Map(), transcripts = new Map(), running = new Set();
  let generation = 0, disposed = false;

  function binding() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the local workspace before recovering ACP sessions.');
    const storage = context.storageUri;
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (storage?.scheme !== 'file' || !roots.length || roots.some(folder => folder.uri.scheme !== 'file')) {
      throw Error('Open a local workspace with extension storage before saving an ACP session.');
    }
    const scope = JSON.stringify([storage.toString(), ...roots.map(folder => folder.uri.toString()).sort()]);
    return { generation, scope, store: createAcpCheckpointStore({ scope, location: storage.fsPath, secrets: context.secrets }) };
  }

  function unchanged(review) {
    const now = binding();
    if (review.generation !== now.generation || review.scope !== now.scope) throw Error('The workspace or local agent settings changed. Review the current session again.');
  }

  function invalidate() {
    generation++;
    offers.clear();
    transcripts.clear();
    for (const controller of running) controller.abort();
  }

  async function stage({ id, text, label } = {}) {
    const original = binding();
    const input = boundedText(text, 4096, 'a reviewed ACP prompt');
    const model = vscode.workspace.getConfiguration(modelSection);
    const executable = vscode.workspace.getConfiguration(settingsSection).get('workspaceEditOpenCodePath');
    const agent = await prepareIsolatedAgent({ label: 'Local OpenCode', executable, adapter: 'opencode-local' },
      { endpoint: model.get('endpoint'), model: model.get('model') });
    const prior = id && (await original.store.list()).find(item => item.id === id);
    if (id && !prior) throw Error('Choose one retained session from this workspace.');
    const name = prior?.label ?? boundedText(label, 80, 'a session label');
    if (/[\x00-\x1f\x7f]/.test(name)) throw Error('Use a single-line session label.');
    unchanged(original);
    while (offers.size >= 6) offers.delete(offers.keys().next().value);
    const offerId = randomUUID();
    offers.set(offerId, { ...original, agent, prior, input, label: name, expiresAt: Date.now() + 120000 });
    return { offerId, session: prior, input, label: name, executable: agent.executable, sha256: agent.sha256,
      model: agent.localModel.model, endpoint: agent.localModel.endpoint };
  }

  async function dispatch(id, { confirmed, signal } = {}) {
    if (confirmed !== true) throw Error('Approve the exact prompt, local agent, and retained workspace session.');
    const review = offers.get(id);
    offers.delete(id);
    if (!review || review.expiresAt <= Date.now()) throw Error('The one-time ACP session review expired.');
    unchanged(review);
    const controller = new AbortController();
    running.add(controller);
    try {
      const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const input = { agent: review.agent, input: review.input, signal: active };
      const result = review.prior ? await review.store.continue(review.prior.id, { ...input, expected: review.prior }, runSavedOpenCodeAgent) :
        await review.store.create({ ...input, label: review.label }, runSavedOpenCodeAgent);
      unchanged(review);
      const lines = result.replay.flatMap(item => [item.role === 'agent' ? 'Agent' : 'User', item.text, '']);
      lines.push('Current prompt', review.input, '', 'Current reply', result.output);
      while (transcripts.size >= 6) transcripts.delete(transcripts.keys().next().value);
      const transcriptId = randomUUID();
      transcripts.set(transcriptId, lines.join('\n'));
      const uri = vscode.Uri.from({ scheme: transcriptScheme, path: `/${transcriptId}/ACP-Session.txt` });
      return { ...result, uri };
    } finally { running.delete(controller); }
  }

  function list() { return binding().store.list(); }

  async function remove(id, { confirmed } = {}) {
    if (confirmed !== true) throw Error('Confirm removal of the selected saved ACP session.');
    const original = binding();
    await original.store.remove(id);
    unchanged(original);
    transcripts.clear();
    return { removed: true };
  }

  async function recover({ confirmed } = {}) {
    if (confirmed !== true) throw Error('Confirm checking the previous ACP storage owner before recovery.');
    return binding().store.recoverAbandonedLease();
  }

  async function chooseSession() {
    const entries = (await list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return entries.map(session => ({ label: session.label, description: `${session.turns} completed turns`, session }));
  }

  function command(id, action) {
    return vscode.commands.registerCommand('rocketbrain.acp.' + id, async () => {
      try { return await action(); }
      catch (error) { if (error.name !== 'AbortError' && error.code !== 'ACP_CANCELLED') void vscode.window.showErrorMessage(error.message); }
    });
  }

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(transcriptScheme, {
    provideTextDocumentContent(uri) { return vscode.workspace.isTrusted ? transcripts.get(uri.path.split('/')[1]) ?? '' : ''; }
  }), vscode.workspace.onDidChangeWorkspaceFolders(invalidate), vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(settingsSection) || event.affectsConfiguration(modelSection)) invalidate();
  }), command('savedSession', async () => {
    const choices = [{ label: 'Start a Saved Session' }, ...await chooseSession()];
    const choice = await vscode.window.showQuickPick(choices, { title: 'Choose a Saved ACP Workspace Session' });
    if (!choice) return;
    const session = choice.session;
    const label = session ? session.label : await vscode.window.showInputBox({ title: 'Name the Saved ACP Session' });
    if (!label?.trim()) return;
    const text = await vscode.window.showInputBox({ title: session ? 'Continue the Saved ACP Session' : 'Enter the First ACP Prompt' });
    if (!text?.trim()) return;
    const review = await stage({ id: session?.id, label, text });
    const verb = session ? 'Continue Session' : 'Start and Save Session';
    const approved = await vscode.window.showWarningMessage('Approve this retained local ACP session?', { modal: true,
      detail: [review.label, review.executable, 'SHA-256 ' + review.sha256, `${review.model} at ${review.endpoint}`,
        session ? 'The local peer will load the encrypted conversation and send its context to the same model.' :
          'The local peer will save this conversation encrypted in this workspace storage.', review.input].join('\n\n') }, verb);
    if (approved !== verb) return;
    const result = await vscode.window.withProgress({ title: 'Waiting for the Saved ACP Session', location: vscode.ProgressLocation.Notification,
      cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const registration = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await dispatch(review.offerId, { confirmed: true, signal: controller.signal }); }
      finally { registration.dispose(); }
    });
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(result.uri), { preview: false });
  }), command('removeSavedSession', async () => {
    const choice = await vscode.window.showQuickPick(await chooseSession(), { title: 'Choose the Saved ACP Session to Remove' });
    if (!choice) return;
    if (await vscode.window.showWarningMessage(`Remove ${choice.session.label} and its retained conversation?`, { modal: true }, 'Remove Session') === 'Remove Session') {
      return remove(choice.session.id, { confirmed: true });
    }
  }), command('recoverSavedSessions', async () => {
    if (await vscode.window.showWarningMessage('Check the previous ACP storage owner and retain the last authenticated checkpoint?',
      { modal: true, detail: 'Only an abandoned lease can be cleared. Unfinished peer files will be discarded.' }, 'Check and Recover') !== 'Check and Recover') return;
    const result = await recover({ confirmed: true });
    void vscode.window.showInformationMessage(result.recovered ? 'The abandoned ACP storage lease was cleared.' : 'There is no abandoned ACP storage lease.');
    return result;
  }), { dispose() { disposed = true; invalidate(); } });
  return { stage, dispatch, list, remove, recover };
}

module.exports = { registerAcpRecovery };
