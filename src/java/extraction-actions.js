'use strict';

const ACTIONS = Object.freeze({
  constant:{command:'rocketbrain.java.extractConstant',kind:'refactor.extract.constant',title:'Extract Java Constant'},
  local:{command:'rocketbrain.java.extractVariable',kind:'refactor.extract.variable',title:'Extract Java Local Variable',jdt:'extractVariable',defaultTitle:'Extract to local variable'},
  field:{command:'rocketbrain.java.extractField',kind:'refactor.extract.field',title:'Extract Java Field',jdt:'extractField',defaultTitle:'Extract to field'}
});

function namedAction(kind,title) {
  if (kind === ACTIONS.constant.kind) return ACTIONS.constant;
  if (kind === ACTIONS.local.kind && title === ACTIONS.local.defaultTitle) return ACTIONS.local;
  if (kind === ACTIONS.field.kind && title === ACTIONS.field.defaultTitle) return ACTIONS.field;
}

function editorAnchor(document,range) {
  const point = ({line,character}) => ({line,character});
  return {uri:document.uri.toString(),range:{start:point(range.start),end:point(range.end)},version:document.version};
}

async function selectedExtraction(vscode,anchor) {
  const editor = vscode.window.activeTextEditor;
  if (!anchor) return {document:editor?.document,range:editor?.selection};
  const uri = vscode.Uri.parse(anchor.uri);
  if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri)) {
    throw Error('Select an open local Java workspace source.');
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const {start,end} = anchor.range;
  const range = new vscode.Range(start.line,start.character,end.line,end.character);
  if (document.version !== anchor.version) throw Error('The source changed after listing Java code actions. Select the expression again.');
  return {document,range};
}

module.exports = { ACTIONS,namedAction,editorAnchor,selectedExtraction };
