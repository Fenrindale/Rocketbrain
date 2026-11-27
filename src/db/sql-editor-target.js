'use strict';

function sqlEditorForAction(vscode, resource) {
  const editor = vscode.window.activeTextEditor;
  if (typeof resource?.scheme === 'string' && typeof resource.path === 'string' &&
      resource.toString() !== editor?.document.uri.toString()) {
    throw Error('Activate this SQL editor before using its toolbar or menu.');
  }
  return editor;
}

module.exports = { sqlEditorForAction };
