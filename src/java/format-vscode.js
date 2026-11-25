'use strict';

const {editorConfig,styleOptions} = require('./editorconfig');
const {lineEnding,protocolRange,formatterOptions,buildFormatEdits} = require('./format-edits');

const COMMAND = 'rocketbrain.java.previewFormatting';
const MAX_SOURCE_BYTES = 1024*1024;

function registerJavaFormatting(vscode,{java,request,output}) {
  let disposed = false;

  function check(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before formatting Java.');
    if (cancellation?.isCancellationRequested) throw Error('Java formatting was cancelled.');
  }

  function folderFor(document) {
    const uri = document?.uri;
    return uri?.scheme==='file' && !uri.authority && !uri.query && !uri.fragment && document.languageId==='java' &&
      vscode.workspace.getWorkspaceFolder(uri);
  }

  function configuration(document,folder) {
    return editorConfig(document.uri.fsPath,folder.uri.fsPath);
  }

  function optionsFor(document,options) {
    if (options) return options;
    const visible = vscode.window.visibleTextEditors.find(editor=>editor.document===document);
    const fallback = vscode.workspace.getConfiguration('editor',document.uri);
    return {tabSize:visible?.options.tabSize ?? fallback.get('tabSize',4),insertSpaces:visible?.options.insertSpaces ?? fallback.get('insertSpaces',true)};
  }

  function snapshot(document,range,cancellation) {
    check(cancellation);
    if (document.isClosed) throw Error('Open a Java source file before formatting.');
    const before = document.getText();
    if (Buffer.byteLength(before)>MAX_SOURCE_BYTES) throw Error('Java formatting review is limited to a 1 MiB source.');
    return {before,version:document.version,eol:document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n',range:range?protocolRange(range):undefined};
  }

  function validateSource(document,original,cancellation) {
    check(cancellation);
    if (document.isClosed || document.version!==original.version || document.getText()!==original.before) {
      throw Error('The Java source changed during formatting. Preview it again.');
    }
  }

  async function analyze({document,folder,original,config,options,cancellation}) {
    const style = styleOptions(config.settings,optionsFor(document,options));
    const {before,range,eol} = original;
    const result = await request(range?'textDocument/rangeFormatting':'textDocument/formatting',{
      textDocument:{uri:document.uri.toString()},options:formatterOptions(style),...(range?{range}:{})
    },cancellation);
    validateSource(document,original,cancellation);
    if (configuration(document,folder).fingerprint!==config.fingerprint) throw Error('The .editorconfig files changed. Preview formatting again.');
    const edits = buildFormatEdits(before,range,result ?? [],style,eol);
    const requestedEol = style.endOfLine==='crlf'?'\r\n':'\n';
    const endOfLine = !range && style.endOfLine && requestedEol!==eol ? style.endOfLine : undefined;
    return {style,edits,endOfLine};
  }

  function nativeEdits(edits,endOfLine) {
    const output = edits.map(({range:{start,end},newText})=>new vscode.TextEdit(new vscode.Range(start.line,start.character,end.line,end.character),newText));
    // VS Code Undo and Redo resolve text offsets against the current newline width.
    // Keep a line-ending change separate from text edits, including on native Format Document.
    if (endOfLine && !output.length) output.push(vscode.TextEdit.setEndOfLine(endOfLine==='crlf'?vscode.EndOfLine.CRLF:vscode.EndOfLine.LF));
    return output;
  }

  async function native(document,range,options,cancellation,next) {
    const folder = folderFor(document);
    if (!folder || !vscode.workspace.isTrusted) return next();
    try {
      const config = configuration(document,folder);
      if (!Object.keys(config.settings).length) return next();
      const original = snapshot(document,range,cancellation);
      const {edits,endOfLine} = await analyze({document,folder,original,config,options,cancellation});
      return nativeEdits(edits,endOfLine);
    } catch (error) {
      if (!cancellation?.isCancellationRequested) output.appendLine('Java formatter: '+error.message);
      return [];
    }
  }

  async function prepare({document,range,options,cancellation} = {}) {
    check(cancellation);
    const folder = folderFor(document);
    if (!folder) throw Error('Open a local Java workspace source to preview formatting.');
    if (range?.isEmpty) throw Error('Select a Java range to format.');
    const original = snapshot(document,range,cancellation);
    const config = configuration(document,folder);
    const state = await java.start();
    if (state.state!=='running') throw Error(state.message || 'Start Java support to format its source.');
    const {style,edits,endOfLine} = await analyze({document,folder,original,config,options,cancellation});
    const mode = range?'range':'document';
    const formatting = {mode,options:style,configurationSources:config.sources,textEdits:edits.length,endOfLine:endOfLine || null};
    if (!edits.length && !endOfLine) return {state:'unchanged',formatting};
    const warnings = [];
    if (endOfLine) warnings.push('Convert the Java document line endings to '+endOfLine.toUpperCase()+
      (edits.length?' in a separate Undo step from the text changes.':'.'));
    if (range && style.endOfLine && lineEnding(original.before,style.endOfLine==='crlf'?'\r\n':'\n')!==original.before) {
      warnings.push('Format the whole document to apply its configured line ending.');
    }
    function validate(token) {
      validateSource(document,original,token);
      if (configuration(document,folder).fingerprint!==config.fingerprint) throw Error('The .editorconfig files changed after review. Preview formatting again.');
    }
    const plan = await java.refactoring.previewWorkspaceEdit({documentChanges:[{
      textDocument:{uri:document.uri.toString(),version:original.version},edits
    }]},{title:range?'Format Java Selection':'Format Java Document',kind:'source.format.java',anchorDocument:document,cancellation,
      warnings,formattingEndOfLine:endOfLine,validate,preApply:validate});
    return {...plan,formatting};
  }

  const command = vscode.commands.registerCommand(COMMAND,async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    try {
      const {document,selection} = editor;
      const range = selection.isEmpty?undefined:selection;
      const plan = await vscode.window.withProgress({title:'Preview Java Formatting',cancellable:true,location:vscode.ProgressLocation.Notification},
        (_progress,cancellation)=>prepare({document,range,cancellation}));
      if (plan.state==='unchanged') { void vscode.window.showInformationMessage('Java source already matches the formatter.'); return plan; }
      return java.refactoring.review(plan);
    } catch (error) { if (!disposed) void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message); return null; }
  });

  return {native,prepare,dispose(){disposed=true;command.dispose();}};
}

module.exports = {registerJavaFormatting};
