'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');
const { mavenWarProject,listWarArtifacts,resolveWarArtifact,contextPattern } = require('./jakarta-war');
const { createTomcatDeployment } = require('./jakarta-tomcat');

const MARKER='__rocketbrainJakartaRun';
const COMMANDS={build:'rocketbrain.jakarta.buildWar',deploy:'rocketbrain.jakarta.deploy',
  debug:'rocketbrain.jakarta.debug',status:'rocketbrain.jakarta.status',stop:'rocketbrain.jakarta.stop'};

function registerJakartaWorkbench(vscode,java) {
  const output=vscode.window.createOutputChannel('Rocketbrain Jakarta');
  const backend=createTomcatDeployment({log:chunk => output.append(chunk)});
  const subscriptions=[output], jobs=new Set(), pending=new Map();
  let disposed=false, closing, debugSession, generation=0;

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before using Jakarta deployment.');
    if (cancelled(cancellation)) throw fail('Jakarta operation cancelled.');
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders||[]);}
  function config() {return vscode.workspace.getConfiguration('rocketbrain.java');}
  function projects() {
    return java.workbench.getSnapshot().projects.filter(project => {
      try {workspacePath(project.root,roots());mavenWarProject(project);return true;}
      catch {return false;}
    });
  }

  async function projectFor(uri,cancellation) {
    trusted(cancellation);
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh({cancellation});
    trusted(cancellation);
    const root=workspacePath(uri,roots());
    const project=projects().find(item => !path.relative(item.root,root));
    if (!project) throw fail('Import the Maven WAR module in Java Projects first.');
    return project;
  }

  async function artifacts({projectUri,cancellation} = {}) {
    return listWarArtifacts(await projectFor(projectUri,cancellation));
  }

  function saved(project) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme==='file' &&
        inside(project.root,document.uri.fsPath))) throw fail('Save the modified Maven project files before building or debugging the WAR.');
  }

  async function buildWar({projectUri,allowProjectExecution,cancellation} = {}) {
    if (allowProjectExecution!==true) throw fail('Explicitly build the Maven WAR before executing Maven.');
    const project=await projectFor(projectUri,cancellation);
    saved(project);
    const options={projectUri:project.uri,allowProjectExecution,cancellation};
    const task=(await java.workbench.discoverTasks(options)).find(item => item.name==='package');
    if (!task) throw fail('The Maven WAR module has no observed package task.');
    trusted(cancellation);
    saved(project);
    const result=await java.workbench.runTask({...options,taskId:task.id});
    const war=result.state==='succeeded' ? listWarArtifacts(project) : [];
    return {...result,artifacts:war};
  }

  async function deployWar({projectUri,warUri,context,expectedSha256,allowDeploy,cancellation} = {},debug=false) {
    if (allowDeploy!==true) throw fail('Explicitly deploy the selected WAR from a trusted workspace.');
    const project=await projectFor(projectUri,cancellation);
    if (debug) saved(project);
    const artifact=resolveWarArtifact(project,warUri);
    trusted(cancellation);
    const receipt=await backend.deploy({artifact,context:context || mavenWarProject(project).context,expectedSha256,
      tomcatHome:config().get('jakarta.tomcatHome'),javaHome:project.jdk||config().get('javaHome')||java.getState().javaHome,
      workspaceTrusted:vscode.workspace.isTrusted,allowDeploy,cancellation,debug});
    output.appendLine(`Tomcat ${receipt.version} deployed ${receipt.artifact} to ${receipt.url}`);
    output.appendLine('WAR SHA-256: '+receipt.sha256);
    return {receipt,project};
  }

  subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
    const record=pending.get(session.configuration?.[MARKER]);
    if (session.type==='rocketbrain-java' && record) {
      record.session=session;
      record.resolve(session);
    }
  }),vscode.debug.onDidTerminateDebugSession(session => {
    if (debugSession?.id===session.id) debugSession=undefined;
    for (const record of pending.values()) if (record.session?.id===session.id) record.terminated=true;
  }));

  async function stop() {
    generation++;
    const {deploymentId}=backend.getState();
    const owned=[debugSession,...[...pending.values()].map(item => item.session)].filter(Boolean);
    debugSession=undefined;
    await Promise.allSettled([...new Set(owned)].map(session => vscode.debug.stopDebugging(session)));
    return deploymentId ? backend.stop(deploymentId) : {state:'stopped'};
  }

  async function debug(options) {
    const ticket=generation;
    const {receipt,project}=await deployWar(options,true);
    let timer;
    const id=randomUUID(), record={};
    const started=new Promise(resolve => {record.resolve=resolve;});
    pending.set(id,record);
    try {
      trusted(options.cancellation);
      if (ticket!==generation) throw fail('Tomcat debugger startup was stopped.');
      const uri=vscode.Uri.parse(project.uri);
      const attached=await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri),{
        type:'rocketbrain-java',request:'attach',name:'Rocketbrain Tomcat '+receipt.context,
        hostName:'127.0.0.1',port:receipt.debugPort,[MARKER]:id,
        sourcePaths:project.sourceRoots.filter(item => !item.unavailable).map(item => item.path)
      });
      if (!attached) throw fail('Could not attach the Rocketbrain Java debugger to the owned Tomcat JVM.');
      const session=await Promise.race([started,new Promise((_,reject) => {
        timer=setTimeout(() => reject(fail('The owned Tomcat debugger session did not start.')),10000);
      })]);
      trusted(options.cancellation);
      if (ticket!==generation || record.terminated) throw fail('Tomcat debugger startup was stopped.');
      debugSession=session;
      return {...receipt,sessionId:session.id};
    } catch (error) {
      if (record.session) await vscode.debug.stopDebugging(record.session).catch(() => {});
      await backend.stop(receipt.deploymentId);
      throw error;
    } finally {clearTimeout(timer);pending.delete(id);}
  }

  async function chooseProject() {
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh();
    trusted();
    const observed=projects().sort((a,b) => b.root.length-a.root.length);
    const active=vscode.window.activeTextEditor?.document.uri;
    const current=active?.scheme==='file' && observed.find(project => inside(project.root,active.fsPath));
    if (!observed.length) throw fail('Import the Maven WAR module in Java Projects first.');
    return current || (await vscode.window.showQuickPick(observed.map(project => ({label:project.name,project})),
      {title:'Select Maven WAR Module'}))?.project;
  }

  function track(action) {
    const request=Promise.resolve().then(action);
    jobs.add(request);
    void request.finally(() => jobs.delete(request)).catch(() => {});
    return request;
  }

  function register(id,action) {
    subscriptions.push(vscode.commands.registerCommand(id,() => track(async () => {
      try {trusted();return await action();}
      catch (error) {void vscode.window.showErrorMessage('Rocketbrain Jakarta: '+error.message);return undefined;}
    })));
  }

  function withProgress(title,action) {
    return vscode.window.withProgress({title,location:vscode.ProgressLocation.Notification,cancellable:true},
      (_progress,cancellation) => action(cancellation));
  }

  register(COMMANDS.build,async () => {
    const project=await chooseProject();
    if (!project) return;
    const result=await withProgress('Build Jakarta WAR',cancellation => buildWar({projectUri:project.uri,allowProjectExecution:true,cancellation}));
    if (result.state==='succeeded') {
      void vscode.window.showInformationMessage(result.artifacts.length
        ? 'Maven packaged '+result.artifacts.map(item => item.name).join(', ')
        : 'Maven completed without a WAR in the module target folder.');
    }
    return result;
  });

  async function chooseDeployment(attach) {
    const project=await chooseProject();
    if (!project) return;
    const current=listWarArtifacts(project);
    if (!current.length) throw fail('Build the Jakarta WAR before deploying it.');
    const item=await vscode.window.showQuickPick(current.map(artifact => ({label:artifact.name,
      description:(artifact.size/1024).toFixed(1)+' KiB',artifact})),{title:'Select WAR Artifact'});
    if (!item) return;
    const context=await vscode.window.showInputBox({title:'Tomcat Context Name',value:mavenWarProject(project).context,
      validateInput:value => contextPattern.test(value) ? undefined : 'Use lowercase letters, numbers and hyphens.'});
    if (!context) return;
    output.show(true);
    const result=await withProgress(attach ? 'Debug Jakarta WAR' : 'Deploy Jakarta WAR',async cancellation => {
      const action={projectUri:project.uri,warUri:item.artifact.uri,context,allowDeploy:true,cancellation};
      return attach ? debug(action) : (await deployWar(action)).receipt;
    });
    void vscode.window.showInformationMessage('Tomcat deployment ready at '+result.url);
    return result;
  }

  register(COMMANDS.deploy,() => chooseDeployment(false));
  register(COMMANDS.debug,() => chooseDeployment(true));
  register(COMMANDS.stop,stop);
  register(COMMANDS.status,async () => {
    const state=backend.getState();
    if (state.state!=='running') {void vscode.window.showInformationMessage('Tomcat deployment: '+state.state);return state;}
    const choice=await vscode.window.showInformationMessage(`Tomcat ${state.version} · ${state.artifact} · ${state.url}`,
      'Open Application','Show Output');
    if (choice==='Open Application') await vscode.env.openExternal(vscode.Uri.parse(state.url));
    if (choice==='Show Output') output.show(true);
    return state;
  });

  return {artifacts:options => track(() => artifacts(options)),buildWar:options => track(() => buildWar(options)),
    deploy:options => track(async () => (await deployWar(options)).receipt),debug:options => track(() => debug(options)),stop,
    getState:backend.getState,dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try {await stop();await backend.dispose();}
        finally {await Promise.allSettled(jobs);for (const item of subscriptions) item.dispose();}
      })();
      return closing;
    }};
}

module.exports = { registerJakartaWorkbench,COMMANDS };
