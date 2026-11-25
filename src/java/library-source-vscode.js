'use strict';

const path=require('node:path');
const {libraryClass,archiveFile,inspectSourceArchive,attachment,contentMode,normalized,sameFile}=require('./library-source');

const COMMAND='rocketbrain.java.manageLibrarySources';

function registerLibrarySources(vscode,{java,readContent,output}) {
  const changed=new vscode.EventEmitter();
  const provider=vscode.workspace.registerTextDocumentContentProvider('jdt',{
    onDidChange:changed.event,
    provideTextDocumentContent:readContent
  });
  let pending=Promise.resolve();
  const serial=action=>{const task=pending.then(action,action);pending=task.catch(()=>{});return task;};
  const trusted=()=>{if(!vscode.workspace.isTrusted)throw Error('Trust the workspace before managing Java library sources.');};
  const resolve=async target=>attachment(await java.executeWorkspaceCommand('java.project.resolveSourceAttachment',{classFileUri:target.uri}));
  const unchanged=(record,current)=>sameFile(record.binary,current.binary)&&record.source===current.source&&record.encoding===current.encoding;
  const getContent=async target=>{
    const text=await readContent(vscode.Uri.parse(target.uri));
    if(typeof text!=='string'||!text.trim())throw Error('JDT could not open the selected library class.');
    return text;
  };
  async function inspect(uri) {
    trusted();
    const target=libraryClass(uri.toString());
    const [record,text]=await Promise.all([resolve(target),getContent(target)]);
    if(path.basename(record.binary)!==target.jar)throw Error('JDT returned a different binary than the selected class.');
    const binaryIdentity=(await archiveFile(record.binary)).identity;
    return {target,record,binaryIdentity,text,mode:contentMode(text)};
  }
  async function reviewSource(inspected,sourcePath) {
    trusted();
    if(sameFile(sourcePath,inspected.record.binary))throw Error('Choose the separate original source archive.');
    return inspectSourceArchive(sourcePath,inspected.target.entries);
  }
  async function setAttachment(inspected,reviewed) {
    return serial(async()=>{
      trusted();
      const target=libraryClass(inspected.target.uri),current=await resolve(target);
      if(!unchanged(inspected.record,current)) {
        throw Error('The Java library source attachment changed. Review the current class again.');
      }
      if(!reviewed&&!current.source)throw Error('This Java library has no explicit attachment to remove.');
      if(reviewed) {
        const latest=await reviewSource(inspected,reviewed.file);
        if(latest.identity!==reviewed.identity||latest.sha256!==reviewed.sha256)throw Error('The source archive changed. Review the selected file again.');
      }
      if((await archiveFile(current.binary)).identity!==inspected.binaryIdentity)throw Error('The Java library binary changed. Review the class again.');
      if(!unchanged(current,await resolve(target)))throw Error('The Java library source attachment changed. Review the current class again.');
      trusted();
      const updated=await java.executeWorkspaceCommand('java.project.updateSourceAttachment',{classFileUri:target.uri,
        attributes:{sourceAttachmentPath:reviewed?.file??null,sourceAttachmentEncoding:current.encoding}});
      if(updated?.errorMessage)throw Error(updated.errorMessage);
      for(const document of vscode.workspace.textDocuments) {
        const uri=document.uri;
        if(uri.scheme==='jdt'&&uri.authority==='contents'&&uri.path.split('/')[1]===target.jar)changed.fire(uri);
      }
      const observed=await inspect(vscode.Uri.parse(target.uri));
      if(reviewed&&(!observed.record.source||observed.mode!=='source'||normalized(observed.text)!==normalized(reviewed.text))) {
        throw Error('JDT did not open the reviewed archive entry. Check the current attachment before retrying.');
      }
      if(!reviewed&&observed.record.source)throw Error('This classpath provider kept the source attachment. Check the project library settings.');
      return {mode:observed.mode,attachment:observed.record.source,uri:target.uri};
    });
  }
  async function chooseTarget() {
    const editor=vscode.window.activeTextEditor;
    if(editor?.document.uri.scheme==='jdt')return editor.document.uri;
    if(!editor||editor.document.uri.scheme!=='file'||editor.document.languageId!=='java'||!vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
      throw Error('Open a Java library class or place the cursor on a reference in a workspace Java file.');
    }
    const original=editor.document.version,point=editor.selection.active;
    const found=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',editor.document.uri,point);
    if(editor.document.isClosed||editor.document.version!==original)throw Error('The Java source changed. Select the library reference again.');
    const choices=new Map();
    for(const location of found??[]) {
      const uri=location.targetUri??location.uri;
      if(uri?.scheme==='jdt')choices.set(uri.toString(),uri);
    }
    if(choices.size===1)return choices.values().next().value;
    if(!choices.size)throw Error('The definition provider did not resolve a Java library class here.');
    return (await vscode.window.showQuickPick([...choices.values()].map(uri=>({label:path.posix.basename(uri.path),description:uri.path,uri})),
      {title:'Select Java Library Class'}))?.uri;
  }
  async function manage() {
    trusted();
    const uri=await chooseTarget();
    if(!uri)return;
    const inspected=await inspect(uri);
    const actions=[{label:'Open Library Class',detail:inspected.mode==='decompiled'?'Decompiled Java':'Source text',kind:'open'},
      {label:inspected.record.source?'Replace Source Archive…':'Attach Source Archive…',kind:'attach'}];
    if(inspected.record.source)actions.push({label:'Detach Source Archive…',detail:inspected.record.source,kind:'detach'});
    const selected=await vscode.window.showQuickPick(actions,{title:'Java Library Source · '+inspected.target.jar,
      placeHolder:path.basename(uri.path)});
    if(!selected)return;
    if(selected.kind==='open')return vscode.window.showTextDocument(uri,{preview:false});
    let reviewed;
    if(selected.kind==='attach') {
      const picked=(await vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,canSelectMany:false,
        openLabel:'Review Source Archive',filters:{'Java source archives':['jar','zip']}}))?.[0];
      if(!picked)return;
      if(picked.scheme!=='file'||picked.authority)throw Error('Choose a local JAR or ZIP archive.');
      reviewed=await reviewSource(inspected,picked.fsPath);
    }
    const action=reviewed?'Attach Source Archive':'Detach Source Archive';
    const detail=reviewed?`${reviewed.file}\n${reviewed.entry}\n\nSelect an archive for the binary version shown above.`:inspected.record.source;
    const approved=await vscode.window.showWarningMessage(`${action} for ${inspected.record.binary}?`,{modal:true,detail},action);
    if(approved!==action)return;
    const result=await setAttachment(inspected,reviewed);
    await vscode.window.showTextDocument(uri,{preview:false});
    void vscode.window.showInformationMessage(result.mode==='source'?'Java library source is available.':'Java bytecode is shown as decompiled source.');
    return result;
  }
  const subscription=vscode.commands.registerCommand(COMMAND,()=>manage().catch(error=>{
    output.appendLine(`Java library source: ${error.message}`);
    void vscode.window.showErrorMessage(error.message);
  }));
  return {inspect,reviewSource,setAttachment,dispose(){subscription.dispose();provider.dispose();changed.dispose();}};
}

module.exports={registerLibrarySources};
