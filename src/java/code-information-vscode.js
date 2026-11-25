'use strict';

const {normalizeHover,normalizeSignatures,informationHtml}=require('./code-information');

const COMMANDS={documentation:'rocketbrain.editor.quickDocumentation',signatures:'rocketbrain.editor.callSignatures'};
const TITLES={documentation:'Quick Code Documentation',signatures:'Show Call Signatures'};
const PROTOCOL={documentation:{method:'textDocument/hover',capability:'hoverProvider'},
  signatures:{method:'textDocument/signatureHelp',capability:'signatureHelpProvider'}};
const freeze=value=>{
  for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);
  return Object.freeze(value);
};

function registerCodeInformation(vscode,{java,readJava}) {
  const receipts=new WeakMap();
  let panel,viewedDocument,closed=false;
  const available=document=>!closed&&vscode.workspace.isTrusted&&document&&!document.isClosed&&
    ['java','kotlin'].includes(document.languageId)&&document.uri?.scheme==='file'&&
    !document.uri.authority&&!document.uri.query&&!document.uri.fragment&&vscode.workspace.getWorkspaceFolder(document.uri);

  async function inspect({document,position,kind,cancellation}={}) {
    if(!available(document)||!position||!Object.hasOwn(PROTOCOL,kind))throw Error('Open a Java or Kotlin workspace source and place the cursor on the target.');
    if(cancellation?.isCancellationRequested)throw Error('Code information was cancelled.');
    const version=document.version,text=document.getText(),validated=document.validatePosition(position);
    if(Buffer.byteLength(text)>2*1024*1024||validated.line!==position.line||validated.character!==position.character)throw Error('Select a valid position in a source file of at most 2 MiB.');
    const source=new vscode.CancellationTokenSource();
    let timer,listener;
    function checkAnchor() {
      if(!available(document)||version!==document.version||text!==document.getText())throw Error('The source changed. Request code information again.');
    }
    try {
      const interrupted=new Promise((_,reject)=>{
        const cancel=message=>{source.cancel();reject(Error(message));};
        listener=cancellation?.onCancellationRequested?.(()=>cancel('Code information was cancelled.'));
        timer=setTimeout(()=>cancel('The language provider timed out. Try again after project import.'),45000);
        if(cancellation?.isCancellationRequested)cancel('Code information was cancelled.');
      });
      const params={line:validated.line,character:validated.character};
      const response=await Promise.race([interrupted,document.languageId==='java'?
        readJava(document,params,PROTOCOL[kind],source.token):
        java.kotlinEditor.codeInformation(document,params,PROTOCOL[kind],source.token)]);
      checkAnchor();
      const normalized=kind==='documentation'?normalizeHover(response,text,document.offsetAt(validated)):normalizeSignatures(response);
      if(!normalized)throw Error(kind==='documentation'?'No documentation was returned for this position.':'Place the cursor inside a call with available signatures.');
      const report=freeze({...normalized,language:document.languageId});
      receipts.set(report,{document,checkAnchor});
      return report;
    }finally{clearTimeout(timer);listener?.dispose();source.dispose();}
  }

  function show(report) {
    const receipt=receipts.get(report);
    if(!receipt)throw Error('Request code information before opening this view.');
    receipt.checkAnchor();
    const title=(report.language==='java'?'Java':'Kotlin')+(report.kind==='documentation'?' Documentation':' Call Signatures');
    if(!panel) {
      panel=vscode.window.createWebviewPanel('rocketbrainCodeInformation',title,{viewColumn:vscode.ViewColumn.Beside,preserveFocus:true},
        {enableScripts:false,enableCommandUris:false,localResourceRoots:[]});
      panel.onDidDispose(()=>{panel=undefined;viewedDocument=undefined;});
    }else{
      panel.title=title;
      panel.reveal(vscode.ViewColumn.Beside,true);
    }
    viewedDocument=receipt.document;
    panel.webview.html=informationHtml(report);
    return panel;
  }

  const commands=Object.entries(COMMANDS).map(([kind,id])=>vscode.commands.registerCommand(id,async ()=>{
    const editor=vscode.window.activeTextEditor;
    const position=editor?.selection.active;
    try {
      const report=await vscode.window.withProgress({title:TITLES[kind],location:vscode.ProgressLocation.Notification,cancellable:true},
        (_progress,cancellation)=>inspect({document:editor?.document,position,kind,cancellation}));
      if(vscode.window.activeTextEditor!==editor||!editor.selection.active.isEqual(position)) {
        return;
      }
      show(report);
      return report;
    }catch(error){if(!closed)void vscode.window.showInformationMessage('Rocketbrain: '+error.message);return null;}
  }));
  const changes=vscode.workspace.onDidChangeTextDocument(event=>{
    if(event.document===viewedDocument&&event.contentChanges.length)panel?.dispose();
  });
  return {inspect,show,dispose(){closed=true;changes.dispose();panel?.dispose();for(const command of commands)command.dispose();}};
}

module.exports={registerCodeInformation,COMMANDS,PROTOCOL};
