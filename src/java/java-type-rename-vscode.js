'use strict';

const { prepareJavaTypeRename } = require('./java-type-rename');
const { validIdentifier } = require('./file-templates');

const COMMAND = 'rocketbrain.java.reviewTypeRename';

function registerJavaTypeRename(vscode, { request, refactoring, runtime, synchronizeFiles }) {
  const operations = new Set();
  let closed = false;
  function trusted(token) {
    if (closed || !vscode.workspace.isTrusted) throw Error('Use a trusted workspace to review Java type names.');
    if (token?.isCancellationRequested) throw Error('Java type rename review was cancelled.');
  }
  async function send(method, params, token) {
    trusted(token);
    let timeout;
    try {
      const result = await Promise.race([
        request(method, params, token),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('The Java language server timed out. Wait for project import and retry.')), 30000);
        })
      ]);
      trusted(token);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
  function prepare(options) {
    const work = prepareJavaTypeRename({ vscode, request: send, refactoring, runtime, trusted, synchronizeFiles }, options);
    operations.add(work);
    void work.finally(() => operations.delete(work)).catch(() => {});
    return work;
  }
  const subscription = vscode.commands.registerCommand(COMMAND, async () => {
    try {
      trusted();
      const editor = vscode.window.activeTextEditor;
      if (!editor?.document || editor.document.languageId !== 'java' || editor.document.isDirty) {
        throw Error('Open and save the Java class and select its type name.');
      }
      const { document, selection } = editor;
      const version = document.version;
      const newName = await vscode.window.showInputBox({
        title: 'Rename a public Java class', prompt: 'Enter its new class name',
        validateInput: value => validIdentifier(value) ? undefined : 'Enter a valid Java class name.'
      });
      if (newName === undefined) return;
      if (document.isClosed || document.version !== version) throw Error('The Java source changed. Select the class name again.');
      const plan = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Reviewing Java type and Spring XML references', cancellable: true
      }, (_, cancellation) => prepare({ document, position: selection.active, newName, cancellation }));
      return await refactoring.review(plan);
    } catch (error) {
      if (!closed) void vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message);
    }
  });
  return {
    prepare,
    async dispose() {
      closed = true;
      subscription.dispose();
      await Promise.allSettled([...operations]);
    }
  };
}

module.exports = { registerJavaTypeRename };
