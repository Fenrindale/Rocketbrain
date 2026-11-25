'use strict';

const SCHEME='rocketbrain-java-test-history';
const CONFIG='saveHistory';
const compareKinds={
  'opentest4j':'Structured OpenTest4J comparison',
  'junit4':'JUnit 4 string comparison',
  'junit3':'JUnit 3 string comparison',
  'testng-text':'TestNG formatted comparison text',
  'structured':'Structured comparison'
};

function registerTestHistoryView(vscode,{history,trusted,replay}) {
  const config=()=>vscode.workspace.getConfiguration('rocketbrain.java.testing');
  const enabled=()=>config().get(CONFIG,false)===true;
  function failure(id,index){
    const run=history.get(id);
    const item=Number.isSafeInteger(index)&&index>=0?run?.failures[index]:undefined;
    if(!item)throw Error('The saved Java test failure is no longer available.');
    return item;
  }
  const provider=vscode.workspace.registerTextDocumentContentProvider?.(SCHEME,{
    provideTextDocumentContent(uri) {
      trusted();
      const match=/^\/([0-9a-f-]{36})\/(\d{1,2})\/(expected|actual)\.txt$/.exec(uri.path);
      if(!match||uri.authority||uri.query||uri.fragment)throw Error('Open a comparison from saved Java test history.');
      const report=failure(match[1],Number(match[2])).comparison;
      if(!report)throw Error('This failure has no saved comparison.');
      return report[match[3]];
    }
  });
  function sources(id,index) {
    trusted();
    const item=failure(id,index);
    if(!item.comparison)throw Error('This failure has no saved comparison.');
    const uri=side=>vscode.Uri.from({scheme:SCHEME,path:`/${id}/${index}/${side}.txt`});
    return {expected:uri('expected'),actual:uri('actual')};
  }
  async function openDiff(id,index) {
    const item=failure(id,index),{expected,actual}=sources(id,index);
    await vscode.commands.executeCommand('vscode.diff',expected,actual,item.label+' · Expected ↔ Actual',{preview:false});
    return {expected,actual};
  }
  const compareLabel=value=>Object.hasOwn(compareKinds,value.kind)?compareKinds[value.kind]:compareKinds.structured;
  async function open() {
    trusted();
    const runs=history.list();
    const menu=runs.map(run=>({
      label:new Date(run.when).toLocaleString(),
      description:run.projects.map(project=>project.label).join(', '),
      detail:run.projects.reduce((total,project)=>total+project.failed,0)+' failed tests · '+run.mode,
      run
    }));
    if(!enabled())menu.unshift({label:'Enable Java Test History',detail:'Save completed outcomes and comparison text for this workspace',enable:true});
    if(!menu.length){void vscode.window.showInformationMessage('Completed Java test runs will appear in this workspace’s history.');return;}
    const chosen=await vscode.window.showQuickPick(menu,{title:'Java Test Run History',matchOnDescription:true});
    if(!chosen)return;
    if(chosen.enable){
      trusted();
      if(!vscode.workspace.workspaceFolders?.length)throw Error('Open a workspace to enable Java test history.');
      await config().update(CONFIG,true,vscode.ConfigurationTarget.Workspace);
      return;
    }
    const run=chosen.run,choices=run.failures.map((item,index)=>({
      label:item.label||item.failureType||'Java test failure',description:item.framework,detail:item.message,index
    }));
    const replayable=run.failures.filter(item=>item.rerun).length;
    if(replayable)choices.unshift({label:'Rerun Saved Failures',description:replayable+' stable test IDs',all:true});
    choices.unshift({label:'Run Summary',detail:run.projects.map(project=>`${project.passed} passed · ${project.failed} failed · ${project.skipped} skipped`).join(' | '),summary:true});
    const item=await vscode.window.showQuickPick(choices,{
      title:'Results · '+new Date(run.when).toLocaleString(),
      placeHolder:run.omittedFailures?run.omittedFailures+' additional failure details exceed the history limit':undefined
    });
    if(!item)return;
    if(item.all)return replay(run.id);
    if(item.summary){
      const detail=run.projects.map(project=>`${project.label}: ${project.passed} passed, ${project.failed} failed, ${project.skipped} skipped, ${project.aborted} aborted, ${project.containerFailures} container failures`).join('\n');
      void vscode.window.showInformationMessage('Java Test Run Summary',{modal:true,detail});
      return;
    }
    const saved=failure(run.id,item.index);
    const actions=[{label:'Show Failure Message',detail:saved.failureType,action:'message'}];
    if(saved.comparison)actions.push({label:'Compare Expected and Actual',description:compareLabel(saved.comparison),
      detail:[saved.comparison.expectedType,saved.comparison.actualType].filter(Boolean).join(' ↔ '),action:'compare'});
    if(saved.rerun)actions.push({label:'Rerun This Saved Failure',action:'rerun'});
    const selected=await vscode.window.showQuickPick(actions,{title:item.label});
    if(selected?.action==='compare')return openDiff(run.id,item.index);
    if(selected?.action==='rerun')return replay(run.id,item.index);
    if(selected?.action==='message')void vscode.window.showInformationMessage(item.label,{modal:true,detail:saved.message});
  }
  async function clear() {
    trusted();
    const action='Clear History';
    if(await vscode.window.showWarningMessage('Clear saved Java test run history for this workspace?',{modal:true},action)!==action)return;
    trusted();
    await history.clear();
  }
  return {enabled,open,clear,openDiff,sources,dispose(){provider?.dispose();}};
}

module.exports={registerTestHistoryView};
