'use strict';

const {PARAMETER_MODES,filterInlayHints,semanticTokenAt}=require('./code-hints');
const {protocolRange}=require('./format-edits');

const COMMANDS={configure:'rocketbrain.editor.configureCodeHints',inspect:'rocketbrain.editor.inspectSemanticToken'};
const LABELS={none:'Hide parameter names',literals:'Literal arguments',all:'All available parameter names'};

function registerCodeHints(vscode,{readJava,readKotlin,output}) {
  const changes=new vscode.EventEmitter(),subscriptions=[changes];
  let disposed=false;
  const available=document=>!disposed&&vscode.workspace.isTrusted&&document&&!document.isClosed&&
    ['java','kotlin'].includes(document.languageId)&&document.uri?.scheme==='file'&&
    !document.uri.authority&&!document.uri.query&&!document.uri.fragment&&vscode.workspace.getWorkspaceFolder(document.uri);
  const config=document=>vscode.workspace.getConfiguration('rocketbrain.editor',document.uri);
  function preferences(document) {
    const configured=config(document).get(document.languageId+'Hints',{});
    return {parameters:PARAMETER_MODES.has(configured?.parameters)?configured.parameters:'literals',types:configured?.types!==false};
  }

  async function provide(document,range,token) {
    if(!available(document)||token.isCancellationRequested)return [];
    const initial=preferences(document);
    if(initial.parameters==='none'&&!initial.types)return [];
    const version=document.version,text=document.getText();
    if(Buffer.byteLength(text)>2*1024*1024)return [];
    try{
      const reader=document.languageId==='java'?readJava:readKotlin,bounds=protocolRange(range);
      const raw=await reader(document,bounds,token);
      if(!available(document)||token.isCancellationRequested||document.version!==version)return [];
      return filterInlayHints(raw,{text,range:bounds,language:document.languageId,...preferences(document)}).map(item=>{
        const hint=new vscode.InlayHint(new vscode.Position(item.position.line,item.position.character),item.label,
          item.kind===1?vscode.InlayHintKind.Type:vscode.InlayHintKind.Parameter);
        hint.paddingLeft=item.paddingLeft;hint.paddingRight=item.paddingRight;
        return hint;
      });
    }catch(error){
      if(!disposed&&!token.isCancellationRequested)output.appendLine('Code hints: '+error.message);
      return [];
    }
  }

  async function inspect({document,position}={}) {
    if(!available(document)||!position)throw Error('Place the cursor in a trusted Java or Kotlin workspace source.');
    const {version}=document,text=document.getText();
    if(Buffer.byteLength(text)>2*1024*1024)throw Error('Inspect a source file of at most 2 MiB.');
    const [legend,tokens]=await Promise.all([
      vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend',document.uri),
      vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',document.uri)
    ]);
    if(!available(document)||document.version!==version)throw Error('The source changed. Inspect the token again.');
    const found=semanticTokenAt(text,position,legend,tokens?.data);
    return found?{language:document.languageId,...found}:null;
  }

  async function configure(document) {
    if(!available(document))throw Error('Open a Java or Kotlin workspace source before configuring code hints.');
    const current=preferences(document),lang=document.languageId==='java'?'Java':'Kotlin';
    const selected=await vscode.window.showQuickPick(Object.entries(LABELS).map(([mode,label])=>({mode,label,
      description:mode===current.parameters?'Current setting':undefined})),{title:lang+' Parameter Hints'});
    if(!selected)return;
    const inferred=await vscode.window.showQuickPick([true,false].map(value=>({value,label:value?'Show inferred types':'Hide type hints',
      description:value===current.types?'Current setting':undefined})),{title:lang+' Type Hints'});
    if(!inferred)return;
    if(!available(document))throw Error('The workspace changed. Configure code hints again.');
    const settings=config(document),key=document.languageId+'Hints',target=vscode.workspace.workspaceFolders?.length>1?
      vscode.ConfigurationTarget.WorkspaceFolder:vscode.ConfigurationTarget.Workspace;
    await settings.update(key,{parameters:selected.mode,types:inferred.value},target);
    return preferences(document);
  }

  function command(id,action) {
    return vscode.commands.registerCommand(id,async ()=>{
      try{return await action(vscode.window.activeTextEditor);}
      catch(error){if(!disposed)void vscode.window.showInformationMessage('Rocketbrain: '+error.message);return null;}
    });
  }

  subscriptions.push(vscode.languages.registerInlayHintsProvider(['java','kotlin'].map(language=>({scheme:'file',language})),{
    provideInlayHints:provide,onDidChangeInlayHints:changes.event
  }),vscode.workspace.onDidChangeConfiguration(event=>{
    if(event.affectsConfiguration('rocketbrain.editor'))changes.fire();
  }),command(COMMANDS.configure,editor=>configure(editor?.document)),command(COMMANDS.inspect,async editor=>{
    const at=editor?.selection.active;
    const info=await inspect({document:editor?.document,position:at});
    if(vscode.window.activeTextEditor===editor&&at?.isEqual(editor.selection.active)) {
      void vscode.window.showInformationMessage(info?info.text+' · '+[info.type,...info.modifiers].join(' · '):
        'The language server supplied no semantic token at the cursor.');
    }
    return info;
  }));

  return {available,inspect,refresh(){if(!disposed)changes.fire();},
    dispose(){disposed=true;for(const subscription of subscriptions)subscription.dispose();}};
}

module.exports={registerCodeHints,COMMANDS};
