'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeLocalChatTarget } = require('./local-chat');
const { workspaceScope, readContext, conversationBody, conversationAnswer, digest } = require('./editor-conversation');

const scheme = 'rocketbrain-local-code-conversation';
const prefix = 'rocketbrain.localCodeModel.';
const lifetime = 15 * 60 * 1000;
const maxSessions = 4;
const idPattern = /^[0-9a-f-]{36}$/i;

function registerEditorConversation(vscode, { configuration }) {
  const sessions = new Map();
  const updates = new vscode.EventEmitter();
  let currentRequest;
  const previewUri = session => vscode.Uri.from({ scheme, path: `/${session.id}/review/${session.offer.id}.json` });
  const transcriptUri = session => vscode.Uri.from({ scheme, path: `/${session.id}/conversation.txt` });

  function clearOffer(session) {
    if (!session.offer) return;
    const uri = previewUri(session);
    delete session.offer;
    updates.fire(uri);
  }

  function close(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    clearTimeout(session.timeout);
    if (currentRequest?.session === session) currentRequest.stop.abort();
    clearOffer(session);
    updates.fire(transcriptUri(session));
  }

  function clearSessions() {
    for (const sessionId of sessions.keys()) close(sessionId);
  }

  function activeSession() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== scheme) return undefined;
    const [, id] = uri.path.split('/');
    return idPattern.test(id) ? sessions.get(id) : undefined;
  }

  function getSession(id) {
    const session = sessions.get(id);
    if (!session || Date.now() >= session.expires) {
      close(id);
      throw Error('Start or open a current local workspace conversation.');
    }
    return session;
  }

  function targetFor(anchor) {
    const settings = configuration(anchor);
    return normalizeLocalChatTarget(settings.endpoint, settings.model);
  }

  function assertTarget(session) {
    const target = targetFor(session.scope.anchor);
    if (target.endpoint !== session.target.endpoint || target.model !== session.target.model) {
      close(session.id);
      throw Error('The configured model changed. Start a new conversation.');
    }
  }

  const checkFiles = session => readContext(vscode, session.scope, session.files.map(file => file.uri), session.files);

  function stage(session, files, question) {
    if (currentRequest?.session === session) throw Error('Wait for or cancel the current local model request.');
    const body = conversationBody(files, session.turns, question, session.target.model);
    clearOffer(session);
    const id = randomUUID();
    const payloadSha256 = digest(JSON.stringify(body));
    const context = files.map(({ relative, sha256, bytes }) => ({ path: relative, sha256, bytes }));
    const reviewText = JSON.stringify({ endpoint: session.target.endpoint, payloadSha256, context, request: body }, null, 2);
    session.offer = { id, question, body, reviewText, payloadSha256 };
    return { sessionId: session.id, reviewId: id, uri: previewUri(session), payloadSha256, context };
  }

  function start(anchor, uris, question) {
    const scope = workspaceScope(vscode, anchor);
    if (sessions.size >= maxSessions) throw Error('Close one of the four open local conversations first.');
    const target = targetFor(anchor);
    const files = readContext(vscode, scope, uris);
    const session = { id: randomUUID(), scope, target, turns: [], files: files.map(({ text, ...pin }) => pin),
      expires: Date.now() + lifetime };
    const review = stage(session, files, question);
    session.timeout = setTimeout(() => close(session.id), lifetime);
    session.timeout.unref();
    sessions.set(session.id, session);
    return review;
  }

  function continueTurn(id, question) {
    const session = getSession(id);
    assertTarget(session);
    return stage(session, checkFiles(session), question);
  }

  async function send(id, reviewId, { confirmed, signal } = {}) {
    if (confirmed !== true) throw Error('Confirm a reviewed local request before sending.');
    if (signal?.aborted) throw Error('The local model request was cancelled.');
    if (currentRequest) throw Error('Wait for or cancel the current workspace conversation request.');
    const session = getSession(id);
    const offer = session.offer;
    if (offer?.id !== reviewId) throw Error('Open the current unsent request review.');
    clearOffer(session);
    assertTarget(session);
    checkFiles(session);
    const stop = new AbortController();
    const cancellation = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    currentRequest = { session, stop };
    try {
      const answer = await conversationAnswer(session.target, offer.body, cancellation);
      if (cancellation.aborted) throw Error('The local model request was cancelled.');
      getSession(id);
      assertTarget(session);
      checkFiles(session);
      const result = { question: offer.question, answer, payloadSha256: offer.payloadSha256 };
      session.turns.push(result);
      const uri = transcriptUri(session);
      updates.fire(uri);
      return { ...result, sessionId: id, turn: session.turns.length, uri };
    } finally { currentRequest = undefined; }
  }

  const open = async uri => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });

  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    onDidChange: updates.event,
    provideTextDocumentContent(uri) {
      if (!vscode.workspace.isTrusted) return '';
      const [, id] = uri.path.split('/');
      const session = sessions.get(id);
      if (!session) return 'This local conversation has closed.';
      if (session.offer && uri.path === previewUri(session).path) return session.offer.reviewText;
      if (uri.path !== transcriptUri(session).path) return 'This request review is no longer available.';
      const files = session.files.map(file => file.relative).join(', ');
      return [`Local model: ${session.target.model}`, `Pinned files: ${files}`, '',
        ...session.turns.flatMap((turn, index) => [
          `Turn ${index + 1}`, `You: ${turn.question}`, '', `Model: ${turn.answer}`, ''
        ])].join('\n');
    }
  });

  async function chooseSession(placeholder) {
    const session = activeSession();
    if (session) return session;
    if (!sessions.size) throw Error('Start a local workspace conversation first.');
    const chosen = await vscode.window.showQuickPick([...sessions.values()].map(entry => ({
      label: String(entry.turns[0]?.question ?? entry.offer?.question ?? 'Local workspace conversation').slice(0, 100),
      description: entry.files.map(file => file.relative).join(', '), id: entry.id
    })), { placeHolder: placeholder });
    return chosen && getSession(chosen.id);
  }

  async function ask(title) {
    return vscode.window.showInputBox({ title, prompt: 'Review the request before sending it to the local model' });
  }

  const commands = [
    ['startConversation', async () => {
      const anchor = vscode.window.activeTextEditor?.document.uri;
      const scope = workspaceScope(vscode, anchor);
      const uris = await vscode.window.showOpenDialog({ defaultUri: scope.folder, canSelectMany: true,
        canSelectFiles: true, canSelectFolders: false, openLabel: 'Select Context Files' });
      if (!uris?.length) return;
      const question = await ask('Start a Local Workspace Conversation');
      if (question === undefined) return;
      const review = start(anchor, uris, question);
      await open(review.uri);
      return review;
    }],
    ['continueConversation', async () => {
      const session = await chooseSession('Choose a local conversation to continue');
      if (!session) return;
      const question = await ask('Continue Local Workspace Conversation');
      if (question === undefined) return;
      const review = continueTurn(session.id, question);
      await open(review.uri);
      return review;
    }],
    ['sendConversation', async () => {
      const session = activeSession();
      const offer = session?.offer;
      if (!offer || vscode.window.activeTextEditor?.document.uri.path !== previewUri(session).path) {
        throw Error('Open the current unsent request review to send it.');
      }
      const action = 'Send Reviewed Request';
      const approved = await vscode.window.showWarningMessage('Send this reviewed request to the local model?',
        { modal: true, detail: `${session.target.model} at ${session.target.endpoint}\n${session.files.length} selected files and ${session.turns.length} prior turns` }, action);
      if (approved !== action) return;
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Waiting for Local Workspace Conversation', cancellable: true }, async (_, token) => {
        const stop = new AbortController();
        const subscription = token.onCancellationRequested(() => stop.abort());
        if (token.isCancellationRequested) stop.abort();
        try {
          const result = await send(session.id, offer.id, { confirmed: true, signal: stop.signal });
          await open(result.uri);
          return result;
        } finally { subscription.dispose(); }
      });
    }],
    ['closeConversation', async () => {
      const session = await chooseSession('Choose a local conversation to close');
      if (session) close(session.id);
    }]
  ].map(([name, run]) => vscode.commands.registerCommand(prefix + name, async () => {
    try { return await run(); }
    catch (error) { void vscode.window.showErrorMessage(error.message); }
  }));
  const listeners = [
    vscode.workspace.onDidChangeWorkspaceFolders(clearSessions),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('rocketbrain.localCodeModel')) clearSessions();
    })
  ];
  return {
    start, continueTurn, send, close,
    dispose() {
      clearSessions();
      updates.dispose();
      provider.dispose();
      [...commands, ...listeners].forEach(item => item.dispose());
    }
  };
}

module.exports = { registerEditorConversation };
