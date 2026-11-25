'use strict';

const path=require('node:path');
const {cleanupDraft,verifyCleanup}=require('./java-cleanup');

const COMMAND='rocketbrain.java.cleanUpFile';
const TITLE='Review Java File Cleanup';
const normalize=text=>text.replace(/\r\n/g,'\n');

function createJavaCleanup(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  async function prepare({document,cancellation}={}) {
    assertReady(cancellation);
    if(!document||document.languageId!=='java'||document.isDirty||document.isClosed||document.uri?.scheme!=='file') {
      throw Error('Open a saved Java file before reviewing cleanup.');
    }
    const version=document.version,text=document.getText();
    const current=await snapshot(document.uri,cancellation);
    if(normalize(text)!==normalize(current.text))throw Error('Open the exact saved Java source before cleanup.');
    const state=await projects(cancellation),project=findProject(state.projects,document.uri);
    const sources=await classSources(project,cancellation);
    const observed=sources.find(file=>file.sha===current.sha&&!path.relative(vscode.Uri.parse(file.uri).fsPath,document.uri.fsPath));
    if(!observed)throw Error('Choose a saved Java file in an imported production source root.');
    const originals=new Map(sources.map(file=>[file.uri,file.sha]));
    const analyze=(input,stage,options)=>compile(state,project,sources.map(file=>file===observed?{...file,text:input}:file),
      {kind:'cleanup',uri:observed.uri,stage},cancellation,options);
    function checkAnchor(token) {
      assertReady(token);
      const active=java.getState();
      if(document.isDirty||document.isClosed||document.version!==version||document.getText()!==text||
        active.state!=='running'||active.runtimeIdentity!==state.runtimeIdentity) {
        throw Error('The Java file or runtime changed. Review cleanup again.');
      }
    }
    checkAnchor(cancellation);
    const baseline=await analyze(text,'plan');
    const draft=cleanupDraft(text,baseline.cleanup);
    checkAnchor(cancellation);
    if(!draft.edits.length)return null;
    const verified=await analyze(draft.text,'verify',{errorTitle:'The Java cleanup would fail compiler analysis: '});
    if(verified.classpathFingerprint!==baseline.classpathFingerprint)throw Error('The Java classpath changed during cleanup review.');
    verifyCleanup(baseline.cleanup,verified.cleanup);
    checkAnchor(cancellation);
    const plan=await java.refactoring.previewWorkspaceEdit({documentChanges:[{
      textDocument:{uri:observed.uri,version},edits:draft.edits
    }]},{title:'Java File Cleanup · '+draft.summary,kind:'source.rocketbrainJavaCleanup',anchorDocument:document,cancellation,
      validate:async token=>{
        checkAnchor(token);
        const live=await classSources(project,token),entries=await classpaths(project,token);
        if(live.length!==originals.size||live.some(file=>file.sha!==originals.get(file.uri))||
          entries.length!==verified.classpathEntries.length||entries.some((entry,index)=>entry!==verified.classpathEntries[index])) {
          throw Error('Java source or classpath changed after cleanup review.');
        }
        verified.validateClasspath();
      },
      preApply:token=>{checkAnchor(token);assertUnchangedSourceSnapshots(sources);verified.validateClasspath();}
    });
    return {...plan,cleanup:{counts:draft.counts,bindingsPreserved:true}};
  }

  async function run() {
    const document=vscode.window.activeTextEditor?.document;
    const plan=await operation(TITLE,cancellation=>prepare({document,cancellation}));
    if(plan)return java.refactoring.review(plan);
    void vscode.window.showInformationMessage('This Java file has no supported cleanup changes.');
    return null;
  }

  return {prepare,run};
}

module.exports={createJavaCleanup,COMMAND,TITLE};
