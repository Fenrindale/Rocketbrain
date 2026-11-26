'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const M=require('./workbench-model'),{BuildTasks,nativeTaskRunner}=require('./workbench-tasks'),{independentJavaExecutable}=require('./debug-runtime');
const {registerMixedJvmWorkbench}=require('./mixed-jvm-vscode');
const { observedOutput } = require('./workbench-source-layout');
const Spring=require('./spring-launch');
const {chooseSpringLaunch}=require('./spring-launch-vscode');
const {registerSharedRuns}=require('./shared-run-vscode');
const {createRuntimeReview}=require('./module-runtimes-vscode');
const IMPORT_BUDGET_MS=180000;
const CONFIG_KEY='rocketbrain.java.workbench.configurations.v18',SECRET_PREFIX='rocketbrain.java.workbench.environment.',RUN_MARKER=Spring.marker,SPRING_SECRET_PREFIX='rocketbrain.java.workbench.spring.';
const COMMANDS=['refresh','resync','build','tasks','runTask','configureRun','configureSpringRun','run','debug','startRunGroup','stop','deleteRunConfiguration','exportSharedRun','importSharedRun','reviewRuntimes','changeRuntime','revealProjectDependency','revealBuildOutput','openSource'].map(n=>'rocketbrain.java.workbench.'+n);
const ALLOWED=new Set(['java.project.getAll','java.project.getSettings','java.project.getClasspaths','java.project.changeImportedProjects','vscode.java.resolveMainClass']);
function registerJavaWorkbench(context,vscode,java,output,{runner}={}){let disposed=false,generation=0,launchGeneration=0,refreshing=new Map(),busy=false,snapshot={format:'RocketbrainJavaWorkbench',formatVersion:1,projects:[],limits:M.LIMITS},nodes=new Map();const active=new Map(),pendingStarts=new Map(),operations=new Set(),changed=new vscode.EventEmitter(),subscriptions=[changed];
 const trusted=()=>{if(disposed||!vscode.workspace.isTrusted)throw M.fail('Trust the local workspace before using Java project tools.');};
 const track=fn=>{const p=Promise.resolve().then(fn);operations.add(p);void p.finally(()=>operations.delete(p)).catch(()=>{});return p;};
 const config=()=>vscode.workspace.getConfiguration('rocketbrain.java'),roots=()=>M.workspaceRoots(vscode.workspace.workspaceFolders||[]),storage=path.join((context.storageUri||context.globalStorageUri).fsPath,'java-workbench');
 const tasks=new BuildTasks({runner:runner||nativeTaskRunner(vscode),storagePath:storage,roots,tools:p=>({javaHome:p.jdk||java.getState().javaHome,gradleHome:config().get('gradleHome'),mavenHome:config().get('mavenHome')})});
 async function requestOnce(name,args,cancellation,operation){trusted();if(!ALLOWED.has(name))throw M.fail('Unsupported Java project command.');if(M.cancelled(cancellation))throw M.fail('Java project operation cancelled.');const explicit=operation?.kind==='explicit-project-configuration',timeout=explicit?Math.min(IMPORT_BUDGET_MS,operation.deadline-Date.now()):M.LIMITS.metadataMs,timeoutError=()=>M.fail(explicit?'Java project configuration exceeded its 180-second limit. Its job may still be running. Check Java output, then refresh project metadata instead of replaying import.':'Java project metadata timed out. Wait for import to finish and refresh again.');if(timeout<=0)throw timeoutError();const source=new vscode.CancellationTokenSource();let sub,timer,rejectCancelled;const interrupted=new Promise((_,reject)=>{rejectCancelled=reject;}),cancel=()=>{source.cancel();rejectCancelled(M.fail(explicit?'Java project configuration wait cancelled. Its job may still be running; inspect Java output and refresh metadata instead of replaying import.':'Java project operation cancelled.'));};if(cancellation?.onCancellationRequested)sub=cancellation.onCancellationRequested(cancel);else if(cancellation?.addEventListener){cancellation.addEventListener('abort',cancel,{once:true});sub={dispose:()=>cancellation.removeEventListener('abort',cancel)};}try{return await Promise.race([java.requestWorkspaceCommand?java.requestWorkspaceCommand(name,args,source.token):java.executeWorkspaceCommand(name,...args),interrupted,new Promise((_,reject)=>{timer=setTimeout(()=>{source.cancel();reject(timeoutError());},timeout);})]);}finally{clearTimeout(timer);sub?.dispose();source.dispose();}}

 async function request(name,args,cancellation,operation){for(;;){try{return await requestOnce(name,args,cancellation,operation);}catch(error){if(operation?.kind!=='explicit-project-configuration'||name!=='java.project.getSettings'||error?.code!==-32001||!/^Path must include project and resource name: \/[^/\r\n]{1,255}$/.test(error.message||''))throw error;await new Promise(resolve=>setTimeout(resolve,200));}}}
 const configurations=()=>{const values=context.workspaceState.get(CONFIG_KEY,[]);if(!Array.isArray(values)||values.length>M.LIMITS.configurations)throw M.fail('Saved Java run configurations exceed their supported bound.');return values.filter(v=>v?.format==='RocketbrainJavaRunConfiguration'&&v.formatVersion===1&&typeof v.id==='string');};
 const runtimeReview=createRuntimeReview(vscode,{trusted,java,ensureProject,request,config,save:saveRunConfiguration,
   getConfiguration:id=>configurations().find(item=>item.id===id)});
 function project(value){let real;try{real=fs.realpathSync(M.local(value));}catch{}const found=snapshot.projects.find(p=>p.id===value||p.uri===value||p.root===value||real&&path.relative(p.root,real)==='');if(!found)throw M.fail('Choose a currently observed Java project. Refresh the Java Projects view first.');if(M.workspacePath(found.root,roots())!==found.root)throw M.fail('The project path changed after observation.');return found;}
 function node(kind, value, children = []) {
  const record = { ...value, kind, children };
  nodes.set(record.id, record);
  for (const child of children) child.parentId = record.id;
  return record;
 }
 function rebuild() {
  nodes = new Map();
  return snapshot.projects.map(project => {
   const { id: projectId } = project;
   const sources = project.sourceRoots.map(source => node('source', { ...source, projectId },
    source.packages.map(pkg => node('package', { ...pkg, projectId },
     pkg.files.map(file => node('file', { ...file, projectId }))))));
   const outputs = project.outputRoots.map(item => node('output', { ...item, projectId,
    id: M.id('output', [projectId, item.path]), name: path.relative(project.root, item.path) || '.' }));
   const libraries = project.libraries.map(library => node('library', { ...library, pathKind: library.kind, projectId }));
   const taskNodes = tasks.list(project).map(task => node('task', { ...task, projectId }));
   const runs = configurations().filter(config => config.projectUri === project.uri)
    .map(config => node('configuration', { ...publicConfiguration(config), projectId }));
   return node('project', project, [
    node('group', { id: projectId + ':sources', name: 'Source roots' }, sources),
    node('group', { id: projectId + ':outputs', name: 'Build outputs' }, outputs),
    node('group', { id: projectId + ':libraries', name: 'Dependencies · ' + libraries.length }, libraries),
    node('group', { id: projectId + ':tasks', name: 'Build tasks · ' + taskNodes.length }, taskNodes),
    node('group', { id: projectId + ':runs', name: 'Run configurations · ' + runs.length }, runs)
   ]);
  });
 }
 let configWrites=Promise.resolve();
 const serialConfigWrite=action=>{
  const result=configWrites.then(action);
  configWrites=result.catch(()=>{});
  return result;
 };
 function publicConfiguration(value){
  const {springSecretId,environmentSecretId,...summary}=value;
  return summary;
 }
 function runEnvironmentKey(value){return SECRET_PREFIX+(value.environmentSecretId||value.id);}
 async function readRunEnvironment(value){
  if(!value)return {};
  const raw=await context.secrets.get(runEnvironmentKey(value));
  if(value.environmentSecretId&&raw===undefined)throw M.fail('The saved run environment is unavailable. Review the configuration.');
  let parsed;
  try{parsed=JSON.parse(raw||'{}');}
  catch{throw M.fail('The saved run environment is unavailable. Review the configuration.');}
  return M.environment(parsed);
 }
 async function readSpringSettings(value){
  if(!value?.springBoot)return null;
  if(!value.springBoot.properties?.length)return Spring.restoreSpringLaunch(value.springBoot,[]);
  let values;
  try{values=JSON.parse(await context.secrets.get(SPRING_SECRET_PREFIX+value.springSecretId));}
  catch{throw M.fail('The saved Spring launch values are unavailable. Review the configuration and enter the values again.');}
  return Spring.restoreSpringLaunch(value.springBoot,values);
 }
 let treeRoots=[];const refreshTree=()=>{treeRoots=rebuild();changed.fire(undefined);};
 const contexts = { project: 'rocketbrainJavaProject', source: 'rocketbrainJavaSourceRoot', package: 'rocketbrainJavaPackage',
  file: 'rocketbrainJavaFile', library: 'rocketbrainJavaLibrary', output: 'rocketbrainJavaBuildOutput', task: 'rocketbrainJavaBuildTask',
  configuration: 'rocketbrainJavaRunConfiguration' };
 const provider = {
  onDidChangeTreeData: changed.event,
  getChildren: item => item ? nodes.get(item.id)?.children || [] : treeRoots,
  getParent: item => nodes.get(nodes.get(item.id)?.parentId),
  getTreeItem(element) {
   const item = nodes.get(element.id);
   if (!item) throw M.fail('This Java tree item expired.');
   const result = new vscode.TreeItem(item.name || item.path, item.children.length
    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
   result.id = item.id;
   result.contextValue = contexts[item.kind] || 'rocketbrainJavaGroup';
   result.tooltip = item.path || item.uri || item.description || item.mainClass || item.name;
   if (item.kind === 'project') result.description = [item.tool, item.compliance && 'Java ' + item.compliance,
    item.languages?.includes('kotlin') && 'Kotlin', item.languages?.includes('groovy') && 'Groovy'].filter(Boolean).join(' · ');
   if (item.kind === 'task') result.description = item.buildName ? item.buildName + ' · ' + item.group : item.group;
   if (item.kind === 'configuration') result.description = (item.springBoot ? 'Spring Boot · ' : '') + item.mainClass;
   if (item.kind === 'source') {
    result.description = item.unavailable ? 'Unavailable source path' :
     [item.scope !== 'unspecified' && item.scope, item.generated && 'generated'].filter(Boolean).join(' · ');
    if (item.outputPath) result.tooltip = item.path + '\nBuild output · ' + item.outputPath;
   }
   if (item.kind === 'library') {
    result.description = item.projectDependency ? 'Project · ' + item.projectDependency.name :
     item.unavailable ? 'Unavailable metadata' : item.pathKind === 'modulepath' ? 'Module path' : 'Library';
    if (item.projectDependency) result.command = { command: 'rocketbrain.java.workbench.revealProjectDependency',
     title: 'Reveal Dependent Java Project', arguments: [item.id] };
   }
   if (item.kind === 'output') {
    result.description = [item.default && 'default', ...item.scopes, !item.exists && 'not built'].filter(Boolean).join(' · ');
    if (item.exists) result.command = { command: 'rocketbrain.java.workbench.revealBuildOutput',
     title: 'Reveal Java Build Output', arguments: [item.id] };
   }
   if (item.kind === 'file') {
    result.resourceUri = vscode.Uri.parse(item.uri);
    result.command = { command: COMMANDS.at(-1), title: 'Open Java source', arguments: [item.id] };
   }
   return result;
  }
 };
 const tree=vscode.window.createTreeView('rocketbrain.javaProjects',{treeDataProvider:provider,showCollapseAll:true});subscriptions.push(tree);
 async function refresh(options={},operation){trusted();const key=operation||null;if(refreshing.has(key))return refreshing.get(key);const ticket=generation,pending=(async()=>{const next=await M.collectProjects({request:(name,args,cancellation)=>request(name,args,cancellation,operation),folders:vscode.workspace.workspaceFolders||[],cancellation:options.cancellation});trusted();if(ticket!==generation)throw M.fail('Workspace folders changed during Java project refresh.');snapshot=next;refreshTree();return getSnapshot();})().finally(()=>refreshing.delete(key));refreshing.set(key,pending);return pending;}

 function getSnapshot(){return structuredClone({...snapshot,limits:{...snapshot.limits,importMs:IMPORT_BUDGET_MS},configurations:configurations().map(publicConfiguration),runs:[...active.values()].map(r=>({runId:r.runId,configurationId:r.configurationId,sessionId:r.session.id,state:r.state,debug:r.debug})),taskRunning:tasks.running});}
 async function ensureProject(value){if(!snapshot.projects.length)await refresh();return project(value);}
 async function resyncProject(options){trusted();if(options?.allowProjectExecution!==true)throw M.fail('Choose explicit project import/update before executing build configuration.');if(busy||tasks.running)throw M.fail('Finish the current managed Java operation first.');const operation={kind:'explicit-project-configuration',deadline:Date.now()+IMPORT_BUDGET_MS},root=M.workspacePath(options.projectUri,roots()),uri=pathToFileURL(root).href,current=await request('java.project.getAll',[],options.cancellation,operation),known=current.some(value=>{try{return path.relative(fs.realpathSync(M.local(String(value))),root)==='';}catch{return false;}});const configuration=known?null:['pom.xml','build.gradle','build.gradle.kts','.project'].map(name=>path.join(root,name)).find(file=>fs.existsSync(file));if(!known&&!configuration)throw M.fail('Choose a Maven, Gradle or Eclipse project with an observed local build configuration.');if(configuration)M.workspacePath(configuration,roots(),{directory:false});await request('java.project.changeImportedProjects',[known?[]:[pathToFileURL(configuration).href],known?[uri]:[],[]],options.cancellation,operation);if(!known){for(;;){const observed=await request('java.project.getAll',[],options.cancellation,operation);if(Array.isArray(observed)&&observed.some(value=>{try{return path.relative(fs.realpathSync(M.local(String(value))),root)==='';}catch{return false;}}))break;await new Promise(resolve=>setTimeout(resolve,200));}}return refresh({cancellation:options.cancellation},operation);}
 async function discoverTasks(options){trusted();const p=await ensureProject(options.projectUri||options.projectId);const value=await tasks.discover(p,options);trusted();refreshTree();return value;}
 async function runTask(options){trusted();const p=await ensureProject(options.projectUri||options.projectId),value=await tasks.run(p,options.taskId,options);refreshTree();return value;}
 async function mainClasses(options){const p=await ensureProject(options.projectUri||options.projectId),raw=await request('vscode.java.resolveMainClass',[p.uri],options.cancellation);if(!Array.isArray(raw)||raw.length>100)throw M.fail('Select a project with at most 100 observed Java main classes.');return raw.filter(v=>typeof v.mainClass==='string'&&/^(?:[\p{L}_$][\p{L}\p{N}_$]*\.)*[\p{L}_$][\p{L}\p{N}_$]*$/u.test(v.mainClass)&&typeof v.projectName==='string').map(v=>({mainClass:v.mainClass,projectName:v.projectName}));}
 function saveRunConfiguration(options, verifyReview){
  return serialConfigWrite(async()=>{
   trusted();
   const p=await ensureProject(options.projectUri||options.projectId);
   const mains=await mainClasses({projectUri:p.uri,cancellation:options.cancellation});
   const main=mains.find(m=>m.mainClass===options.mainClass&&(!options.projectName||m.projectName===options.projectName));
   if(!main)throw M.fail('Choose a Java main class observed by the current engine.');
   const existing=configurations(),old=options.configurationId&&existing.find(c=>c.id===options.configurationId);
   if(options.configurationId&&!old)throw M.fail('This run configuration no longer exists.');
   if(!old&&existing.length>=M.LIMITS.configurations)throw M.fail('Store at most 30 Java run configurations.');
   if(typeof options.name!=='string'||!options.name.trim()||options.name.length>120||/[\r\n\0]/.test(options.name))
    throw M.fail('Give the run configuration a short name.');
   const args=M.argumentsList(options.args),vmArgs=M.argumentsList(options.vmArgs);
   if(vmArgs.some(value=>/^(?:-cp|-classpath|--class-path|-jar|--module-path|-p|@|-agentlib:jdwp|-Xrunjdwp)/i.test(value)))
    throw M.fail('The managed run owns classpaths and the debugger agent.');
   const jdk=options.javaHome||p.jdk||java.getState().javaHome;
   const allowed=[p.jdk,java.getState().javaHome,...(config().get('projectJdks',[])||[]).map(j=>j.path)].filter(Boolean).map(v=>fs.realpathSync(v));
   if(!jdk||!allowed.some(value=>path.relative(value,fs.realpathSync(jdk))===''))throw M.fail('Choose an observed or configured independent JDK.');
   const javaExec=independentJavaExecutable(path.join(jdk,'bin',process.platform==='win32'?'java.exe':'java'));
   let prelaunch=null;
   if(options.prelaunchTaskId){
    const task=tasks.list(p).find(t=>t.id===options.prelaunchTaskId);
    if(!task)throw M.fail('Choose a currently observed prelaunch build task.');
    prelaunch={tool:task.tool,name:task.name};
   }else if(old&&options.prelaunchTaskId===undefined)prelaunch=old.prelaunch;
   const id=old?.id||crypto.randomUUID(),environmentSecretId=options.env===undefined?old?.environmentSecretId:crypto.randomUUID();
   const env=options.env===undefined?await readRunEnvironment(old):M.environment(options.env);
   const changedSpring=options.springBoot!==undefined;
   const spring=changedSpring?(options.springBoot===null?null:Spring.springLaunchOptions(options.springBoot)):await readSpringSettings(old);
   if(spring)Spring.projectSpringLaunch({args,vmArgs,env},spring);
   const nextSpringSecret=spring?.properties.length?(changedSpring?crypto.randomUUID():old.springSecretId):undefined;
   const value={format:'RocketbrainJavaRunConfiguration',formatVersion:1,id,name:options.name.trim(),projectUri:p.uri,
    mainClass:main.mainClass,projectName:main.projectName,javaHome:path.dirname(path.dirname(javaExec)),args,vmArgs,prelaunch,
    environmentKeys:Object.keys(env),...(environmentSecretId?{environmentSecretId}:{}),
    ...(spring?{springBoot:Spring.describeSpringLaunch(spring)}:{}),...(nextSpringSecret?{springSecretId:nextSpringSecret}:{})};
   let springStored=false,environmentStored=false;
   try{
    if(changedSpring&&nextSpringSecret){
     await context.secrets.store(SPRING_SECRET_PREFIX+nextSpringSecret,JSON.stringify(spring.properties.map(property=>property.value)));
     springStored=true;
    }
    if(options.env!==undefined){
     await context.secrets.store(runEnvironmentKey(value),JSON.stringify(env));
     environmentStored=true;
    }
    if(verifyReview)await verifyReview();
    trusted();
    await context.workspaceState.update(CONFIG_KEY,[...existing.filter(c=>c.id!==id),value]);
   }catch(error){
    if(springStored)await context.secrets.delete(SPRING_SECRET_PREFIX+nextSpringSecret).catch(()=>{});
    if(environmentStored)await context.secrets.delete(runEnvironmentKey(value)).catch(()=>{});
    throw error;
   }
   if(old&&runEnvironmentKey(old)!==runEnvironmentKey(value))
    await context.secrets.delete(runEnvironmentKey(old)).catch(()=>{});
   if(old?.springSecretId&&old.springSecretId!==nextSpringSecret)
    await context.secrets.delete(SPRING_SECRET_PREFIX+old.springSecretId).catch(()=>{});
   refreshTree();
   return structuredClone(publicConfiguration(value));
  });
 }

 function deleteRunConfiguration(configurationId){
  return serialConfigWrite(async()=>{
   trusted();
   const values=configurations(),saved=values.find(value=>value.id===configurationId);
   if(!saved)throw M.fail('This run configuration no longer exists.');
   await context.workspaceState.update(CONFIG_KEY,values.filter(value=>value.id!==configurationId));
   refreshTree();
   const keys=[runEnvironmentKey(saved),...(saved.springSecretId?[SPRING_SECRET_PREFIX+saved.springSecretId]:[])];
   const results=await Promise.allSettled(keys.map(key=>context.secrets.delete(key)));
   if(results.some(result=>result.status==='rejected'))throw M.fail('The configuration was removed. Some private values could not be deleted.');
  });
 }

 let compound;
 async function startRunGroup({ configurations: selected, cancellation }={}) {
  trusted();
  if (compound || busy || tasks.running || active.size) throw M.fail('Finish the current managed run or build before starting a run group.');
  if (!Array.isArray(selected) || selected.length<2 || selected.length>4 ||
      selected.some(entry=>typeof entry?.configurationId!=='string'||
        entry.debug!==undefined&&typeof entry.debug!=='boolean') ||
      new Set(selected.map(entry=>entry.configurationId)).size!==selected.length) {
   throw M.fail('Choose two to four distinct saved run configurations.');
  }
  const saved=configurations();
  const planned=selected.map(({ configurationId, debug })=>{
   const configured=saved.find(entry=>entry.id===configurationId);
   if (!configured) throw M.fail('Every group member must be a saved Java run configuration.');
   return { configurationId, debug:debug===true, fingerprint:JSON.stringify(configured) };
  });
  const group={id:crypto.randomUUID(),ticket:launchGeneration};
  compound=group;
  const runs=[];
  try {
   for (const { configurationId,debug,fingerprint } of planned) {
    trusted();
    if (group.ticket!==launchGeneration||M.cancelled(cancellation)) throw M.fail('The managed run group was stopped.');
    if (JSON.stringify(configurations().find(entry=>entry.id===configurationId))!==fingerprint) {
     throw M.fail('A run configuration changed during group startup.');
    }
    runs.push(await start({ configurationId,debug,cancellation },group));
   }
   return { groupId:group.id,state:'started',runs };
  } catch (error) {
   const started=runs.map(run=>active.get(run.runId)).filter(Boolean);
   const stopped=await Promise.allSettled(started.map(run=>vscode.debug.stopDebugging(run.session)));
   if (stopped.some(result=>result.status==='rejected')) {
    throw M.fail(error.message+' Some owned sessions could not be stopped. Use the managed Stop command.');
   }
   throw error;
  } finally {
   compound=undefined;
   refreshTree();
  }
 }

 async function start(options,group){trusted();if(busy||tasks.running||compound!==group||active.size&&!group)throw M.fail('Stop the current managed run/build before starting another.');const saved=configurations().find(v=>v.id===options.configurationId);if(!saved)throw M.fail('Choose a saved Java run configuration.');const ticket=generation,launchTicket=launchGeneration;let pendingRunId;busy=true;try{const p=await ensureProject(saved.projectUri);if(vscode.workspace.textDocuments.some(d=>d.languageId==='java'&&d.isDirty))throw M.fail('Save modified Java sources before managed build/run.');if(saved.prelaunch){let list=tasks.list(p);if(!list.some(t=>t.name===saved.prelaunch.name))list=await tasks.discover(p,{allowProjectExecution:true,cancellation:options.cancellation});const task=list.find(t=>t.name===saved.prelaunch.name&&t.tool===saved.prelaunch.tool);if(!task)throw M.fail('The saved prelaunch task is no longer available.');const built=await tasks.run(p,task.id,{allowProjectExecution:true,cancellation:options.cancellation});if(built.state!=='succeeded')throw M.fail('The prelaunch build failed or was cancelled; no application was started.');}trusted();if(ticket!==generation||launchTicket!==launchGeneration||M.cancelled(options.cancellation))throw M.fail('Managed Java startup was cancelled or the workspace changed.');const main=(await mainClasses({projectUri:p.uri})).find(m=>m.mainClass===saved.mainClass&&m.projectName===saved.projectName);if(!main)throw M.fail('The saved main class changed. Review the run configuration.');trusted();if(ticket!==generation||launchTicket!==launchGeneration)throw M.fail('Managed startup context changed.');const env=await readRunEnvironment(saved);const spring=await readSpringSettings(saved);if(spring)Spring.projectSpringLaunch({args:saved.args,vmArgs:saved.vmArgs,env},spring);trusted();if(ticket!==generation||launchTicket!==launchGeneration||M.cancelled(options.cancellation)||JSON.stringify(configurations().find(value=>value.id===saved.id))!==JSON.stringify(saved))throw M.fail('Managed startup or saved configuration changed.');const runId=crypto.randomUUID(),debug=options.debug===true,launch={type:'rocketbrain-java',request:'launch',name:saved.name,mainClass:saved.mainClass,projectName:saved.projectName,javaExec:independentJavaExecutable(path.join(saved.javaHome,'bin',process.platform==='win32'?'java.exe':'java')),args:saved.args,vmArgs:saved.vmArgs,env,cwd:p.root,sourcePaths:p.sourceRoots.filter(s=>!s.unavailable).map(s=>s.path),[RUN_MARKER]:runId,...(spring?{[Spring.springMarker]:true}:{}),noDebug:!debug};let resolve;const begun=new Promise(r=>{resolve=r;});pendingRunId=runId;pendingStarts.set(runId,{resolve,configurationId:saved.id,debug,cancelled:false});if(spring)Spring.retainSpringLaunch(runId,spring);const ok=await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(p.uri)),launch,{noDebug:!debug});if(!ok){pendingStarts.delete(runId);throw M.fail('The managed Java launch did not start. Check Java output.');}let timer;try{const record=await Promise.race([begun,new Promise((_,reject)=>{timer=setTimeout(()=>reject(M.fail('The Java launch has not reported its owned session.')),10000);})]);if(record.cancelled||launchTicket!==launchGeneration||disposed){await vscode.debug.stopDebugging(record.session);throw M.fail('The managed launch was stopped during startup.');}return{runId,configurationId:saved.id,sessionId:record.session.id,state:record.state,debug};}finally{clearTimeout(timer);pendingStarts.delete(runId);}}finally{if(pendingRunId){Spring.discardSpringLaunch(pendingRunId);pendingStarts.delete(pendingRunId);}busy=false;refreshTree();}}
 async function stop(options={}){if(options.runId&&!active.has(options.runId))throw M.fail('Choose a run owned by Java Projects.');launchGeneration++;for(const [id,p] of pendingStarts){p.cancelled=true;Spring.discardSpringLaunch(id);}await tasks.stop();const runs=options.runId?[active.get(options.runId)]:[...active.values()];await Promise.all(runs.map(r=>vscode.debug.stopDebugging(r.session)));return{stopped:runs.length,taskRunning:tasks.running};}
 subscriptions.push(vscode.debug.onDidStartDebugSession(session=>{const runId=session.configuration?.[RUN_MARKER],pending=pendingStarts.get(runId);if(session.type!=='rocketbrain-java'||!pending)return;const record={runId,session,configurationId:pending.configurationId,debug:pending.debug,state:'running',cancelled:pending.cancelled||disposed};active.set(runId,record);pending.resolve(record);refreshTree();}),vscode.debug.onDidTerminateDebugSession(session=>{for(const [id,r]of active)if(r.session===session){active.delete(id);refreshTree();}}));
 async function chooseProject(arg){if(arg?.projectUri||arg?.projectId)return project(arg.projectUri||arg.projectId);const nodeValue=typeof arg==='string'?nodes.get(arg):arg?.id&&nodes.get(arg.id);if(nodeValue)return project(nodeValue.projectId||nodeValue.id);if(!snapshot.projects.length)await refresh();const chosen=await vscode.window.showQuickPick(snapshot.projects.map(p=>({label:p.name,description:p.tool,project:p})),{title:'Java Projects · Select project'});return chosen?.project;}
 async function chooseConfiguration(arg){const value=typeof arg==='string'?arg:arg?.id;if(value&&configurations().some(c=>c.id===value))return value;const chosen=await vscode.window.showQuickPick(configurations().map(c=>({label:c.name,description:c.mainClass,id:c.id})),{title:'Java Projects · Select run configuration'});return chosen?.id;}
 async function chooseRunGroup(){
  const selected=await vscode.window.showQuickPick(configurations().map(entry=>({
   label:entry.name,description:entry.mainClass,configurationId:entry.id
  })),{title:'Run two to four saved configurations in listed order',canPickMany:true});
  return selected&&startRunGroup({configurations:selected});
 }
 const sharedRuns=registerSharedRuns(vscode,{
  trusted, generation:()=>generation, roots, getConfiguration:id=>configurations().find(value=>value.id===id),
  findProject:ensureProject,
  async checkTarget(project, blueprint){
   const matches=(await mainClasses({projectUri:project.uri})).filter(value=>value.mainClass===blueprint.mainClass);
   if(matches.length!==1)throw M.fail('Choose a shared run with one observed local main class.');
   const before=blueprint.prelaunch;
   const task=before&&tasks.list(project).find(entry=>entry.tool===before.tool&&entry.name===before.name);
   if(before&&!task)throw M.fail('Discover the shared run’s saved build task in Java Projects first.');
   return {projectName:matches[0].projectName,prelaunchTaskId:task?.id??null};
  },
  save:saveRunConfiguration
 });
 async function configureRun(arg,forSpring=false) {
  const p=await chooseProject(arg);
  if(!p)return;
  const mains=await mainClasses({projectUri:p.uri});
  const picked=await vscode.window.showQuickPick(mains.map(main=>({label:main.mainClass,description:main.projectName,main})),{title:'Java Projects · Main class'});
  if(!picked)return;
  const name=await vscode.window.showInputBox({title:'Run configuration name',value:picked.main.mainClass.split('.').at(-1)});
  if(name===undefined)return;
  const args=await vscode.window.showInputBox({title:'Program arguments',prompt:'Use quotes to keep spaces inside one argument',value:''});
  if(args===undefined)return;
  const jdk=await runtimeReview.choose(p);
  if(!jdk)return;
  const before=await vscode.window.showQuickPick([{label:'JDT incremental build',id:null},...tasks.list(p).map(t=>({label:t.name,description:t.tool,id:t.id}))],{title:'Prelaunch build'});
  if(!before)return;
  const env={};
  for(let i=0;i<M.LIMITS.environment;i++){
   const key=await vscode.window.showInputBox({title:'Environment variable (optional)',prompt:'Leave empty to save. Values go into VS Code Secret Storage.',value:''});
   if(key===undefined)return;
   if(!key)break;
   const value=await vscode.window.showInputBox({title:'Value for '+key,password:true});
   if(value===undefined)return;
   env[key]=value;
  }
  const springBoot=forSpring?await chooseSpringLaunch(vscode.window,trusted):undefined;
  if(forSpring&&!springBoot)return;
  return saveRunConfiguration({projectUri:p.uri,name,mainClass:picked.main.mainClass,projectName:picked.main.projectName,args:M.splitArguments(args),
   vmArgs:jdk.vmArgs,javaHome:jdk.choice.home,prelaunchTaskId:before.id,env,springBoot},()=>runtimeReview.verify(jdk.report,jdk.choice.home,jdk.enablePreview));
 }
 async function changeRuntime(arg) {
  const configurationId=await chooseConfiguration(arg);
  if(!configurationId)return;
  const saved=configurations().find(item=>item.id===configurationId);
  if(!saved)throw M.fail('Choose a saved Java run configuration.');
  const selected=await runtimeReview.choose(await ensureProject(saved.projectUri));
  return selected&&runtimeReview.apply(selected.report,{configurationId,home:selected.choice.home,enablePreview:selected.enablePreview});
 }
 async function revealProjectDependency(value) {
  trusted();
  const item = nodes.get(typeof value === 'string' ? value : value?.id);
  if (!item?.projectDependency) throw M.fail('Choose a current Java project dependency.');
  const target = project(item.projectDependency.id);
  if (!observedOutput(item.projectDependency.output, target.root)) throw M.fail('The Java project output changed. Refresh the Java Projects view.');
  await tree.reveal(nodes.get(target.id), { select: true, focus: true, expand: 1 });
  return { projectId: target.id, projectName: target.name };
 }
 async function revealBuildOutput(value) {
  trusted();
  const item = nodes.get(typeof value === 'string' ? value : value?.id);
  if (item?.kind !== 'output') throw M.fail('Choose a current Java build output.');
  const target = project(item.projectId);
  if (!observedOutput(item.path, target.root)?.exists) throw M.fail('Build the Java project and refresh the Java Projects view first.');
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(item.path));
  return { path: item.path };
 }
 const handlers={revealProjectDependency,revealBuildOutput,refresh:()=>refresh(),resync:async a=>{const p=await chooseProject(a);return p&&resyncProject({projectUri:p.uri,allowProjectExecution:true});},tasks:async a=>{const p=await chooseProject(a);return p&&discoverTasks({projectUri:p.uri,allowProjectExecution:true});},runTask:async a=>{const p=await chooseProject(a);if(!p)return;let list=tasks.list(p);if(!list.length)list=await discoverTasks({projectUri:p.uri,allowProjectExecution:true});const chosen=await vscode.window.showQuickPick(list.map(t=>({label:t.name,description:t.group,task:t})),{title:'Run build task'});return chosen&&runTask({projectUri:p.uri,taskId:chosen.task.id,allowProjectExecution:true});},build:async a=>{const p=await chooseProject(a);if(!p)return;if(p.tool==='java')return java.buildWorkspace();let list=tasks.list(p);if(!list.length)list=await discoverTasks({projectUri:p.uri,allowProjectExecution:true});const target=list.find(t=>t.name===(p.tool==='maven'?'compile':':classes')||p.tool==='gradle'&&t.name==='classes');if(!target)throw M.fail('Select the appropriate build task for this project.');return runTask({projectUri:p.uri,taskId:target.id,allowProjectExecution:true});},configureRun,configureSpringRun:a=>configureRun(a,true),exportSharedRun:async a=>sharedRuns.exportCommand(await chooseConfiguration(a)),importSharedRun:()=>sharedRuns.importCommand(),startRunGroup:chooseRunGroup,run:async a=>{const configurationId=await chooseConfiguration(a);return configurationId&&start({configurationId,debug:false});},debug:async a=>{const configurationId=await chooseConfiguration(a);return configurationId&&start({configurationId,debug:true});},stop:()=>stop(),deleteRunConfiguration:async a=>{const id=await chooseConfiguration(a);return id&&deleteRunConfiguration(id);},openSource:async a=>{trusted();const n=nodes.get(typeof a==='string'?a:a?.id);if(n?.kind!=='file')throw M.fail('Choose a current Java source file.');M.workspacePath(n.path,roots(),{directory:false});return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(n.uri)));}};
 handlers.reviewRuntimes=async arg=>{const p=await chooseProject(arg);return p&&runtimeReview.show(p);};
 handlers.changeRuntime=changeRuntime;
 for(const [name,handler]of Object.entries(handlers))subscriptions.push(vscode.commands.registerCommand('rocketbrain.java.workbench.'+name,arg=>track(async()=>{try{trusted();return await handler(arg);}catch(error){output.appendLine('Java Projects: '+error.message);await vscode.window.showErrorMessage('Rocketbrain Java Projects: '+error.message);return null;}})));
 if(vscode.workspace.onDidChangeWorkspaceFolders)subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{generation++;sharedRuns.clear();snapshot={...snapshot,projects:[]};tasks.catalog.clear();refreshTree();void stop().catch(()=>{});}));
 const mixed=registerMixedJvmWorkbench(vscode,{trusted,java,ensureProject,getProjects:()=>snapshot.projects,
   refreshProjects:()=>refresh(),discoverTasks,runTask,track});
 subscriptions.push(mixed);
 refreshTree();let disposing;return{mixedJvm:{buildAndIndex:options=>track(()=>mixed.buildAndIndex(options)),definition:options=>track(()=>mixed.definition(options)),run:options=>track(()=>mixed.run(options))},refresh:options=>track(()=>refresh(options)),getSnapshot,mainClasses,resyncProject:options=>track(()=>resyncProject(options)),discoverTasks:options=>track(()=>discoverTasks(options)),runTask:options=>track(()=>runTask(options)),saveRunConfiguration:options=>track(()=>saveRunConfiguration(options)),reviewModuleRuntimes:options=>track(()=>runtimeReview.inspect(options)),applyRuntimeChoice:(report,options)=>track(()=>runtimeReview.apply(report,options)),exportSharedRun:options=>track(()=>sharedRuns.exportSharedRun(options)),reviewSharedRun:options=>track(()=>sharedRuns.reviewSharedRun(options)),applySharedRun:options=>track(()=>sharedRuns.applySharedRun(options)),listRunConfigurations:()=>structuredClone(configurations().map(publicConfiguration)),deleteRunConfiguration:id=>track(()=>deleteRunConfiguration(id)),start:options=>track(()=>start(options)),startRunGroup:options=>track(()=>startRunGroup(options)),stop:options=>track(()=>stop(options)),getTreeChildren:id=>structuredClone(id?nodes.get(id)?.children||[]:treeRoots),async dispose(){if(disposing)return disposing;disposed=true;generation++;sharedRuns.clear();disposing=(async()=>{await stop();await tasks.dispose();await Promise.allSettled([...operations]);for(const s of subscriptions)s.dispose();})();return disposing;}};}
module.exports={registerJavaWorkbench,CONFIG_KEY,SECRET_PREFIX,RUN_MARKER,COMMANDS,IMPORT_BUDGET_MS};
