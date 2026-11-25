'use strict';

const path=require('node:path');
const {editorAnchor,selectedExtraction}=require('./extraction-actions');
const {protocolRange}=require('./format-edits');
const {UNDEFINED_TYPE,typeImportCandidates,typeImportSelection,confirmUnresolvedType,typeImportDraft,verifyTypeImport}=require('./type-import');

const COMMAND='rocketbrain.java.addTypeImport';
const TITLE='Add Java Type Import';
const normalize=text=>text.replace(/\r\n/g,'\n');

function createTypeImport(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  const records=new WeakMap(),kind=vscode.CodeActionKind.QuickFix;
  let disposed=false;
  const allowed=document=>document?.languageId==='java'&&!document.isDirty&&!document.isClosed&&document.uri?.scheme==='file'&&
    vscode.workspace.getWorkspaceFolder(document.uri);
  const undefinedType=diagnostic=>diagnostic.source==='Java'&&diagnostic.severity===vscode.DiagnosticSeverity.Error&&
    String(diagnostic.code?.value??diagnostic.code)===UNDEFINED_TYPE;

  async function inspect({document,range,cancellation}={}) {
    assertReady(cancellation);
    if(!allowed(document)||!range)throw Error('Save the Java source and select an unresolved type.');
    const version=document.version,text=document.getText(),selected=document.validateRange(range);
    const selection=typeImportSelection(text,document.offsetAt(selected.start),document.offsetAt(selected.end));
    const diagnostic=vscode.languages.getDiagnostics(document.uri).find(item=>undefinedType(item)&&
      document.offsetAt(item.range.start)===selection.start&&document.offsetAt(item.range.end)===selection.end);
    if(!diagnostic)throw Error('Wait for Java to report the unresolved type at the selected source range.');
    const current=await snapshot(document.uri,cancellation);
    if(normalize(current.text)!==normalize(text))throw Error('Open the exact saved Java source before reviewing imports.');
    const state=await projects(cancellation),project=findProject(state.projects,document.uri);
    function checkAnchor(token) {
      assertReady(token);
      const active=java.getState();
      if(!allowed(document)||document.version!==version||document.getText()!==text||
          active.state!=='running'||active.runtimeIdentity!==state.runtimeIdentity) {
        throw Error('The Java source or runtime changed. Review imports again.');
      }
    }
    checkAnchor(cancellation);
    const diagnosticRange=protocolRange(diagnostic.range);
    const raw=await java.typeImportActions({uri:current.uri},diagnosticRange,{
      range:diagnosticRange,severity:1,code:UNDEFINED_TYPE,source:'Java',message:diagnostic.message
    },cancellation);
    checkAnchor(cancellation);
    const candidates=typeImportCandidates(raw,selection.name);
    if(!candidates.length)throw Error('The Java engine did not find an import for the selected type.');
    const report=Object.freeze({name:selection.name,candidates:Object.freeze(candidates)});
    records.set(report,{document,version,text,current,state,project,selection,checkAnchor});
    return report;
  }

  async function prepare(report,{fqn,cancellation}={}) {
    assertReady(cancellation);
    const record=records.get(report);
    if(!record||!report.candidates.includes(fqn))throw Error('Select a known Java import candidate.');
    const {document,version,text,current,state,project,selection,checkAnchor}=record;
    checkAnchor(cancellation);
    const sources=await classSources(project,cancellation);
    const observed=sources.find(file=>file.sha===current.sha&&!path.relative(vscode.Uri.parse(file.uri).fsPath,document.uri.fsPath));
    if(!observed)throw Error('Choose an imported Java production source.');
    const originals=new Map(sources.map(file=>[file.uri,file.sha]));
    const analyze=(source,span,options)=>compile(state,project,sources.map(file=>file===observed?{...file,text:source}:file),
      {kind:'typeImport',uri:observed.uri,start:span.start,end:span.end,fqn},cancellation,options);
    const baseline=await analyze(text,selection,{allowTypeImportErrors:true});
    const unresolved=confirmUnresolvedType(text,selection,observed.uri,baseline.errors);
    const draft=typeImportDraft(text,selection,fqn,unresolved);
    checkAnchor(cancellation);
    const verified=await analyze(draft.text,draft.selection,{errorTitle:'The selected Java import does not compile: '});
    if(verified.classpathFingerprint!==baseline.classpathFingerprint)throw Error('The Java classpath changed during import review.');
    verifyTypeImport(verified.typeImport,fqn,draft);
    checkAnchor(cancellation);
    const plan=await java.refactoring.previewWorkspaceEdit({documentChanges:[{
      textDocument:{uri:observed.uri,version},edits:[draft.edit]
    }]},{title:TITLE+' · '+fqn,kind:'quickfix.import',anchorDocument:document,cancellation,
      validate:async token=>{
        checkAnchor(token);
        const live=await classSources(project,token),entries=await classpaths(project,token);
        if(live.length!==originals.size||live.some(file=>file.sha!==originals.get(file.uri))||
            entries.length!==verified.classpathEntries.length||entries.some((entry,index)=>entry!==verified.classpathEntries[index])) {
          throw Error('Java source or classpath changed after import review.');
        }
        verified.validateClasspath();
      },
      preApply:token=>{checkAnchor(token);assertUnchangedSourceSnapshots(sources);verified.validateClasspath();}
    });
    return {...plan,import:{type:fqn,occurrences:unresolved.length,candidates:report.candidates.length}};
  }

  const subscriptions=[
    vscode.commands.registerCommand(COMMAND,async anchor=>{
      try {
        const selection=await selectedExtraction(vscode,anchor);
        const report=await operation('Find Java Type Imports',cancellation=>inspect({...selection,cancellation}));
        const choice=report.candidates.length===1?report.candidates[0]:
          await vscode.window.showQuickPick(report.candidates,{title:'Import '+report.name,placeHolder:'Select its fully qualified type'});
        if(!choice)return;
        const plan=await operation('Verify Java Type Import',cancellation=>prepare(report,{fqn:choice,cancellation}));
        return java.refactoring.review(plan);
      }catch(error){if(!disposed)void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);return null;}
    }),
    vscode.languages.registerCodeActionsProvider({scheme:'file',language:'java'},{
      provideCodeActions(document,range,context,token) {
        if(disposed||!vscode.workspace.isTrusted||!allowed(document)||token.isCancellationRequested||context.only&&!context.only.contains(kind))return [];
        const diagnostics=context.diagnostics.filter(item=>undefinedType(item)&&item.range.intersection(range));
        if(diagnostics.length!==1)return [];
        const action=new vscode.CodeAction(TITLE+'…',kind);
        action.diagnostics=diagnostics;
        action.command={command:COMMAND,title:TITLE,arguments:[editorAnchor(document,diagnostics[0].range)]};
        return [action];
      }
    },{providedCodeActionKinds:[kind]})
  ];
  return {inspect,prepare,dispose(){disposed=true;for(const subscription of subscriptions)subscription.dispose();}};
}

module.exports={createTypeImport};
