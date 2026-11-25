'use strict';

const path=require('node:path');
const fs=require('node:fs/promises');
const { randomUUID }=require('node:crypto');
const { readQualitySarif,resolveQualityLocation }=require('./quality-gate');
const { RULES }=require('./inspection-profiles');
const { inside }=require('../vcs/changelist-git');
const { repository }=require('./quality-git');

const command='rocketbrain.java.openQualityReport';
const scheme='rocketbrain-java-quality';

function registerQualityReport(vscode) {
  const records=new WeakMap(), contents=new Map(), pending=new Set();
  let disposed=false;

  function trust() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted local workspace before reviewing committed Java findings.');
  }

  function local(uri) {
    return uri?.scheme==='file' && !uri.authority && !uri.query && !uri.fragment && path.isAbsolute(uri.fsPath);
  }

  function folder(uri) {
    trust();
    const open=vscode.workspace.workspaceFolders?.find(item=>item.uri.toString()===uri?.toString());
    if (!open || !local(open.uri)) throw Error('Choose the open local workspace folder for the recorded Git repository.');
    return open.uri;
  }

  async function repoInFolder(root,repoUri) {
    if (!local(repoUri)) throw Error('Choose a local Git worktree.');
    const [workspace,repo]=await Promise.all([fs.realpath(root.fsPath),fs.realpath(repoUri.fsPath)]);
    if (!inside(workspace,repo)) throw Error('Choose a Git worktree inside the selected workspace folder.');
    return repository(repo);
  }

  async function read(reportUri,folderUri,repoUri=folderUri) {
    const root=folder(folderUri);
    if (!local(reportUri)) throw Error('Choose a local Rocketbrain SARIF report.');
    const [report,repo]=await Promise.all([readQualitySarif(reportUri.fsPath),repoInFolder(root,repoUri)]);
    folder(root);
    const result=structuredClone(report);
    records.set(result,{report,root,repoUri,repo});
    return result;
  }

  async function open(handle,index) {
    trust();
    const record=records.get(handle), item=record?.report.items[index];
    if (!item || !Number.isSafeInteger(index)) throw Error('Choose an issue in the loaded quality gate report.');
    const root=folder(record.root), controller=new AbortController();
    pending.add(controller);
    let source;
    try {
      const repo=await repoInFolder(root,record.repoUri);
      if (repo!==record.repo) throw Error('The Git worktree location changed. Open the SARIF report again.');
      source=await resolveQualityLocation(repo,record.report,item,controller.signal);
    }
    finally { pending.delete(controller); }
    folder(root);
    const uri=vscode.Uri.from({scheme,path:'/'+record.report.revision.slice(0,12)+'/'+randomUUID()+'/'+item.path});
    const key=uri.toString();
    if (contents.size>=12) contents.delete(contents.keys().next().value);
    contents.set(key,source.text);
    let document;
    try { document=await vscode.workspace.openTextDocument(uri); }
    catch (error) { contents.delete(key);throw error; }
    folder(root);
    const {start,end}=source.range;
    return vscode.window.showTextDocument(document,{preview:true,
      selection:new vscode.Range(start.line,start.character,end.line,end.character)});
  }

  const provider=vscode.workspace.registerTextDocumentContentProvider(scheme,{
    provideTextDocumentContent(uri) {
      trust();
      const text=contents.get(uri.toString());
      if (text===undefined) throw Error('Open the recorded Java source from its quality report again.');
      return text;
    }
  });

  const closed=vscode.workspace.onDidCloseTextDocument(document=>{
    if (document.uri.scheme===scheme) contents.delete(document.uri.toString());
  });

  const registered=vscode.commands.registerCommand(command,async()=>{
    try {
      trust();
      const folders=(vscode.workspace.workspaceFolders ?? []).filter(item=>local(item.uri));
      if (!folders.length) throw Error('Open the local Git worktree as a workspace folder.');
      const root=folders.length===1?folders[0]:await vscode.window.showWorkspaceFolderPick({placeHolder:'Git worktree containing the recorded commit'});
      if (!root) return;
      const [file]=await vscode.window.showOpenDialog({canSelectMany:false,filters:{SARIF:['sarif','json']},
        title:'Open Rocketbrain Java Quality Gate Report'}) ?? [];
      if (!file) return;
      let repoUri=root.uri;
      if (!await repoInFolder(root.uri,repoUri).catch(()=>null)) {
        [repoUri]=await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,
          defaultUri:root.uri,title:'Select Git Worktree for the Report'}) ?? [];
        if (!repoUri) return;
      }
      const report=await read(file,root.uri,repoUri);
      const newCount=report.items.filter(item=>item.state==='new').length;
      if (!report.items.length) {
        await vscode.window.showInformationMessage('No Java findings for '+report.revision.slice(0,12)+'.');
        return report;
      }
      const choices=report.items.map((item,index)=>({
        label:RULES[item.rule].label,description:item.state+' · '+item.severity,
        detail:item.path+':'+(item.range.start.line+1),index,state:item.state
      })).sort((left,right)=>Number(right.state==='new')-Number(left.state==='new'));
      const choice=await vscode.window.showQuickPick(choices,{matchOnDetail:true,matchOnDescription:true,
        title:'Java Quality '+report.revision.slice(0,12)+' · '+newCount+' new · '+(report.items.length-newCount)+' unchanged'});
      if (choice) await open(report,choice.index);
      return report;
    } catch (error) {
      if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Java quality gate: '+error.message);
    }
  });

  return {read,open,dispose(){
    if (disposed) return;
    disposed=true;
    for (const controller of pending) controller.abort();
    contents.clear();
    registered.dispose();
    provider.dispose();
    closed.dispose();
  }};
}

module.exports={registerQualityReport};
