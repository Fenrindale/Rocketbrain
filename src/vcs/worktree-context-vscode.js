'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {ActuatorClient}=require('../spring/runtime-client');
const {inspectRepository}=require('./changelist-git');
const {inspectWorktree,contextSettings,createWorktreeContextStore,listedSibling,same,inside,local}=require('./worktree-context');

const COMMAND='rocketbrain.gitWorktree.context';
const buildFiles=['pom.xml','build.gradle','build.gradle.kts','.project'];
const branch=row=>row.branch?.slice(0,100)||(row.detached?'Detached HEAD':'Worktree');
const localUri=uri=>uri?.scheme==='file'&&!uri.authority&&!uri.fragment&&!uri.query&&local(uri.fsPath);

function registerWorktreeContexts(context,vscode,{java,dbConnections}) {
  const storage=createWorktreeContextStore(context.globalState);
  const reviews=new WeakMap(),clients=new Set();
  let disposed=false;
  function trusted(){
    if(disposed||!vscode.workspace.isTrusted)throw Error('Trust this workspace before using Git worktree context.');
  }
  function folder(directory){
    const match=vscode.workspace.getWorkspaceFolder(vscode.Uri.file(directory));
    if(!localUri(match?.uri))throw Error('Open the local Git worktree in a trusted workspace.');
    return match.uri.fsPath;
  }
  function expose(observed,saved){
    const value={root:observed.current.root,branch:branch(observed.current),head:observed.current.head,
      worktrees:structuredClone(observed.worktrees),settings:structuredClone(saved?.settings??contextSettings()),revision:saved?.revision??0};
    reviews.set(value,{observed,settings:saved?.settings??contextSettings(),revision:saved?.revision??0});
    return value;
  }
  async function review(directory){
    trusted();
    const observed=await inspectWorktree(directory,folder(directory));
    trusted();
    return expose(observed,storage.get(observed.id));
  }
  async function current(value){
    trusted();
    const reviewed=reviews.get(value);
    if(!reviewed)throw Error('Inspect the selected Git worktree first.');
    const before=reviewed.observed;
    const live=await inspectWorktree(before.current.root,folder(before.current.root));
    const saved=storage.get(live.id);
    if(live.id!==before.id||live.group!==before.group||live.current.branch!==before.current.branch||
       live.current.head!==before.current.head||(saved?.revision??0)!==reviewed.revision||
       JSON.stringify(saved?.settings??contextSettings())!==JSON.stringify(reviewed.settings)) {
      throw Error('The Git worktree or saved context changed after review. Open its context again.');
    }
    trusted();
    return {live,settings:reviewed.settings,revision:reviewed.revision};
  }
  function belongs(live,root) {
    return inside(live.current.root,root)&&!live.worktrees.some(tree=>!same(tree.root,live.current.root)&&
      inside(live.current.root,tree.root)&&inside(tree.root,root));
  }
  async function projects(value) {
    const {live}=await current(value);
    const snapshot=await java.workbench.refresh();
    await current(value);
    return snapshot.projects.filter(project=>belongs(live,project.root));
  }
  function database(binding) {
    const target=binding&&dbConnections.list().find(profile=>profile.id===binding.id);
    if(!target||target.revision!==binding.revision)throw Error('The saved database profile changed or is unavailable in this workspace. Review the worktree context.');
    return target;
  }
  async function matchProject(live,relative){
    const candidate=path.resolve(live.current.root,relative);
    const physical=await fs.realpath(candidate);
    if(!same(candidate,physical)||!belongs(live,physical))throw Error('The Java module path left the selected worktree.');
    const owner=await inspectRepository(physical,folder(physical));
    if(owner?.key!==live.id)throw Error('Choose a Java module from the selected worktree.');
    const snapshot=await java.workbench.refresh();
    const observed=snapshot.projects.find(item=>same(item.root,physical));
    if(!observed)throw Error('Import the selected Java project into JDT before using this setting.');
    return observed;
  }
  async function save(value,input){
    const settings=contextSettings(input);
    let checked=await current(value);
    if(settings.project){
      await matchProject(checked.live,settings.project);
      checked=await current(value);
    }
    if(settings.database)database(settings.database);
    const saved=await storage.update(checked.live,checked.revision,settings);
    return expose(checked.live,saved);
  }
  async function project(value){
    const {live,settings}=await current(value);
    if(!settings.project)throw Error('Pin an imported Java project in this worktree first.');
    const result=await matchProject(live,settings.project);
    await current(value);
    return result;
  }
  async function clear(value){
    const {live,revision}=await current(value);
    return storage.update(live,revision,null);
  }
  async function spring(value){
    const {settings}=await current(value);
    if(!settings.spring)throw Error('Pin a loopback Spring Actuator service in this worktree first.');
    const client=new ActuatorClient({url:settings.spring,timeoutMs:5000,maxResponseBytes:1024*1024});
    clients.add(client);
    try{
      const result=await client.health();
      await current(value);
      return {url:settings.spring,health:result};
    }finally{clients.delete(client);client.dispose();}
  }
  async function openDatabase(value,{password}={}){
    const {settings}=await current(value);
    const target=database(settings.database);
    return dbConnections.openDedicatedConsole({id:target.id,revision:target.revision,password});
  }
  async function openSibling(value,root){
    const {live}=await current(value),selected=listedSibling(live,root);
    const reviewed=listedSibling(reviews.get(value).observed,root);
    if(selected.head!==reviewed.head||selected.branch!==reviewed.branch)throw Error('The sibling worktree changed. Review the current list.');
    const physical=await fs.realpath(selected.root);
    if(!same(physical,selected.root))throw Error('The sibling worktree path changed. Review the current list.');
    const sibling=await inspectWorktree(physical,physical);
    if(sibling.group!==live.group||sibling.current.head!==selected.head||sibling.current.branch!==selected.branch) {
      throw Error('The sibling worktree changed. Review the current list.');
    }
    await current(value);
    return vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(physical),{forceNewWindow:true});
  }
  async function chooseDirectory(){
    const active=vscode.window.activeTextEditor?.document.uri;
    if(localUri(active)&&vscode.workspace.getWorkspaceFolder(active))return path.dirname(active.fsPath);
    const folders=vscode.workspace.workspaceFolders?.filter(item=>localUri(item.uri))??[];
    if(folders.length===1)return folders[0].uri.fsPath;
    const selected=await vscode.window.showWorkspaceFolderPick({placeHolder:'Select an open Git worktree'});
    return localUri(selected?.uri)?selected.uri.fsPath:undefined;
  }
  async function configure(value){
    const modules=await projects(value);
    const chooseProject=await vscode.window.showQuickPick([
      {label:'No Java project',project:null},
      ...modules.map(item=>({label:item.name,description:item.tool+(value.settings.project&&same(path.resolve(value.root,value.settings.project),item.root)?' · Current':''),
        detail:item.root,
        project:(path.relative(value.root,item.root)||'.').split(path.sep).join('/')}))
    ],{title:'Default Java Project · '+value.branch});
    if(!chooseProject)return;
    const springUrl=await vscode.window.showInputBox({title:'Loopback Spring Actuator URL',value:value.settings.spring??'',
      placeHolder:'http://127.0.0.1:8080/actuator',prompt:'Leave blank to clear this setting',validateInput:text=>{
        try{contextSettings({spring:text.trim()});return undefined;}catch(error){return error.message;}
      }});
    if(springUrl===undefined)return;
    const chosen=await vscode.window.showQuickPick([
      {label:'No saved database profile',database:null},
      ...dbConnections.list().map(item=>({label:item.profile.name,
        description:item.profile.database+(value.settings.database?.id===item.id&&value.settings.database?.revision===item.revision?' · Current':''),
        database:{id:item.id,revision:item.revision}}))
    ],{title:'Database Profile for This Worktree'});
    if(!chosen)return;
    return save(value,{project:chooseProject.project,spring:springUrl.trim(),database:chosen.database});
  }
  async function showProject(value){
    const installed=await project(value);
    const files=(await Promise.all(buildFiles.map(async name=>{
      const file=path.join(installed.root,name);
      try {
        const stat=await fs.lstat(file);
        return stat.isFile()&&!stat.isSymbolicLink()?{label:'Open '+name,file}:null;
      }catch(error){if(error.code==='ENOENT')return null;throw error;}
    }))).filter(Boolean);
    const choice=await vscode.window.showQuickPick([
      {label:installed.name,description:installed.tool,detail:installed.root},
      {label:'Compiler and Classpath',detail:[installed.compliance,installed.jdk,installed.libraries.length+' libraries'].filter(Boolean).join(' · '),classpath:true},
      ...files
    ],{title:'Worktree Java Project'});
    if(choice?.classpath&&installed.libraries.length){
      await current(value);
      await vscode.window.showQuickPick(installed.libraries.map(item=>({label:item.name,description:item.kind,detail:item.path})),
        {title:'Worktree Java Classpath',matchOnDescription:true,matchOnDetail:true});
    }
    if(!choice?.file)return installed;
    await current(value);
    const stat=await fs.lstat(choice.file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('The selected project build file is unavailable.');
    const real=await fs.realpath(choice.file);
    if(!inside(installed.root,real)||!same(real,choice.file))throw Error('The project build file moved outside the reviewed module.');
    await vscode.window.showTextDocument(vscode.Uri.file(real));
    return installed;
  }
  async function open(){
    trusted();
    const directory=await chooseDirectory();
    if(!directory)return;
    const value=await review(directory),choices=[
      {label:'Configure Worktree Context',key:'configure'},
      ...(value.settings.project?[{label:'Inspect Java Project',description:value.settings.project,key:'project'}]:[]),
      ...(value.settings.spring?[{label:'Inspect Spring Service Health',description:value.settings.spring,key:'spring'}]:[]),
      ...(value.settings.database?[{label:'Open Dedicated Database Console',key:'database'}]:[]),
      {label:'Open a Linked Worktree',description:value.worktrees.length+' registered worktrees',key:'sibling'}
    ];
    if(value.revision)choices.push({label:'Clear Worktree Context',key:'clear'});
    const selected=await vscode.window.showQuickPick(choices,{
      title:'Git Worktree Context · '+value.branch,placeHolder:value.root,matchOnDescription:true
    });
    if(!selected)return;
    if(selected.key==='configure')return configure(value);
    if(selected.key==='project')return showProject(value);
    if(selected.key==='spring'){
      const result=await spring(value);
      void vscode.window.showInformationMessage('Spring service · '+result.health.status+' (HTTP '+result.health.httpStatus+')');
      return result;
    }
    if(selected.key==='database'){
      const target=database((await current(value)).settings.database);
      const password=target.profile.auth||target.hasSavedPassword?undefined:await vscode.window.showInputBox({
        title:target.profile.name,prompt:'Database password',password:true,ignoreFocusOut:true
      });
      if(!target.profile.auth&&!target.hasSavedPassword&&password===undefined)return;
      return openDatabase(value,{password});
    }
    if(selected.key==='sibling'){
      const choice=await vscode.window.showQuickPick(value.worktrees.filter(item=>!item.bare&&!item.prunable&&!same(item.root,value.root))
        .map(item=>({label:branch(item),description:item.root,detail:item.head.slice(0,12),root:item.root})),{title:'Open Linked Worktree'});
      if(choice)return openSibling(value,choice.root);
      return;
    }
    const action='Clear Context';
    if(await vscode.window.showWarningMessage('Clear saved context for '+value.root+'?',{modal:true},action)!==action)return;
    return clear(value);
  }
  const registration=vscode.commands.registerCommand(COMMAND,()=>open().catch(error=>{
    void vscode.window.showErrorMessage(error.message);
  }));
  return {review,save,clear,projects,project,spring,openDatabase,openSibling,dispose(){
    disposed=true;
    for(const client of clients)client.dispose();
    clients.clear();
    registration.dispose();
  }};
}

module.exports={registerWorktreeContexts};
