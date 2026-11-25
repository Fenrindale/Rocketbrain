'use strict';

const path=require('node:path');
const {protocolAncestors,selectionLadder,kotlinSelectionAncestors,sqlSelectionAncestors}=require('./semantic-selection');

const COMMANDS={expand:'rocketbrain.editor.expandSelection',shrink:'rocketbrain.editor.shrinkSelection'};
const LANGUAGES=new Set(['java','kotlin','sql','rocketbrain-jdbc']);
const localSchemes=new Set(['file','untitled','rocketbrain-profile-sql']);

function registerSemanticSelection(vscode,{java,readJava}) {
  const state=new WeakMap(),busy=new WeakSet();
  let disposed=false;
  const available=editor=>!disposed&&vscode.workspace.isTrusted&&editor?.document&&!editor.document.isClosed&&
    LANGUAGES.has(editor.document.languageId)&&localSchemes.has(editor.document.uri.scheme)&&
    (editor.document.languageId!=='java'&&editor.document.languageId!=='kotlin'||
      editor.document.uri.scheme==='file'&&vscode.workspace.getWorkspaceFolder(editor.document.uri));

  function capture(editor) {
    const {document}=editor;
    return editor.selections.map(selection=>({anchor:document.offsetAt(selection.anchor),active:document.offsetAt(selection.active)}));
  }
  const identical=(first,second)=>first.length===second.length&&first.every((item,index)=>
    item.anchor===second[index].anchor&&item.active===second[index].active);
  const bounds=({anchor,active})=>({start:Math.min(anchor,active),end:Math.max(anchor,active)});

  async function request(document,points,text,token) {
    const protocol=point=>{const {line,character}=document.positionAt(point);return {line,character};};
    if (document.languageId==='java'||document.languageId==='kotlin') {
      const kotlin=document.languageId==='kotlin';
      const response=await (kotlin?java.kotlinEditor.selectionRanges(document,points.map(protocol),token):
        readJava(document,points.map(protocol),token));
      if (!Array.isArray(response)||response.length!==points.length) {
        if (!kotlin||response!==undefined) return points.map(()=>[]);
        const symbols=await java.kotlinEditor.documentSymbols(document,token);
        return kotlinSelectionAncestors(text,symbols,points,value=>{
          try {
            const uri=vscode.Uri.parse(value);
            return uri.scheme==='file'&&!uri.authority&&!uri.query&&!uri.fragment&&!path.relative(document.uri.fsPath,uri.fsPath);
          } catch {return false;}
        });
      }
      return points.map((point,index)=>protocolAncestors(text,response[index],point));
    }
    return points.map(point=>sqlSelectionAncestors(text,point));
  }

  async function build(editor,initial) {
    const {document}=editor,text=document.getText(),version=document.version;
    if (Buffer.byteLength(text)>2*1024*1024||!initial.length||initial.length>32) throw Error('Use up to 32 selections in a source file of 2 MiB or less.');
    const source=new vscode.CancellationTokenSource();
    let timer;
    try {
      const interrupted=new Promise((_,reject)=>{
        timer=setTimeout(()=>{source.cancel();reject(Error('The selection provider timed out. Try again after language import.'));},45000);
      });
      const points=initial.map(item=>{const span=bounds(item);return span.start+Math.floor((span.end-span.start)/2);});
      const result=await Promise.race([request(document,points,text,source.token),interrupted]);
      if (!available(editor)||vscode.window.activeTextEditor!==editor||document.version!==version||!identical(capture(editor),initial)) {
        throw Error('The editor selection changed. Start expansion from the current cursor.');
      }
      const ladders=result.map((parents,index)=>selectionLadder(text,bounds(initial[index]),parents,points[index]));
      const steps=[initial];
      for(let depth=1;depth<40&&ladders.some(ladder=>depth<ladder.length);depth++){
        const next=ladders.map((ladder,index)=>{
          const span=ladder[Math.min(depth,ladder.length-1)];
          return initial[index].anchor>initial[index].active?{anchor:span.end,active:span.start}:{anchor:span.start,active:span.end};
        });
        const ordered=next.map(bounds).sort((a,b)=>a.start-b.start||a.end-b.end);
        if(ordered.some((span,index)=>index&&ordered[index-1].end>span.start))break;
        if(!identical(next,steps.at(-1)))steps.push(next);
      }
      return {version,steps,index:0};
    } finally {clearTimeout(timer);source.dispose();}
  }

  async function move(direction) {
    const editor=vscode.window.activeTextEditor;
    if (!available(editor)||busy.has(editor)) return false;
    const current=capture(editor);
    let record=state.get(editor);
    if(record&&(record.version!==editor.document.version||!identical(current,record.steps[record.index]))) {
      state.delete(editor);record=undefined;
    }
    if(!record&&direction<0)return false;
    busy.add(editor);
    try {
      if(!record) {record=await build(editor,current);state.set(editor,record);}
      const next=record.index+direction;
      if(next<0||next>=record.steps.length)return false;
      record.index=next;
      editor.selections=record.steps[next].map(({anchor,active})=>
        new vscode.Selection(editor.document.positionAt(anchor),editor.document.positionAt(active)));
      return true;
    } finally {busy.delete(editor);}
  }

  const subscriptions=[
    ...Object.entries(COMMANDS).map(([mode,id])=>vscode.commands.registerCommand(id,async ()=>{
      try{return await move(mode==='expand'?1:-1);}
      catch(error){if(!disposed)void vscode.window.showInformationMessage('Rocketbrain: '+error.message);return false;}
    })),
    vscode.window.onDidChangeTextEditorSelection(({textEditor})=>{
      const record=state.get(textEditor);
      if(record&&!identical(capture(textEditor),record.steps[record.index]))state.delete(textEditor);
    })
  ];
  return {dispose(){disposed=true;for(const subscription of subscriptions)subscription.dispose();}};
}

module.exports={registerSemanticSelection,COMMANDS};
