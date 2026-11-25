'use strict';

const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {inspectWorktree}=require('./worktree-context');
const {shelfController}=require('./shelf');
const {PATCH_BYTES}=require('./shelf-patch');

const SCHEME='rocketbrain-git-shelf', SHELVE='rocketbrain.vcs.shelveHunks', MANAGE='rocketbrain.vcs.shelves';
const branch=value=>value.branch||'detached '+value.head.slice(0,10);
const statusText={
  ready:'Ready to restore',
  'already-applied':'The selected changes are already present',
  conflict:'Git could not apply all hunks cleanly. The saved shelf is available after you resolve the conflicting changes.',
  ambiguous:'The patch matches more than one possible location. Review the current file or choose another branch.'
};

function registerShelf(context,vscode,{required,chooseRepository,guard}) {
  let disposed=false;
  const documents=new Map();
  function assertFile(repo,name) {
    guard(repo.ticket);
    const file=path.join(repo.root,...name.split('/'));
    if(vscode.workspace.textDocuments.some(document=>document.uri.scheme==='file'&&
        !path.relative(file,document.uri.fsPath)&&document.isDirty)) {
      throw Error('Save the reviewed Git Shelf files before continuing.');
    }
  }
  async function identify(repository) {
    guard(repository.ticket);
    const observed=await inspectWorktree(repository.root,repository.folder.uri.fsPath);
    guard(repository.ticket);
    if(observed.id!==repository.key||observed.current.prunable) throw Error('The Git worktree changed. Open Git Shelf again.');
    return {...repository,...observed.current,group:observed.group};
  }
  async function verify(repo) {
    const fresh=await identify(repo);
    if(fresh.key!==repo.key||fresh.group!==repo.group) throw Error('The Git worktree changed. Open Git Shelf again.');
    return fresh;
  }
  async function repository(option) {
    const selected=option?.repositoryUri?await required(option.repositoryUri):await chooseRepository();
    return selected&&identify(selected);
  }
  const service=shelfController(context.workspaceState,{verify,checkFile:assertFile});
  const api={
    select:service.select,shelve:service.shelve,restore:service.restore,
    async inspect(option){const repo=await repository(option);return repo&&service.inspect(repo);},
    async list(option){const repo=await repository(option);return repo&&service.list(repo);},
    async preview(option){const repo=await repository(option);return repo&&service.preview(repo,option.id);},
    async previewRestore(option){const repo=await repository(option);return repo&&service.previewRestore(repo,option.id);},
    async remove(option){const repo=await repository(option);return repo&&service.remove(repo,option.id);},
    async openPatch(patch) {
      guard();
      if(typeof patch!=='string'||!patch||Buffer.byteLength(patch)>PATCH_BYTES) throw Error('Choose a bounded Git Shelf patch to preview.');
      const uuid=randomUUID();
      if(documents.size>=16)documents.delete(documents.keys().next().value);
      documents.set(uuid,patch);
      const uri=vscode.Uri.from({scheme:SCHEME,path:'/'+uuid+'/selected-hunks.diff'});
      const document=await vscode.workspace.openTextDocument(uri);
      guard();
      return vscode.window.showTextDocument(document,{preview:true});
    }
  };

  async function showCapture(option) {
    const repo=await repository(option);
    if(!repo)return;
    const review=await service.inspect(repo);
    if(!review.hunks.length) {
      void vscode.window.showInformationMessage('No supported saved worktree hunks are available to shelve.');
      return review;
    }
    const picks=await vscode.window.showQuickPick(review.hunks.map(hunk=>({label:hunk.path,
      description:'Line '+hunk.newLine,detail:hunk.changed,id:hunk.id})),
    {title:'Select Git Worktree Hunks · '+branch(review),matchOnDetail:true,canPickMany:true,
      placeHolder:review.omitted?review.omitted+' changed paths are outside this review.':'Choose the changes to store on the shelf'});
    if(!picks?.length)return;
    const selected=service.select(review,picks.map(item=>item.id));
    await api.openPatch(selected.patch);
    const name=await vscode.window.showInputBox({title:'Name the Git Shelf',prompt:'Name this saved set of changes',ignoreFocusOut:true});
    if(name===undefined)return;
    if(await vscode.window.showWarningMessage('Shelve the reviewed worktree hunks?',{modal:true,
      detail:selected.count+' hunks in '+selected.paths.length+' files on '+branch(selected)+'. The patch is saved before Git removes these hunks.'},
    'Shelve Selected Hunks')!=='Shelve Selected Hunks')return;
    const item=await service.shelve(selected,name);
    void vscode.window.showInformationMessage('Saved Git shelf '+item.name+'.');
    return item;
  }

  async function showShelves(option) {
    const repo=await repository(option);
    if(!repo)return;
    const entries=await service.list(repo);
    const selected=await vscode.window.showQuickPick(entries.map(item=>({label:item.name,
      description:branch(item)+' · '+item.count+' hunks',detail:item.head.slice(0,12)+' · '+new Date(item.createdAt).toLocaleString()+
      (item.state==='captured'?' · Saved copy, worktree removal unconfirmed':''),item})),
    {title:'Git Shelf · '+path.basename(repo.root),placeHolder:entries.length?'Select a saved patch':'No shelves saved for this Git repository'});
    if(!selected)return;
    const actions=await vscode.window.showQuickPick(['Open Saved Patch','Review Restore Here','Delete Shelf'],
      {title:selected.item.name+' · Git Shelf'});
    if(actions==='Open Saved Patch')return api.openPatch(await service.preview(repo,selected.item.id));
    if(actions==='Delete Shelf') {
      if(await vscode.window.showWarningMessage('Permanently remove the saved Git Shelf copy?',{modal:true},'Delete Shelf')==='Delete Shelf') {
        return service.remove(repo,selected.item.id);
      }
      return;
    }
    if(actions!=='Review Restore Here')return;
    const preview=await service.previewRestore(repo,selected.item.id);
    await api.openPatch(preview.patch);
    if(preview.status!=='ready') {
      void vscode.window.showInformationMessage(statusText[preview.status]);
      return preview;
    }
    if(await vscode.window.showWarningMessage('Restore the reviewed shelf to this worktree?',{modal:true,
      detail:preview.count+' hunks in '+preview.paths.length+' files on '+branch(preview)+'. The saved shelf stays available.'},
    'Restore Shelf')!=='Restore Shelf')return;
    const result=await service.restore(preview);
    void vscode.window.showInformationMessage(result.status==='applied'?'Restored '+preview.name+'.':statusText[result.status]);
    return result;
  }

  function run(action) {
    return async option=>{
      try {guard();return await action(option);}
      catch(error){if(!disposed)void vscode.window.showErrorMessage('Rocketbrain Git Shelf · '+error.message);}
    };
  }
  const subscriptions=[
    vscode.workspace.registerTextDocumentContentProvider(SCHEME,{provideTextDocumentContent(uri){
      return documents.get(uri.path.split('/')[1])||'This Git Shelf preview expired.';
    }}),
    vscode.commands.registerCommand(SHELVE,run(showCapture)),
    vscode.commands.registerCommand(MANAGE,run(showShelves))
  ];
  return {...api,dispose(){
    disposed=true;
    for(const entry of subscriptions)entry.dispose();
    documents.clear();
    return service.drain();
  }};
}

module.exports={registerShelf,SHELVE,MANAGE};
