'use strict';

const path = require('node:path');
const {GROUPS,normalizeStructure,filterStructure,currentSymbol} = require('./file-structure');

const COMMAND='rocketbrain.java.fileStructure';
const MAX_SOURCE_BYTES=2*1024*1024;
const KINDS=['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function',
  'Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','Enum member','Struct','Event','Operator','Type parameter'];

function registerFileStructure(vscode,{java,readJava,output}) {
  const reviews=new WeakMap();
  let disposed=false;

  function available(document) {
    const uri=document?.uri;
    return !disposed && vscode.workspace.isTrusted && ['java','kotlin'].includes(document?.languageId) && uri?.scheme==='file' &&
      !uri.authority && !uri.query && !uri.fragment && vscode.workspace.getWorkspaceFolder(uri);
  }

  function anchored(document,version,text) {
    if (!available(document) || document.isClosed || document.version!==version || document.getText()!==text) {
      throw Error('The source changed. Open the file structure again.');
    }
  }

  async function request(document,token) {
    const upstream=new vscode.CancellationTokenSource();
    let timer,subscription;
    try {
      const interrupt=new Promise((_,reject)=>{
        const fail=message=>{upstream.cancel();reject(Error(message));};
        timer=setTimeout(()=>fail('File structure timed out. Try after the project import completes.'),35000);
        subscription=token?.onCancellationRequested?.(()=>fail('File structure was cancelled.'));
        if (token?.isCancellationRequested) fail('File structure was cancelled.');
      });
      const lookup=document.languageId==='java'?readJava:java.kotlinEditor.documentSymbols;
      return await Promise.race([interrupt,Promise.resolve().then(()=>lookup(document,upstream.token))]);
    } finally {clearTimeout(timer);subscription?.dispose();upstream.dispose();}
  }

  async function read(document,token) {
    if (!available(document) || document.isClosed) throw Error('Open a trusted Java or Kotlin workspace source.');
    if (token?.isCancellationRequested) throw Error('File structure was cancelled.');
    const {version,languageId}=document,text=document.getText();
    if (Buffer.byteLength(text)>MAX_SOURCE_BYTES) throw Error('File structure supports source files up to 2 MiB.');
    const response=await request(document,token);
    anchored(document,version,text);
    const symbols=normalizeStructure(response,text,{language:languageId,sameFile:value=>{
      if (typeof value!=='string' || value.length>8192) return false;
      try {
        const uri=vscode.Uri.parse(value);
        return uri.scheme==='file' && !uri.authority && !uri.query && !uri.fragment && !path.relative(document.uri.fsPath,uri.fsPath);
      } catch {return false;}
    }});
    return {document,version,text,symbols};
  }

  function nativeRange({start,end}) {
    return new vscode.Range(start.line,start.character,end.line,end.character);
  }

  function toOutline(node) {
    const result=new vscode.DocumentSymbol(node.name,node.detail||node.signature,node.kind-1,
      nativeRange(node.range),nativeRange(node.selectionRange));
    if (node.deprecated) result.tags=[vscode.SymbolTag.Deprecated];
    result.children=node.children.map(toOutline);
    return result;
  }

  async function outline(document,token,next) {
    if (!available(document)) return next(document,token);
    try {return (await read(document,token)).symbols.roots.map(toOutline);}
    catch (error) {
      if (!token?.isCancellationRequested && !disposed) output.appendLine('File structure: '+error.message);
      return [];
    }
  }

  async function inspect({document,position,group='all',cancellation}={}) {
    if (!available(document)) throw Error('Open a trusted Java or Kotlin workspace source.');
    const started=await (document.languageId==='java'?java.start():java.kotlinEditor.start({document}));
    if (started.state!=='running') throw Error(started.message || 'Start the language server to inspect this file.');
    const record=await read(document,cancellation), {rows,stats,positionOffset}=record.symbols;
    const selected=filterStructure(rows,group), cursor=currentSymbol(selected,positionOffset(position));
    const result=Object.freeze({language:document.languageId,group,currentId:cursor?.id,
      stats:Object.freeze({...stats}),members:Object.freeze(selected.map(row=>Object.freeze({id:row.id,label:row.name,
        kind:KINDS[row.kind-1],signature:row.signature,detail:row.detail,path:row.path,depth:row.depth,repaired:row.repaired,
        range:Object.freeze(structuredClone(row.selectionRange))})))});
    reviews.set(result,record);
    return result;
  }

  async function reveal(result,id) {
    const record=reviews.get(result);
    if (!record || !Number.isSafeInteger(id) || !result.members.some(item=>item.id===id)) throw Error('Select a known file structure member.');
    const {document,version,text}=record;
    anchored(document,version,text);
    const row=record.symbols.rows[id];
    const editor=await vscode.window.showTextDocument(document,{selection:nativeRange(row.selectionRange),preview:true,preserveFocus:false});
    anchored(document,version,text);
    return editor;
  }

  const action=vscode.commands.registerCommand(COMMAND,async ()=>{
    try {
      const editor=vscode.window.activeTextEditor;
      if (!available(editor?.document)) throw Error('Open a trusted Java or Kotlin workspace source.');
      const {document}=editor, {active:position}=editor.selection, {version}=document,text=document.getText();
      const scope=await vscode.window.showQuickPick(Object.entries(GROUPS).map(([group,label])=>({group,label})),{title:'File Structure'});
      if (!scope) return;
      anchored(document,version,text);
      const report=await vscode.window.withProgress({title:'Read File Structure',location:vscode.ProgressLocation.Notification,cancellable:true},
        (_progress,cancellation)=>inspect({document,position,group:scope.group,cancellation}));
      if (!report.members.length) {
        void vscode.window.showInformationMessage('No verified source declarations were found for this filter.');
        return report;
      }
      const items=report.members.map(member=>({
        label:member.label+member.signature,description:member.kind+' · line '+(member.range.start.line+1),
        detail:[member.path,member.detail].filter(Boolean).join(' · '),member
      }));
      const current=items.find(item=>item.member.id===report.currentId);
      if (current) {items.splice(items.indexOf(current),1);items.unshift(current);}
      const limited=report.stats.limited?' · Result limit reached':'';
      const picked=await vscode.window.showQuickPick(items,{title:path.basename(document.uri.fsPath)+' · '+GROUPS[scope.group]+limited,
        matchOnDescription:true,matchOnDetail:true});
      if (picked) await reveal(report,picked.member.id);
      return report;
    } catch (error) { if (!disposed) void vscode.window.showErrorMessage('Rocketbrain: '+error.message); return null; }
  });

  return {outline,inspect,reveal,dispose(){disposed=true;action.dispose();}};
}

module.exports = {registerFileStructure};
