'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');
const { mavenWarProject,mavenEarProject,listWarArtifacts,resolveWarArtifact,contextPattern } = require('./jakarta-war');
const { createTomcatDeployment,reviewTomcatWarSet,MAX_APPLICATIONS } = require('./jakarta-tomcat');
const { registerJakartaManager } = require('./jakarta-manager-vscode');
const { registerWildFly } = require('./jakarta-wildfly-vscode');

const MARKER='__rocketbrainJakartaRun';
const COMMANDS={build:'rocketbrain.jakarta.buildWar',deploy:'rocketbrain.jakarta.deploy',
  deploySet:'rocketbrain.jakarta.deploySet',addApplication:'rocketbrain.jakarta.addApplication',undeploy:'rocketbrain.jakarta.undeploy',
  manager:'rocketbrain.jakarta.manager',
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
  const packagingLabel=model=>model===mavenEarProject?'EAR':'WAR';

  function projects(model=mavenWarProject) {
    return java.workbench.getSnapshot().projects.filter(project => {
      try {workspacePath(project.root,roots());model(project);return true;}
      catch {return false;}
    });
  }

  async function projectFor(uri,cancellation,model=mavenWarProject) {
    trusted(cancellation);
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh({cancellation});
    trusted(cancellation);
    const root=workspacePath(uri,roots());
    const project=projects(model).find(item => !path.relative(item.root,root));
    if (!project) throw fail('Import the Maven '+packagingLabel(model)+' module in Java Projects first.');
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

  async function resolveSet(applications,cancellation) {
    if (!Array.isArray(applications) || applications.length<2 || applications.length>MAX_APPLICATIONS) {
      throw fail('Select two to '+MAX_APPLICATIONS+' Maven WAR artifacts.');
    }
    const entries=[];
    for (const {projectUri,warUri,context,expectedSha256} of applications) {
      const project=await projectFor(projectUri,cancellation);
      const artifact=resolveWarArtifact(project,warUri);
      entries.push({project,artifact,context,expectedSha256});
    }
    trusted(cancellation);
    return entries;
  }

  async function reviewSet({applications,cancellation}={}) {
    const entries=await resolveSet(applications,cancellation);
    const reviewed=await reviewTomcatWarSet(entries,cancellation);
    return reviewed.map(({context,artifact,expectedSha256},index) => ({projectUri:entries[index].project.uri,
      warUri:artifact.uri,context,expectedSha256,artifact:artifact.name,size:artifact.size}));
  }

  async function deploySet({applications,allowDeploy,cancellation}={}) {
    if (allowDeploy!==true) throw fail('Explicitly deploy the selected WAR set from a trusted workspace.');
    const entries=await resolveSet(applications,cancellation);
    const receipt=await backend.deploySet({applications:entries,tomcatHome:config().get('jakarta.tomcatHome'),
      javaHome:config().get('javaHome')||java.getState().javaHome||entries[0].project.jdk,
      workspaceTrusted:vscode.workspace.isTrusted,allowDeploy,cancellation});
    output.appendLine(`Tomcat ${receipt.version} started ${receipt.applications.length} applications at ${receipt.url}`);
    for (const {artifact,context,sha256} of receipt.applications) {
      output.appendLine(`${context} · ${artifact} · SHA-256 ${sha256}`);
    }
    return receipt;
  }

  async function reviewAddition({deploymentId,projectUri,warUri,context,cancellation}={}) {
    const project=await projectFor(projectUri,cancellation);
    saved(project);
    const artifact=resolveWarArtifact(project,warUri);
    trusted(cancellation);
    const review=await backend.reviewAddition({deploymentId,artifact,context,cancellation});
    return {...review,projectUri:project.uri,warUri:artifact.uri};
  }

  async function addApplication({deploymentId,projectUri,warUri,token,allowDeploy,cancellation}={}) {
    if (allowDeploy!==true) throw fail('Explicitly confirm adding the reviewed WAR.');
    const project=await projectFor(projectUri,cancellation);
    saved(project);
    const artifact=resolveWarArtifact(project,warUri);
    trusted(cancellation);
    const receipt=await backend.addApplication({deploymentId,artifact,token,allowDeploy,cancellation});
    output.appendLine(`Added ${receipt.application.context} · ${receipt.application.artifact} · SHA-256 ${receipt.application.sha256}`);
    return receipt;
  }

  async function undeploy(options) {
    trusted(options?.cancellation);
    const receipt=await backend.undeploy(options);
    output.appendLine(`Removed Tomcat application ${receipt.application.context}`);
    return receipt;
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

  async function chooseProject(model=mavenWarProject) {
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh();
    trusted();
    const observed=projects(model).sort((a,b) => b.root.length-a.root.length);
    const active=vscode.window.activeTextEditor?.document.uri;
    const current=active?.scheme==='file' && observed.find(project => inside(project.root,active.fsPath));
    if (!observed.length) throw fail('Import the Maven '+packagingLabel(model)+' module in Java Projects first.');
    return current || (await vscode.window.showQuickPick(observed.map(project => ({label:project.name,project})),
      {title:'Select Maven '+packagingLabel(model)+' Module'}))?.project;
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

  const remote=registerJakartaManager(vscode,{trusted,withProgress,chooseProject,listWarArtifacts,output,
    resolveArtifact:async (projectUri,warUri,cancellation) => resolveWarArtifact(await projectFor(projectUri,cancellation),warUri)});
  register(COMMANDS.manager,remote.command);
  const wildfly=registerWildFly(vscode,{trusted,withProgress,projectFor,chooseProject,saved,output,
    tools:project=>({wildflyHome:config().get('jakarta.wildflyHome'),
      javaHome:project.jdk||config().get('javaHome')||java.getState().javaHome})});
  for (const [id,handler] of Object.entries(wildfly.commands)) register(id,handler);

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
  register(COMMANDS.deploySet,async () => {
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh();
    trusted();
    const choices=projects().flatMap(project => listWarArtifacts(project).map(artifact => (
      {label:artifact.name,description:project.name,project,artifact})));
    if (choices.length<2) throw fail('Build at least two Maven WAR artifacts before deploying a set.');
    const selected=await vscode.window.showQuickPick(choices,{title:'Select WARs for One Tomcat Server',canPickMany:true,
      placeHolder:'Select two to '+MAX_APPLICATIONS+' WAR files'});
    if (!selected) return;
    if (selected.length<2 || selected.length>MAX_APPLICATIONS) throw fail('Select two to '+MAX_APPLICATIONS+' WAR files.');
    const applications=[];
    const contexts=new Set();
    for (const {project,artifact} of selected) {
      const context=await vscode.window.showInputBox({title:`Tomcat Context for ${artifact.name}`,value:mavenWarProject(project).context,
        validateInput:value => !contextPattern.test(value) ? 'Use lowercase letters, numbers and hyphens.' :
          contexts.has(value) ? 'Choose a context that differs from the other WARs.' : undefined});
      if (!context) return;
      contexts.add(context);
      applications.push({projectUri:project.uri,warUri:artifact.uri,context});
    }
    const reviewed=await withProgress('Review Jakarta WAR Set',cancellation => reviewSet({applications,cancellation}));
    const detail=reviewed.map(app => `/${app.context} · ${app.artifact}\nSHA-256 ${app.expectedSha256}`).join('\n\n');
    const chosen=await vscode.window.showWarningMessage('Start these WARs on one local Tomcat server?',{modal:true,detail},'Deploy WARs');
    if (chosen!=='Deploy WARs') return;
    output.show(true);
    return withProgress('Deploy Jakarta WAR Set',cancellation => deploySet({applications:reviewed,allowDeploy:true,cancellation}));
  });

  register(COMMANDS.addApplication,async () => {
    const state=backend.getState();
    if (!state.applications?.length) throw fail('Start a Jakarta WAR set before adding an application.');
    if (state.applications.length>=MAX_APPLICATIONS) throw fail('The running Tomcat deployment set is full.');
    const project=await chooseProject();
    if (!project) return;
    const existing=new Set(state.applications.map(app=>app.context.slice(1)));
    const choices=listWarArtifacts(project).map(artifact=>({label:artifact.name,description:project.name,artifact}));
    if (!choices.length) throw fail('Build a Maven WAR before adding an application.');
    const picked=await vscode.window.showQuickPick(choices,{title:'Select a WAR for the Running Tomcat Server'});
    if (!picked) return;
    const validate=value=>!contextPattern.test(value) ? 'Use lowercase letters, numbers and hyphens.' :
      existing.has(value) ? 'This context is already in use.' : undefined;
    const initial=mavenWarProject(project).context;
    const context=await vscode.window.showInputBox({title:'New Tomcat Context',value:existing.has(initial)?'':initial,
      validateInput:validate});
    if (!context) return;
    const reviewed=await withProgress('Review Jakarta WAR',cancellation=>reviewAddition({
      deploymentId:state.deploymentId,projectUri:project.uri,warUri:picked.artifact.uri,context,cancellation}));
    const detail=`${state.url}/${context}\n${reviewed.artifact}\nSHA-256 ${reviewed.expectedSha256}`;
    const approved=await vscode.window.showWarningMessage('Add this WAR to the running Tomcat server?',
      {modal:true,detail},'Add WAR');
    if (approved!=='Add WAR') return;
    output.show(true);
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Starting Tomcat Application'},
      ()=>addApplication({...reviewed,allowDeploy:true}));
  });

  async function selectApplication(state,title) {
    return (await vscode.window.showQuickPick(state.applications.map(app => (
      {label:app.context,description:app.artifact,detail:app.url,app})),{title}))?.app;
  }

  register(COMMANDS.undeploy,async () => {
    const state=backend.getState();
    if (!state.applications?.length) throw fail('Start a Jakarta WAR set to remove one application.');
    const app=await selectApplication(state,'Choose an Application to Undeploy');
    if (!app) return;
    const detail=`${app.url}\n${app.artifact}\nSHA-256 ${app.sha256}`+
      (state.applications.length===1?'\nThe server stops when its last application is removed.':'');
    const chosen=await vscode.window.showWarningMessage(`Undeploy ${app.context}?`,{modal:true,detail},'Undeploy');
    if (chosen==='Undeploy') return undeploy({deploymentId:state.deploymentId,context:app.context,
      expectedSha256:app.sha256,allowUndeploy:true});
  });

  register(COMMANDS.stop,stop);
  register(COMMANDS.status,async () => {
    const state=backend.getState();
    if (state.state!=='running') {void vscode.window.showInformationMessage('Tomcat deployment: '+state.state);return state;}
    const app=state.applications ? await selectApplication(state,'Running Tomcat Applications') : state;
    if (!app) return state;
    const choice=await vscode.window.showInformationMessage(`Tomcat ${state.version} · ${app.artifact} · ${app.url}`,
      'Open Application','Show Output');
    if (choice==='Open Application') await vscode.env.openExternal(vscode.Uri.parse(app.url));
    if (choice==='Show Output') output.show(true);
    return state;
  });

  return {artifacts:options => track(() => artifacts(options)),buildWar:options => track(() => buildWar(options)),
    deploy:options => track(async () => (await deployWar(options)).receipt),debug:options => track(() => debug(options)),stop,
    remoteManager:{observe:options => track(() => remote.observe(options)),review:options => track(() => remote.review(options)),
      execute:options => track(() => remote.execute(options))},
    wildfly:{review:options=>track(()=>wildfly.review(options)),reviewEar:options=>track(()=>wildfly.reviewEar(options)),
      deploy:options=>track(()=>wildfly.deploy(options)),
      status:wildfly.status,stop:()=>track(()=>wildfly.stop())},
    reviewSet:options => track(() => reviewSet(options)),deploySet:options => track(() => deploySet(options)),
    reviewAddition:options => track(() => reviewAddition(options)),addApplication:options => track(() => addApplication(options)),
    undeploy:options => track(() => undeploy(options)),
    getState:backend.getState,dispose() {
      if (closing) return closing;
      disposed=true;
      const remoteStopped=remote.dispose();
      closing=(async () => {
        try {
          const results=await Promise.allSettled([stop(),wildfly.dispose(),remoteStopped]);
          await backend.dispose();
          const failure=results.find(result=>result.status==='rejected');
          if(failure)throw failure.reason;
        }
        finally {await Promise.allSettled(jobs);for (const item of subscriptions) item.dispose();}
      })();
      return closing;
    }};
}

module.exports = { registerJakartaWorkbench,COMMANDS };
