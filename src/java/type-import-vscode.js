'use strict';

const path=require('node:path');
const {editorAnchor,selectedExtraction}=require('./extraction-actions');
const {protocolRange}=require('./format-edits');
const {UNDEFINED_TYPE,qualified,typeImportCandidates,typeImportSelection,confirmUnresolvedType,typeImportDraft,verifyTypeImport}=require('./type-import');
const {problems,staticImportSelection,staticImportCandidates,resolveStaticImportActions,confirmUnresolvedStaticMember,verifyStaticImport}=require('./static-import');
const normalize=text=>text.replace(/\r\n/g,'\n');

function createTypeImport(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation,staticMember=false
}) {
  const COMMAND=staticMember?'rocketbrain.java.addStaticMemberImport':'rocketbrain.java.addTypeImport';
  const TITLE=staticMember?'Add Java Static Member Import':'Add Java Type Import';
  const subject=staticMember?'static member':'type';
  const diagnosticCode=diagnostic=>String(diagnostic.code?.value??diagnostic.code);
  const records=new WeakMap(),kind=vscode.CodeActionKind.QuickFix;
  let disposed=false;
  const allowed=document=>document?.languageId==='java'&&!document.isDirty&&!document.isClosed&&document.uri?.scheme==='file'&&
    vscode.workspace.getWorkspaceFolder(document.uri);
  const unresolved=diagnostic=>diagnostic.source==='Java'&&diagnostic.severity===vscode.DiagnosticSeverity.Error&&
    (staticMember?problems.has(diagnosticCode(diagnostic)):diagnosticCode(diagnostic)===UNDEFINED_TYPE);

  async function inspect({document,range,cancellation}={}) {
    assertReady(cancellation);
    if(!allowed(document)||!range)throw Error('Save the Java source and select an unresolved '+subject+'.');
    const version=document.version,text=document.getText(),selected=document.validateRange(range);
    const select=staticMember?staticImportSelection:typeImportSelection;
    const selection=select(text,document.offsetAt(selected.start),document.offsetAt(selected.end));
    const diagnostic=vscode.languages.getDiagnostics(document.uri).find(item=>unresolved(item)&&
      document.offsetAt(item.range.start)===selection.start&&document.offsetAt(item.range.end)===selection.end);
    if(!diagnostic)throw Error('Wait for Java to report the unresolved '+subject+' at the selected source range.');
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
      range:diagnosticRange,severity:1,code:diagnosticCode(diagnostic),source:'Java',message:diagnostic.message
    },cancellation);
    checkAnchor(cancellation);
    const actions=staticMember?await resolveStaticImportActions(raw,selection.name,action=>java.resolveTypeImportAction(action,cancellation)):raw;
    checkAnchor(cancellation);
    const candidates=staticMember?staticImportCandidates(actions,text,current.uri,selection.name):typeImportCandidates(actions,selection.name);
    if(!staticMember&&!candidates.length)throw Error('The Java engine did not find an import for the selected type.');
    const report=Object.freeze({name:selection.name,candidates:Object.freeze(candidates)});
    records.set(report,{document,version,text,current,state,project,selection,checkAnchor});
    return report;
  }

  async function prepare(report,{fqn,owner,cancellation}={}) {
    assertReady(cancellation);
    const record=records.get(report);
    if(!record)throw Error('Select a known Java import candidate.');
    if(staticMember&&owner!==undefined){
      if(fqn!==undefined||!qualified(owner))throw Error('Choose one fully qualified declaring type for the static member.');
      fqn=owner+'.'+report.name;
    }else if(!report.candidates.includes(fqn))throw Error('Select a known Java import candidate.');
    const {document,version,text,current,state,project,selection,checkAnchor}=record;
    checkAnchor(cancellation);
    const sources=await classSources(project,cancellation);
    const observed=sources.find(file=>file.sha===current.sha&&!path.relative(vscode.Uri.parse(file.uri).fsPath,document.uri.fsPath));
    if(!observed)throw Error('Choose an imported Java production source.');
    const originals=new Map(sources.map(file=>[file.uri,file.sha]));
    const analyze=(source,span,options)=>compile(state,project,sources.map(file=>file===observed?{...file,text:source}:file),
      {kind:staticMember?'staticImport':'typeImport',uri:observed.uri,start:span.start,end:span.end,fqn},cancellation,options);
    const baseline=await analyze(text,selection,{allowTypeImportErrors:true});
    const confirm=staticMember?confirmUnresolvedStaticMember:confirmUnresolvedType;
    const uses=confirm(text,selection,observed.uri,baseline.errors);
    const draft=typeImportDraft(text,selection,fqn,uses,{staticMember});
    checkAnchor(cancellation);
    const verified=await analyze(draft.text,draft.selection,{errorTitle:'The selected Java import does not compile: '});
    if(verified.classpathFingerprint!==baseline.classpathFingerprint)throw Error('The Java classpath changed during import review.');
    const member=staticMember?verifyStaticImport(verified.staticImport,fqn,draft):null;
    if(!staticMember)verifyTypeImport(verified.typeImport,fqn,draft);
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
    return {...plan,import:{...(member?{member:fqn,...member}:{type:fqn}),occurrences:uses.length,candidates:report.candidates.length}};
  }

  async function choose(report) {
    if(!staticMember){
      const fqn=report.candidates.length===1?report.candidates[0]:await vscode.window.showQuickPick(report.candidates,
        {title:'Import '+report.name,placeHolder:'Select its fully qualified type'});
      return fqn?{fqn}:null;
    }
    if(report.candidates.length){
      const manual={label:'Enter a declaring type…'};
      const selection=await vscode.window.showQuickPick([...report.candidates.map(fqn=>({label:fqn,fqn})),manual],
        {title:'Static import for '+report.name,placeHolder:'Choose a declaring type'});
      if(!selection)return null;
      if(selection.fqn)return {fqn:selection.fqn};
    }
    const owner=await vscode.window.showInputBox({title:'Declaring type for '+report.name,prompt:'For example, java.lang.Math',
      validateInput:value=>qualified(value.trim())?undefined:'Enter a fully qualified Java type name.'});
    return owner?{owner:owner.trim()}:null;
  }

  const subscriptions=[
    vscode.commands.registerCommand(COMMAND,async anchor=>{
      try {
        const selection=await selectedExtraction(vscode,anchor);
        const report=await operation('Find Java Imports',cancellation=>inspect({...selection,cancellation}));
        const choice=await choose(report);
        if(!choice)return;
        const plan=await operation('Verify Java Import',cancellation=>prepare(report,{...choice,cancellation}));
        return java.refactoring.review(plan);
      }catch(error){if(!disposed)void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);return null;}
    }),
    vscode.languages.registerCodeActionsProvider({scheme:'file',language:'java'},{
      provideCodeActions(document,range,context,token) {
        if(disposed||!vscode.workspace.isTrusted||!allowed(document)||token.isCancellationRequested||context.only&&!context.only.contains(kind))return [];
        const diagnostics=context.diagnostics.filter(item=>unresolved(item)&&item.range.intersection(range));
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
