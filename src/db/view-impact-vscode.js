'use strict';

const { randomUUID } = require('node:crypto');
const { observeViewImpact } = require('./view-impact');

const scheme = 'rocketbrain-view-impact';
const unavailable = '{"status":"unavailable","message":"Inspect view impact again on the current database connection."}';
const maxDocuments = 8;

function registerViewImpact(vscode, { inspect, check, currentFrame }) {
  const changed = new vscode.EventEmitter(), documents = new Map();

  function forget(key) {
    const entry = documents.get(key);
    if (!entry) return;
    documents.delete(key);
    changed.fire(entry.uri);
  }

  const subscriptions = [changed,
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      onDidChange: changed.event,
      provideTextDocumentContent(uri) {
        return vscode.workspace.isTrusted ? documents.get(uri.toString())?.text || unavailable : unavailable;
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === scheme) documents.delete(document.uri.toString());
    })
  ];

  return {
    inspect(request, assertActive) {
      return inspect(query => observeViewImpact(query, request), currentFrame(), assertActive).then(({ value }) => value);
    },
    async open(request, frame = currentFrame()) {
      const { value, epoch } = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Inspecting database view impact', cancellable: true
      }, async (_progress, token) => {
        const assertActive = () => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
        return inspect(query => observeViewImpact(query, request), frame, assertActive);
      });
      check(frame);
      const uri = vscode.Uri.from({ scheme, path: '/' + randomUUID() + '/View Impact.json' });
      const key = uri.toString();
      while (documents.size >= maxDocuments) forget(documents.keys().next().value);
      documents.set(key, { uri, epoch, text: JSON.stringify(value, null, 2) + '\n' });
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        check(frame);
        const editor = await vscode.window.showTextDocument(document, { preview: true });
        check(frame);
        return { report: value, uri: editor.document.uri };
      } catch (error) {
        forget(key);
        throw error;
      }
    },
    invalidate(epoch, mysql) {
      for (const [key, entry] of documents) if (!mysql || entry.epoch !== epoch) forget(key);
    },
    dispose() {
      documents.clear();
      for (const subscription of subscriptions) subscription.dispose();
    }
  };
}

module.exports = { registerViewImpact };
