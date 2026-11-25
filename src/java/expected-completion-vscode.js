'use strict';

const path = require('node:path');
const { completionHole,substitute,readCompletion,verifyCompletion } = require('./expected-completion');

const COMMAND = 'rocketbrain.java.completeExpectedValue';
const TITLE = 'Complete Java Value by Expected Type';

function createExpectedCompletion(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,assertUnchangedSourceSnapshots,operation
}) {
  const reports=new WeakMap();
  const valid=document=>document?.languageId==='java'&&!document.isClosed&&document.uri?.scheme==='file'&&
    !document.uri.authority&&!document.uri.query&&!document.uri.fragment&&vscode.workspace.getWorkspaceFolder(document.uri);

  async function inspect({document,position,cancellation}={}) {
    assertReady(cancellation);
    if (!valid(document)||!position) throw Error('Place the cursor inside a Java source file in this workspace.');
    const {version,uri}=document, text=document.getText();
    const hole=completionHole(text,document.offsetAt(document.validatePosition(position)));
    const state=await projects(cancellation),project=findProject(state.projects,uri);
    const sources=await classSources(project,cancellation,uri);
    const anchor=sources.find(file=>!path.relative(vscode.Uri.parse(file.uri).fsPath,uri.fsPath));
    if (!anchor) throw Error('Choose a Java file in an imported production source root.');
    const originals=new Map(sources.map(file=>[file.uri,file.sha]));
    function checkAnchor(token) {
      assertReady(token);
      const active=java.getState();
      if (!valid(document)||document.version!==version||document.getText()!==text||
          active.state!=='running'||active.runtimeIdentity!==state.runtimeIdentity) {
        throw Error('The Java source or runtime changed. Request completion again.');
      }
    }
    const analyze=(name,stage,token)=>compile(state,project,sources.map(file=>file===anchor?{...file,text:substitute(text,hole,name)}:file),
      {kind:'expectedCompletion',uri:anchor.uri,start:hole.start,end:hole.start+name.length,stage},token,
      {draftUri:uri,errorTitle:stage==='plan'?'Complete the surrounding Java syntax first. Javac: ':'The selected Java completion does not compile: '});
    checkAnchor(cancellation);
    const analyzed=await analyze('null','plan',cancellation);
    checkAnchor(cancellation);
    const data=readCompletion(analyzed.expectedCompletion,hole);
    const report=Object.freeze({...data,candidates:Object.freeze(data.candidates.map(candidate=>Object.freeze({...candidate})))});
    reports.set(report,{document,uri,text,hole,project,sources,originals,checkAnchor,analyze,analyzed});
    return report;
  }

  async function apply(report,name,{cancellation}={}) {
    assertReady(cancellation);
    const record=reports.get(report), choice=record&&report.candidates.find(item=>item.name===name);
    if (!choice) throw Error('Choose a type-compatible value from the current Java completion list.');
    const {document,uri,text,hole,project,sources,originals,checkAnchor,analyze,analyzed}=record;
    checkAnchor(cancellation);
    const proposed=await analyze(choice.name,'verify',cancellation);
    if (proposed.classpathFingerprint!==analyzed.classpathFingerprint) throw Error('The Java classpath changed during completion. Request it again.');
    verifyCompletion(report,choice,proposed.expectedCompletion);
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    const live=await classSources(project,cancellation,uri),entries=await classpaths(project,cancellation);
    if (live.length!==originals.size||live.some(item=>item.sha!==originals.get(item.uri))||
        entries.length!==proposed.classpathEntries.length||entries.some((item,index)=>item!==proposed.classpathEntries[index])) {
      throw Error('The Java project changed during completion. Request it again.');
    }
    checkAnchor(cancellation);
    assertUnchangedSourceSnapshots(sources,uri);
    proposed.validateClasspath();
    const desired=substitute(text,hole,choice.name);
    reports.delete(report);
    if (desired===text) return {state:'already-complete',choice,expectedType:report.expectedType};
    const range=new vscode.Range(document.positionAt(hole.start),document.positionAt(hole.end));
    if (!await editor.edit(edit=>edit.replace(range,choice.name),{undoStopBefore:true,undoStopAfter:true})) {
      throw Error('The Java buffer changed while inserting the completed value.');
    }
    if (document.getText()===desired) {
      const end=document.positionAt(hole.start+choice.name.length);
      editor.selection=new vscode.Selection(end,end);
    }
    return {state:'applied',choice,expectedType:report.expectedType};
  }

  async function run() {
    const editor=vscode.window.activeTextEditor;
    const report=await operation('Find Type-Compatible Java Values',cancellation=>inspect({
      document:editor?.document,position:editor?.selection.active,cancellation
    }));
    if (!report.candidates.length) {
      void vscode.window.showInformationMessage('No visible local values match '+report.expectedType+'.');
      return null;
    }
    const choice=await vscode.window.showQuickPick(report.candidates.map(item=>({label:item.name,description:item.type})),
      {title:'Complete '+report.expectedType,placeHolder:'Choose a parameter or initialized local value'});
    return choice&&operation('Verify Java Value Completion',cancellation=>apply(report,choice.label,{cancellation}));
  }

  return {inspect,apply,run};
}

module.exports={createExpectedCompletion,COMMAND,TITLE};
