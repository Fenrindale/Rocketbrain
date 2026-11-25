'use strict';

const {editorConfig,styleOptions} = require('./editorconfig');
const {lineEnding,protocolRange,formatterOptions,buildFormatEdits} = require('./format-edits');

const MAX_SOURCE_BYTES = 1024*1024;

function registerJavaFormatting(vscode,{java,request,output}) {
  return registerSourceFormatting(vscode,{start:()=>java.start(),refactoring:java?.refactoring,request,output,
    name:'Java',language:'java',commandId:'rocketbrain.java.previewFormatting',buildEdits:buildFormatEdits,engineOptions:formatterOptions});
}

function registerSourceFormatting(vscode,{start,refactoring,request,output,name,language,commandId,buildEdits,engineOptions}) {
  let disposed = false;

  function check(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before formatting '+name+'.');
    if (cancellation?.isCancellationRequested) throw Error(name+' formatting was cancelled.');
  }

  function folderFor(document) {
    const uri = document?.uri;
    return uri?.scheme==='file' && !uri.authority && !uri.query && !uri.fragment && document.languageId===language &&
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
    if (document.isClosed) throw Error('Open a '+name+' source file before formatting.');
    const before = document.getText();
    if (Buffer.byteLength(before)>MAX_SOURCE_BYTES) throw Error(name+' formatting review is limited to a 1 MiB source.');
    return {before,version:document.version,eol:document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n',range:range?protocolRange(range):undefined};
  }

  function validateSource(document,original,cancellation) {
    check(cancellation);
    if (document.isClosed || document.version!==original.version || document.getText()!==original.before) {
      throw Error('The '+name+' source changed during formatting. Preview it again.');
    }
  }

  async function analyze({document,folder,original,config,options,cancellation}) {
    const style = styleOptions(config.settings,optionsFor(document,options));
    const {before,range,eol} = original;
    const result = await request(range?'textDocument/rangeFormatting':'textDocument/formatting',{
      textDocument:{uri:document.uri.toString()},options:engineOptions(style),...(range?{range}:{})
    },cancellation,document);
    validateSource(document,original,cancellation);
    if (configuration(document,folder).fingerprint!==config.fingerprint) throw Error('The .editorconfig files changed. Preview formatting again.');
    const edits = buildEdits(before,range,result ?? [],style,eol);
    const requestedEol = style.endOfLine==='crlf'?'\r\n':'\n';
    const endOfLine = !range && style.endOfLine && requestedEol!==eol ? style.endOfLine : undefined;
    return {style,edits,endOfLine};
  }

  function nativeEdits(edits,endOfLine) {
    const output = edits.map(({range:{start,end},newText})=>new vscode.TextEdit(new vscode.Range(start.line,start.character,end.line,end.character),newText));
    if (endOfLine) output.push(vscode.TextEdit.setEndOfLine(endOfLine==='crlf'?vscode.EndOfLine.CRLF:vscode.EndOfLine.LF));
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
      if (!cancellation?.isCancellationRequested) output.appendLine(name+' formatter: '+error.message);
      return [];
    }
  }

  async function prepare({document,range,options,cancellation} = {}) {
    check(cancellation);
    const folder = folderFor(document);
    if (!folder) throw Error('Open a local '+name+' workspace source to preview formatting.');
    if (range?.isEmpty) throw Error('Select a '+name+' range to format.');
    const original = snapshot(document,range,cancellation);
    const config = configuration(document,folder);
    const state = await start(document);
    if (state.state!=='running') throw Error(state.message || 'Start '+name+' support to format its source.');
    const {style,edits,endOfLine} = await analyze({document,folder,original,config,options,cancellation});
    const mode = range?'range':'document';
    const formatting = {mode,options:style,configurationSources:config.sources,textEdits:edits.length,endOfLine:endOfLine || null};
    if (!edits.length && !endOfLine) return {state:'unchanged',formatting};
    const warnings = [];
    if (endOfLine) warnings.push('Convert the '+name+' document line endings to '+endOfLine.toUpperCase()+'.');
    if (range && style.endOfLine && lineEnding(original.before,style.endOfLine==='crlf'?'\r\n':'\n')!==original.before) {
      warnings.push('Format the whole document to apply its configured line ending.');
    }
    function validate(token) {
      validateSource(document,original,token);
      if (configuration(document,folder).fingerprint!==config.fingerprint) throw Error('The .editorconfig files changed after review. Preview formatting again.');
    }
    const plan = await refactoring.previewWorkspaceEdit({documentChanges:[{
      textDocument:{uri:document.uri.toString(),version:original.version},edits
    }]},{title:'Format '+name+(range?' Selection':' Document'),kind:'source.format.'+language,anchorDocument:document,cancellation,
      warnings,formattingEndOfLine:endOfLine,validate,preApply:validate});
    return {...plan,formatting};
  }

  const command = vscode.commands.registerCommand(commandId,async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    try {
      const {document,selection} = editor;
      const range = selection.isEmpty?undefined:selection;
      const plan = await vscode.window.withProgress({title:'Preview '+name+' Formatting',cancellable:true,location:vscode.ProgressLocation.Notification},
        (_progress,cancellation)=>prepare({document,range,cancellation}));
      if (plan.state==='unchanged') { void vscode.window.showInformationMessage(name+' source already matches the formatter.'); return plan; }
      return refactoring.review(plan);
    } catch (error) { if (!disposed) void vscode.window.showErrorMessage('Rocketbrain '+name+': '+error.message); return null; }
  });

  return {native,prepare,dispose(){disposed=true;command.dispose();}};
}

module.exports = {registerJavaFormatting,registerSourceFormatting};
