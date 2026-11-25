'use strict';

const {selectedExtraction,editorAnchor} = require('./extraction-actions');
const {buildInlineDraft,verifyInlineDraft} = require('./inline-method');

const COMMAND='rocketbrain.java.inlineMethod';
const TITLE='Inline Java Method Call';

function createMethodInline(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  const kind=vscode.CodeActionKind.RefactorInline.append('method');
  const normal=text=>text.replace(/\r\n/g,'\n');

  function localSaved(document) {
    const uri=document?.uri;
    return document?.languageId==='java'&&!document.isClosed&&!document.isDirty&&uri?.scheme==='file'&&
      !uri.authority&&!uri.query&&!uri.fragment&&vscode.workspace.getWorkspaceFolder(uri);
  }

  async function prepare({document,range,cancellation}={}) {
    assertReady(cancellation);
    if (!localSaved(document) || !range?.start || !range?.end) throw Error('Select a method call in a saved Java workspace source.');
    const {version}=document,text=document.getText(),current=await snapshot(document.uri,cancellation);
    if (normal(current.text)!==normal(text)) throw Error('Open the exact saved Java source before inlining.');
    const selected=document.validateRange(range),from=document.offsetAt(selected.start),to=document.offsetAt(selected.end);
    const raw=text.slice(from,to), trimmed=raw.trim(), start=trimmed?from+raw.indexOf(trimmed):from, end=start+trimmed.length;
    const state=await projects(cancellation),project=findProject(state.projects,document.uri),sources=await classSources(project,cancellation);
    if (!sources.some(file=>file.uri===current.uri&&file.sha===current.sha)) throw Error('Select a call in an imported Java production source root.');
    const hashes=new Map(sources.map(file=>[file.uri,file.sha]));
    function checkAnchor(token) {
      assertReady(token);
      const active=java.getState();
      if (!localSaved(document)||document.version!==version||document.getText()!==text||active.state!=='running'||active.runtimeIdentity!==state.runtimeIdentity) {
        throw Error('The Java source or its runtime changed. Review the method call again.');
      }
    }
    const analyze=(input,offsets,argumentCount,token,options)=>compile(state,project,
      sources.map(file=>file.uri===current.uri?{...file,text:input}:file),
      {kind:'methodInline',uri:current.uri,...offsets,argumentCount},token,options);
    checkAnchor(cancellation);
    const initial=await analyze(text,{start,end},-1,cancellation);
    const proof=initial.methodInline,draft=buildInlineDraft(text,proof);
    checkAnchor(cancellation);
    const compiled=await analyze(draft.after,{start:draft.start,end:draft.end},proof.arguments.length,cancellation,
      {errorTitle:'The Java inline edit would fail compiler analysis: '});
    if (compiled.classpathFingerprint!==initial.classpathFingerprint) throw Error('The Java classpath changed during inline analysis.');
    verifyInlineDraft(proof,draft,compiled.methodInline);
    checkAnchor(cancellation);
    const reviewed=await java.refactoring.previewWorkspaceEdit({documentChanges:[{
      textDocument:{uri:current.uri,version},edits:[draft.edit]
    }]},{title:TITLE+' · '+proof.method,kind:kind.value,anchorDocument:document,cancellation,
      warnings:[proof.arguments.length?'Each argument is evaluated once in its original order. The method declaration stays available.':
        'The method declaration stays available.'],
      validate:async token=>{
        checkAnchor(token);
        const live=await classSources(project,token);
        if (live.length!==hashes.size || live.some(file=>file.sha!==hashes.get(file.uri))) throw Error('Java source content or membership changed after inline review.');
        const entries=await classpaths(project,token);
        if (entries.length!==compiled.classpathEntries.length || entries.some((file,index)=>file!==compiled.classpathEntries[index])) {
          throw Error('The Java classpath changed after inline review.');
        }
        compiled.validateClasspath();
      },preApply:token=>{checkAnchor(token);compiled.validateClasspath();assertUnchangedSourceSnapshots(sources);}});
    return {...reviewed,inline:{method:proof.method,owner:proof.owner,returnType:proof.type,arguments:proof.arguments.length,
      parameterReferences:proof.references.length,selectedCalls:1}};
  }

  let disposed=false;
  const subscriptions=[vscode.commands.registerCommand(COMMAND,async anchor=>{
    try {
      const selected=await selectedExtraction(vscode,anchor);
      const plan=await operation('Inspect Java Method Call',cancellation=>prepare({...selected,cancellation}));
      return java.refactoring.review(plan);
    } catch (error) {if (!disposed) void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);return null;}
  }),vscode.languages.registerCodeActionsProvider({scheme:'file',language:'java'},{
    provideCodeActions(document,range,context,token) {
      if (disposed||!vscode.workspace.isTrusted||!localSaved(document)||token.isCancellationRequested||context.only&&!context.only.contains(kind)) return [];
      const anchor=range.isEmpty?document.getWordRangeAtPosition(range.start,/[$\p{ID_Start}][$\p{ID_Continue}]*/u):range;
      if (!anchor) return [];
      const selection=document.getText(anchor).trim();
      const start=document.offsetAt(anchor.start), previous=document.getText().slice(Math.max(0,start-320),start);
      if (!/(?:\breturn|=)\s*(?:\(\s*)*$/.test(previous)) return [];
      const simple=/^[$\p{ID_Start}][$\p{ID_Continue}]*$/u.test(selection);
      const follows=simple?document.lineAt(anchor.end.line).text.slice(anchor.end.character):'';
      if (!(simple&&/^\s*\(/.test(follows))&&!/^[$\p{ID_Start}][$\p{ID_Continue}]*\s*\([\s\S]*\)$/u.test(selection)) return [];
      const action=new vscode.CodeAction(TITLE,kind);
      action.command={command:COMMAND,title:TITLE,arguments:[editorAnchor(document,anchor)]};
      return [action];
    }
  },{providedCodeActionKinds:[kind]})];

  return {prepare,dispose(){disposed=true;for (const entry of subscriptions) entry.dispose();}};
}

module.exports={COMMAND,createMethodInline};
