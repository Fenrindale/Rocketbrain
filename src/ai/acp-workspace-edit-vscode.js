'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { workspacePath, workspaceRoots } = require('../java/workbench-model');
const { prepareIsolatedAgent, runIsolatedAgent } = require('./acp-isolated-peer');
const { normalize, hash, prepareWorkspacePrompt, reviewWorkspaceEdit } = require('./acp-workspace-edit');

const scheme = 'rocketbrain-acp-workspace-edit';
const section = 'rocketbrain.acp';
const provider = 'rocketbrain.localCodeModel';

function registerWorkspaceAcpEdits(context, vscode) {
  const pending = new Map(), reviews = new Map(), running = new Set();
  let generation = 0, disposed = false, busy = false;

  function trusted(expected = generation) {
    if (disposed || !vscode.workspace.isTrusted || generation !== expected) throw Error('The workspace or agent settings changed. Start a new source edit review.');
  }

  function invalidate() {
    generation++;
    pending.clear();
    reviews.clear();
    for (const controller of running) controller.abort();
  }

  function choices() {
    const settings = vscode.workspace.getConfiguration(section);
    const openCode = settings.get('workspaceEditOpenCodePath');
    return [...(openCode ? [{ label: 'Local OpenCode', executable: openCode, adapter: 'opencode-local' }] : []),
      ...settings.get('agents', []).slice(0, 20).filter(item => typeof item?.label === 'string')];
  }

  async function capture(uri) {
    trusted();
    if (uri?.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.java') throw Error('Choose an existing local Java source file.');
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const [root] = folder?.uri.scheme === 'file' ? workspaceRoots([folder]) : [];
    if (!root) throw Error('Choose saved Java files inside the open project.');
    const file = workspacePath(uri.toString(), [root], { directory: false });
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty || document.isClosed) throw Error('Save or discard the current Java buffer change before reviewing an ACP edit.');
    const version = document.version;
    const handle = await fs.open(file, 'r');
    let bytes;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 3 * 1024) throw Error('Choose independent regular Java source files up to 3 KiB.');
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw Error('A Java source changed while reading it.');
    } finally { await handle.close(); }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    if (document.isDirty || document.isClosed || document.version !== version || normalize(text) !== normalize(document.getText()) ||
        workspacePath(uri.toString(), [root], { directory: false }) !== file) throw Error('The saved Java source differs from the current editor buffer.');
    return { uri, file, root, name: path.relative(root, file).split(path.sep).join('/'), version, document,
      diskHash: hash(bytes), editorHash: hash(document.getText()), text: normalize(text) };
  }

  function save(store, entry, ttl) {
    while (store.size >= 6) store.delete(store.keys().next().value);
    const id = randomUUID();
    store.set(id, { ...entry, expiresAt: Date.now() + ttl });
    return id;
  }

  function find(store, id) {
    const record = store.get(id);
    if (!record || record.expiresAt <= Date.now()) {
      store.delete(id);
      throw Error('This ACP edit request or review expired.');
    }
    trusted(record.generation);
    return record;
  }

  async function recheck(record) {
    trusted(record.generation);
    const current = await Promise.all(record.sources.map(source => capture(source.uri)));
    trusted(record.generation);
    if (current.some((source, index) => {
      const reviewed = record.sources[index];
      return source.file !== reviewed.file || source.diskHash !== reviewed.diskHash || source.editorHash !== reviewed.editorHash ||
        source.version !== reviewed.version || source.document !== reviewed.document || source.document.version !== source.version;
    })) throw Error('A reviewed source changed. Request a new multi-file edit.');
    return current;
  }

  async function stage({ uris, input, agentLabel } = {}) {
    trusted();
    const started = generation;
    if (!Array.isArray(uris) || uris.length < 2 || uris.length > 4) throw Error('Choose two to four saved Java source files.');
    const agents = choices().filter(agent => agent.label.trim() === agentLabel);
    if (agents.length !== 1) throw Error('Choose one uniquely configured local ACP agent.');
    const modelSettings = vscode.workspace.getConfiguration(provider);
    const [agent, sources] = await Promise.all([
      prepareIsolatedAgent(agents[0], { endpoint: modelSettings.get('endpoint'), model: modelSettings.get('model') }),
      Promise.all(uris.map(capture))
    ]);
    trusted(started);
    if (new Set(sources.map(item => process.platform === 'win32' ? item.file.toLowerCase() : item.file)).size !== sources.length ||
        sources.some(item => item.root !== sources[0].root)) throw Error('Choose distinct source files in one local workspace folder.');
    const request = prepareWorkspacePrompt(sources, input);
    const id = save(pending, { generation: started, request, sources, agent }, 120000);
    return { id, text: request.text, agent: { label: agent.label, executable: agent.executable, args: agent.args, sha256: agent.sha256,
      ...(agent.localModel && { endpoint: agent.localModel.endpoint, model: agent.localModel.model }) } };
  }

  async function generate(id, { confirmed, signal } = {}) {
    if (confirmed !== true) throw Error('Review the exact executable, local destination, and selected Java text before sending.');
    const origin = find(pending, id);
    pending.delete(id);
    await recheck(origin);
    const controller = new AbortController();
    running.add(controller);
    let result;
    try {
      const reply = await runIsolatedAgent(origin.agent, { text: origin.request.text, schema: origin.request.schema, schemaName: origin.request.schemaName,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      signal?.throwIfAborted();
      result = reviewWorkspaceEdit(origin.request, reply);
      await recheck(origin);
    } finally { running.delete(controller); }
    const reviewId = save(reviews, { generation: origin.generation, sources: origin.sources, ...result }, 10 * 60 * 1000);
    return { id: reviewId, summary: result.summary, fingerprint: result.fingerprint, files: result.edits.map(({ id, name }) => ({ id, name })) };
  }

  async function openDiff(id, sourceId) {
    const record = find(reviews, id);
    const edit = record.edits.find(item => item.id === sourceId);
    if (!edit) throw Error('Choose a source from the current multi-file review.');
    const uri = kind => vscode.Uri.from({ scheme, path: `/${id}/${kind}/${sourceId}/${path.basename(edit.name)}` });
    const before = uri('before'), after = uri('after');
    await vscode.commands.executeCommand('vscode.diff', before, after, `${edit.name} · Review ACP Edit`, { preview: false });
    return { before, after };
  }

  async function apply(id, { fingerprint, confirmed } = {}) {
    const record = find(reviews, id);
    if (confirmed !== true || fingerprint !== record.fingerprint) throw Error('Approve the exact set of source replacements before applying.');
    if (record.applying) throw Error('Wait for the current source edit operation.');
    record.applying = true;
    try {
      const current = await recheck(record);
      trusted(record.generation);
      if (current.some(source => source.document.isClosed || source.document.isDirty || source.document.version !== source.version)) {
        throw Error('A reviewed source changed before apply.');
      }
      const edit = new vscode.WorkspaceEdit();
      for (const [index, change] of record.edits.entries()) {
        const { document, uri } = current[index];
        const { start, end } = change.captured;
        const before = change.before.slice(0, start);
        const through = change.before.slice(0, end);
        const offset = value => document.eol === vscode.EndOfLine.CRLF ? value.replaceAll('\n', '\r\n').length : value.length;
        edit.replace(uri, new vscode.Range(document.positionAt(offset(before)), document.positionAt(offset(through))), change.replacement);
      }
      reviews.delete(id);
      if (!await vscode.workspace.applyEdit(edit)) throw Error('VS Code did not apply the reviewed text edits.');
      return { applied: true, files: record.edits.length, saved: false };
    } finally { record.applying = false; }
  }

  async function ask() {
    if (busy) return;
    busy = true;
    try {
      trusted();
      const configured = choices();
      if (!configured.length) throw Error('Configure a local ACP agent or the OpenCode executable before reviewing source changes.');
      const uris = await vscode.window.showOpenDialog({ title: 'Select Java Sources for an ACP Edit', canSelectMany: true,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, filters: { Java: ['java'] } });
      if (!uris?.length) return;
      const agentLabel = await vscode.window.showQuickPick(configured.map(agent => agent.label.trim()), { title: 'Choose the Local ACP Agent' });
      if (!agentLabel) return;
      const input = await vscode.window.showInputBox({ title: 'Request a Multi-File ACP Edit', prompt: 'Describe the coordinated Java change' });
      if (!input?.trim()) return;
      const request = await stage({ uris, input, agentLabel });
      const accepted = await vscode.window.showWarningMessage('Send these exact Java sources to the configured ACP program?', { modal: true,
        detail: [request.agent.executable, JSON.stringify(request.agent.args), 'SHA-256 ' + request.agent.sha256,
          request.agent.endpoint ? `${request.agent.model} at ${request.agent.endpoint}` : 'The chosen local program controls its backend.', request.text].join('\n\n') }, 'Send Source');
      if (accepted !== 'Send Source') return;
      const result = await vscode.window.withProgress({ title: 'Generating an ACP Multi-File Edit', location: vscode.ProgressLocation.Notification,
        cancellable: true }, async (_progress, token) => {
        const stop = new AbortController();
        const subscription = token.onCancellationRequested(() => stop.abort());
        if (token.isCancellationRequested) stop.abort();
        try { return await generate(request.id, { confirmed: true, signal: stop.signal }); }
        finally { subscription.dispose(); }
      });
      for (;;) {
        const selection = await vscode.window.showQuickPick([...result.files.map(file => ({ label: file.name, id: file.id })),
          { label: 'Apply Reviewed Workspace Edits' }], { title: result.summary, placeHolder: 'Open a file diff or apply the reviewed set' });
        if (!selection) return;
        if (selection.id) await openDiff(result.id, selection.id);
        else {
          const record = find(reviews, result.id);
          const detail = record.edits.map(edit => `${edit.name}\n${edit.captured.selection}\n→\n${edit.replacement}`).join('\n\n');
          if (await vscode.window.showInformationMessage('Apply these exact edits to the open Java buffers?', { modal: true, detail }, 'Apply Edits') === 'Apply Edits') {
            return apply(result.id, { fingerprint: result.fingerprint, confirmed: true });
          }
        }
      }
    } finally { busy = false; }
  }

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent(uri) {
    if (disposed || !vscode.workspace.isTrusted) return '';
    const [, id, side, source] = uri.path.split('/');
    try {
      const edit = find(reviews, id).edits.find(item => item.id === source);
      return (side === 'before' ? edit?.before : side === 'after' ? edit?.after : '') ?? '';
    } catch { return ''; }
  } }), vscode.workspace.onDidChangeWorkspaceFolders(invalidate), vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(section) || event.affectsConfiguration(provider)) invalidate();
  }), vscode.commands.registerCommand('rocketbrain.acp.reviewWorkspaceEdit', async () => {
    try { return await ask(); }
    catch (error) { if (error.code !== 'ACP_CANCELLED' && error.name !== 'AbortError') void vscode.window.showErrorMessage(error.message); }
  }), { dispose() { disposed = true; invalidate(); } });
  return { stage, generate, openDiff, apply };
}

module.exports = { registerWorkspaceAcpEdits };
