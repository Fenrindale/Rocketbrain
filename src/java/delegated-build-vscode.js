'use strict';

const path = require('node:path');
const {inside,fail,workspacePath,workspaceRoots,local,buildFingerprint} = require('./workbench-model');
const {createDelegatedBuild,physicalKey} = require('./delegated-build');

function registerDelegatedBuild(vscode,{workbench,output}) {
  const compileCommand = 'rocketbrain.java.reviewDelegatedCompile';
  const retryCommand = 'rocketbrain.java.retryDelegatedCompile';
  const taskCache = new Map();
  const subscriptions = [];
  let disposed = false;
  const assertTrusted = () => {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the workspace before reviewing a delegated Java compile.');
  };
  async function observedProjects(cancellation) {
    assertTrusted();
    const current = workbench.getSnapshot();
    const snapshot = current.projects.length ? current : await workbench.refresh({cancellation});
    return snapshot.projects.filter(project=>project.tool==='maven'||project.tool==='gradle');
  }
  async function projectFor(value,cancellation) {
    const projects = await observedProjects(cancellation);
    let candidate;
    try {candidate = physicalKey(local(value));} catch {}
    const select = project=>project.id===value || project.uri===value || physicalKey(project.root)===candidate;
    let match = projects.find(select);
    if (!match || physicalKey(workspacePath(match.root,workspaceRoots(vscode.workspace.workspaceFolders || [])))!==physicalKey(match.root)) {
      throw fail('Choose a currently imported local Maven or Gradle project.');
    }
    if (match.buildFingerprint!==buildFingerprint(match.root)) {
      match = (await workbench.refresh({cancellation})).projects.find(select);
      if (!match) throw fail('The previously imported Java build project is no longer available.');
    }
    return match;
  }
  const api = createDelegatedBuild({
    projectFor,assertTrusted,
    assertSaved(root,inputs) {
      const all = new Set([...inputs.keys()].map(relative=>physicalKey(path.join(root,relative))));
      for (const document of vscode.workspace.textDocuments) {
        if (document.isClosed || !document.isDirty || document.uri.scheme!=='file') continue;
        const file = document.uri.fsPath, relative = path.relative(root,file).split(path.sep).join('/');
        if (inside(root,file) && (all.has(physicalKey(file)) || /^src\/main\/(?:java|resources)\//u.test(relative))) {
          throw fail('Save the selected project source and build buffers before compiling.');
        }
      }
    },
    async taskFor(project,name,cancellation) {
      const validity = project.buildFingerprint;
      const cached = taskCache.get(project.id);
      if (cached?.fingerprint===validity) return cached.task;
      const found = await workbench.discoverTasks({projectUri:project.uri,allowProjectExecution:true,cancellation});
      const task = found.find(item=>item.name===name);
      if (task) taskCache.set(project.id,{task,fingerprint:validity});
      return task;
    },
    async runTask(project,task,cancellation) {
      try {return await workbench.runTask({projectUri:project.uri,taskId:task.id,allowProjectExecution:true,cancellation});}
      catch (error) {taskCache.delete(project.id);throw error;}
    }
  });
  async function show(plan) {
    const counts = plan.sincePrevious;
    const detail = [
      plan.tool+' '+plan.task+' · '+plan.inputs+' saved project inputs',
      'Since previous attempt · '+counts.changed.length+' changed, '+counts.added.length+' added, '+counts.removed.length+' removed',
      ...(plan.retryOf?['Retry the same task with the current saved inputs.']:[])
    ].join('\n');
    if (await vscode.window.showInformationMessage('Run delegated compile in '+plan.projectName+'?',{modal:true,detail},
      'Run Delegated Compile')!=='Run Delegated Compile') return;
    const report = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Delegated Java Compile',cancellable:true},
      (_progress,cancellation)=>api.apply({id:plan.id,allowProjectExecution:true,cancellation}));
    const classes = report.classes;
    const states = {
      'outputs-produced':'class files produced',
      'outputs-reused':'the observed class files were preserved',
      'outputs-updated':'observed class files changed',
      'no-classes':'no standard class files observed',
      unverified:'class output is unverified for this attempt',
      unobserved:'class output could not be observed'
    };
    const message = report.projectName+' · '+report.tool+' '+report.task+' '+report.state+' · '+states[classes.state];
    output.appendLine(message);
    if (classes.after!==null) output.appendLine('Observed class files '+classes.before+' before → '+classes.after+' after.');
    if (report.inputsChanged) output.appendLine('Saved project inputs changed during this attempt.');
    if (report.state==='failed') {
      void vscode.window.showWarningMessage(message,'Review Retry').then(choice=>{
        if (choice==='Review Retry') return vscode.commands.executeCommand(retryCommand,report.id);
      }).catch(error=>output.appendLine(error.message));
    } else void vscode.window.showInformationMessage(message);
    return report;
  }
  const registered = (command,action)=>vscode.commands.registerCommand(command,async argument=>{
    try {assertTrusted(); return await action(argument);}
    catch (error) {output.appendLine(error.message);void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);}
  });
  subscriptions.push(registered(compileCommand,async value=>{
    let projectUri = typeof value==='string' ? value : value?.uri || value?.id;
    if (!projectUri) {
      const projects = await observedProjects();
      const chosen = await vscode.window.showQuickPick(projects.map(project=>({label:project.name,
        description:project.tool,projectUri:project.uri})),{title:'Review delegated Java compile'});
      if (!chosen) return;
      projectUri = chosen.projectUri;
    }
    return show(await api.prepare({projectUri}));
  }),registered(retryCommand,async id=>{
    const failures = api.report().filter(report=>report.state==='failed');
    const selected = id ? failures.find(report=>report.id===id) :
      (await vscode.window.showQuickPick(failures.map(report=>({label:report.projectName,description:report.tool,
        detail:'Previous '+report.task+' failed',report})),{title:'Review a failed delegated compile'}))?.report;
    if (selected) return show(await api.prepare({projectUri:selected.projectUri,retryFrom:selected.id}));
  }));
  if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{
    taskCache.clear();
    api.invalidate();
  }));
  return {...api,dispose(){
    disposed=true;
    taskCache.clear();
    api.dispose();
    for (const subscription of subscriptions) subscription.dispose();
  }};
}

module.exports = {registerDelegatedBuild};
