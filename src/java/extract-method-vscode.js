'use strict';

const path=require('node:path');
const {editorAnchor,selectedExtraction}=require('./extraction-actions');
const {validateMethodName,buildMethodExtraction,verifyMethodExtraction}=require('./extract-method');

const COMMAND='rocketbrain.java.extractMethod';
const TITLE='Extract Java Method';
const normalize=text=>text.replace(/\r\n/g,'\n');

function createMethodExtraction(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  const kind=vscode.CodeActionKind.RefactorExtract.append('method');
  const saved=document=>document?.languageId==='java'&&!document.isClosed&&!document.isDirty&&document.uri?.scheme==='file'&&
    vscode.workspace.getWorkspaceFolder(document.uri);

  async function prepare({document,range,name,cancellation}={}) {
    assertReady(cancellation);
    if (!saved(document)||!range?.start||!range?.end) throw Error('Select complete statements in a saved Java workspace source.');
    const invalid=validateMethodName(name);
    if (invalid) throw Error(invalid);
    const version=document.version,text=document.getText(),current=await snapshot(document.uri,cancellation);
    if (normalize(current.text)!==normalize(text)) throw Error('Open the exact saved Java source before extraction.');
    const selected=document.validateRange(range),from=document.offsetAt(selected.start),to=document.offsetAt(selected.end);
    const raw=text.slice(from,to),trimmed=raw.trim(),start=from+raw.indexOf(trimmed),end=start+trimmed.length;
    if (!trimmed||trimmed.length>32768) throw Error('Select up to 32768 characters of complete Java statements.');
    const state=await projects(cancellation),project=findProject(state.projects,document.uri),sources=await classSources(project,cancellation);
    const observed=sources.find(file=>file.sha===current.sha&&!path.relative(vscode.Uri.parse(file.uri).fsPath,document.uri.fsPath));
    if (!observed) throw Error('Select statements in an imported Java production source.');
    const originals=new Map(sources.map(file=>[file.uri,file.sha]));

    function checkAnchor(token) {
      assertReady(token);
      const active=java.getState();
      if (!saved(document)||document.version!==version||document.getText()!==text||
          active.state!=='running'||active.runtimeIdentity!==state.runtimeIdentity) {
        throw Error('The Java source or runtime changed. Review the extraction again.');
      }
    }
    const inspect=(source,position,options)=>compile(state,project,sources.map(file=>file===observed?{...file,text:source}:file),
      {kind:'methodExtract',uri:observed.uri,name,...position},cancellation,options);
    checkAnchor(cancellation);
    const initial=await inspect(text,{start,end,callOffset:-1}),before=initial.methodExtract;
    const draft=buildMethodExtraction(text,before,name);
    checkAnchor(cancellation);
    const verified=await inspect(draft.text,{start:draft.start,end:draft.end,callOffset:draft.callOffset},
      {errorTitle:'The Java method extraction would fail compiler analysis: '});
    if (initial.classpathFingerprint!==verified.classpathFingerprint) throw Error('The classpath changed during Java extraction.');
    verifyMethodExtraction(before,verified.methodExtract);
    checkAnchor(cancellation);
    const reviewed=await java.refactoring.previewWorkspaceEdit({documentChanges:[{textDocument:{uri:observed.uri,version},edits:draft.edits}]},{
      title:TITLE+' · '+name,kind:kind.value,anchorDocument:document,cancellation,
      validate:async token=>{
        checkAnchor(token);
        const live=await classSources(project,token);
        if (live.length!==originals.size||live.some(file=>file.sha!==originals.get(file.uri))) throw Error('Java sources changed after extraction review.');
        const entries=await classpaths(project,token);
        if (entries.length!==verified.classpathEntries.length||entries.some((file,index)=>file!==verified.classpathEntries[index])) {
          throw Error('The Java classpath changed after extraction review.');
        }
        verified.validateClasspath();
      },
      preApply:token=>{checkAnchor(token);verified.validateClasspath();assertUnchangedSourceSnapshots(sources);}
    });
    return {...reviewed,extraction:{name,owner:before.owner,returnType:before.returnType,throwsTypes:before.throwsTypes,
      typeParameters:before.typeNames,captures:before.captures.map(({name,type})=>({name,type})),statements:before.statementCount,
      checkedBindings:before.bindings.length}};
  }

  let disposed=false;
  const subscriptions=[vscode.commands.registerCommand(COMMAND,async anchor=>{
    try {
      const {document,range}=await selectedExtraction(vscode,anchor);
      if (!saved(document)||!range||range.isEmpty) throw Error('Select complete statements in a saved Java workspace source.');
      const version=document.version;
      const name=await vscode.window.showInputBox({title:TITLE,prompt:'Name the new private method.',value:'extracted',validateInput:validateMethodName});
      if (name===undefined) return;
      if (version!==document.version) throw Error('The source changed while naming the helper.');
      const plan=await operation('Verify Java Method Extraction',cancellation=>prepare({document,range,name,cancellation}));
      return java.refactoring.review(plan);
    } catch(error) {if(!disposed)void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);return null;}
  }),vscode.languages.registerCodeActionsProvider({scheme:'file',language:'java'},{
    provideCodeActions(document,range,context,token) {
      if (disposed||!vscode.workspace.isTrusted||!saved(document)||token.isCancellationRequested||
          context.only&&!context.only.contains(kind)||range.isEmpty) return [];
      const selected=document.getText(range).trim();
      if (selected.length>32768||!/[;}]$/.test(selected)) return [];
      const action=new vscode.CodeAction(TITLE,kind);
      action.command={command:COMMAND,title:TITLE,arguments:[editorAnchor(document,range)]};
      return [action];
    }
  },{providedCodeActionKinds:[kind]})];
  return {prepare,dispose(){disposed=true;for(const subscription of subscriptions)subscription.dispose();}};
}

module.exports={createMethodExtraction};
