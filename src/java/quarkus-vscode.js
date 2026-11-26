'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout:delay } = require('node:timers/promises');
const { inspectQuarkusProject,quarkusProject,profileKey } = require('./quarkus-model');
const { profileFile } = require('./quarkus-config-mapping');
const { createQuarkusDev,fastJar } = require('./quarkus-dev');
const { createQuarkusProject } = require('./quarkus-create');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');
const { DEBUG_TYPE,processAttachTarget } = require('./debug');

const DEBUG_MARKER='__rocketbrainQuarkusOwnedLaunch';
const COMMANDS = Object.freeze({
  create:'rocketbrain.quarkus.create',
  inspect:'rocketbrain.quarkus.inspect', start:'rocketbrain.quarkus.startDev',
  stop:'rocketbrain.quarkus.stopDev', test:'rocketbrain.quarkus.runTests',
  build:'rocketbrain.quarkus.build', debug:'rocketbrain.quarkus.debug', debugDev:'rocketbrain.quarkus.debugDev'
});

function registerQuarkusWorkbench(vscode,java) {
  let disposed=false, closing, busy=false, generation=0, debugSession;
  const subscriptions=[], jobs=new Set(), pending=new Map();
  const output=vscode.window.createOutputChannel('Rocketbrain Quarkus');
  const dev=createQuarkusDev({log:chunk => output.append(chunk),
    resolveDescendant:(target,cancellation) => java.debug.processes.resolveDescendant(target,cancellation)});
  subscriptions.push(output);

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before using Quarkus tools.');
    if (cancelled(cancellation)) throw fail('Quarkus operation cancelled.');
  }

  function roots() { return workspaceRoots(vscode.workspace.workspaceFolders || []); }

  function available() {
    return java.workbench.getSnapshot().projects.filter(project => {
      try {
        workspacePath(project.root,roots());
        quarkusProject(project);
        return true;
      } catch { return false; }
    });
  }

  async function projectFor(projectUri,cancellation) {
    trusted(cancellation);
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh({cancellation});
    trusted(cancellation);
    const root=workspacePath(projectUri,roots());
    const project=available().find(item => !path.relative(item.root,root));
    if (!project) throw fail('Import the Maven or Gradle Quarkus project in Java Projects first.');
    return project;
  }

  async function inspect({projectUri,cancellation} = {}) {
    return inspectQuarkusProject(await projectFor(projectUri,cancellation),cancellation);
  }

  function saved(project) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
        inside(project.root,document.uri.fsPath))) throw fail('Save modified Quarkus project files before execution.');
  }

  function launch(project,{allowProjectExecution,cancellation},debug=false) {
    const config=vscode.workspace.getConfiguration('rocketbrain.java');
    trusted(cancellation);
    saved(project);
    return dev.start({project,javaHome:project.jdk || config.get('javaHome') || java.getState().javaHome,
      mavenHome:config.get('mavenHome'),gradleHome:config.get('gradleHome'),
      workspaceTrusted:vscode.workspace.isTrusted,allowProjectExecution,cancellation,debug});
  }

  async function exclusive(options,action,message) {
    if (options.allowProjectExecution!==true) throw fail(message);
    if (busy||dev.running||java.workbench.getSnapshot().taskRunning) throw fail('Finish the current Java task or stop the owned Quarkus application.');
    const ticket=generation;
    busy=true;
    try {
      const project=await projectFor(options.projectUri,options.cancellation);
      saved(project);
      function current() {
        trusted(options.cancellation);
        if (ticket!==generation) throw fail('The Quarkus operation was stopped.');
      }
      current();
      return await action(project,current);
    } finally { busy=false; }
  }

  async function task(project,action,options,current) {
    const taskName=project.tool==='gradle'?(action==='build'?':quarkusBuild':':test'):(action==='build'?'package':'test');
    const selection={projectUri:project.uri,allowProjectExecution:true,cancellation:options.cancellation};
    const observed=(await java.workbench.discoverTasks(selection)).find(item=>item.name===taskName);
    if (!observed) throw fail('The selected Quarkus project has no observed '+taskName+' task.');
    current();
    saved(project);
    const result=await java.workbench.runTask({...selection,taskId:observed.id});
    if (result.state!=='cancelled') current();
    return result;
  }

  const start=(options={})=>exclusive(options,project=>launch(project,options),'Explicitly choose Quarkus dev mode before executing the project.');
  const tests=(options={})=>exclusive(options,(project,current)=>task(project,'test',options,current),
    'Explicitly choose Quarkus tests before executing the project.');
  const build=(options={})=>exclusive(options,async(project,current)=>{
    const result=await task(project,'build',options,current);
    return result.state==='succeeded'?{...result,tool:project.tool,artifact:fastJar(project)}:result;
  },'Explicitly choose the Quarkus build before executing the project.');

  subscriptions.push(vscode.debug.onDidStartDebugSession(session=>{
    const record=pending.get(session.configuration?.[DEBUG_MARKER]);
    if (session.type!==DEBUG_TYPE||!record) return;
    record.session=session;
    record.resolve(session);
  }),vscode.debug.onDidTerminateDebugSession(session=>{
    if (debugSession?.id===session.id) debugSession=undefined;
    for (const record of pending.values()) if (record.session?.id===session.id) record.terminated=true;
  }));

  async function stop() {
    generation++;
    const owned=[debugSession,...Array.from(pending.values(),record=>record.session)].filter(Boolean);
    debugSession=undefined;
    let receipt;
    try { await Promise.allSettled([...new Set(owned)].map(session=>vscode.debug.stopDebugging(session))); }
    finally { receipt=await dev.stop(); }
    return receipt;
  }

  const startDebug=(options={},profile='prod')=>exclusive(options,async(project,current)=>{
    if (profile==='prod') {
      const result=await task(project,'build',options,current);
      if (result.state!=='succeeded') throw fail('The Quarkus fast-jar build did not succeed.');
    }
    const receipt=await launch(project,options,profile==='dev'?'development':true);
    const key=randomUUID(), record={};
    let timer;
    try {
      current();
      const candidate=await java.debug.processes.resolve(receipt.debug.pid,options.cancellation);
      const proof=await dev.verifyDebugTarget(options.cancellation);
      if (candidate.hostName!==proof.address||candidate.pid!==proof.pid||candidate.port!==proof.port)
        throw fail('The observed JDWP address differs from the owned Quarkus listener.');
      current();
      saved(project);
      const began=new Promise(resolve=>{record.resolve=resolve;});
      pending.set(key,record);
      const attached=await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(project.uri)),{
        type:DEBUG_TYPE,request:'attach',name:(profile==='dev'?'Rocketbrain Quarkus Dev ':'Rocketbrain Quarkus ')+project.name,
        ...processAttachTarget(candidate),[DEBUG_MARKER]:key,
        sourcePaths:project.sourceRoots.filter(item=>!item.unavailable).map(item=>item.path)
      },{suppressSaveBeforeStart:true});
      if (!attached) throw fail('Could not start the debugger for the owned Quarkus JVM.');
      const session=await Promise.race([began,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(fail('The owned Quarkus debugger session did not start.')),18000);
      })]);
      const deadline=Date.now()+22000;
      while (java.debug.verifiedLocalPid(session)!==candidate.pid) {
        current();
        if (record.terminated||Date.now()>=deadline) throw fail('The Java debugger did not acknowledge the owned Quarkus listener.');
        await delay(100);
      }
      current();
      debugSession=session;
      return {...receipt,sessionId:session.id};
    } catch(error) {
      if (record.session) await vscode.debug.stopDebugging(record.session).catch(()=>{});
      await dev.stop();
      throw error;
    } finally { clearTimeout(timer);pending.delete(key); }
  },'Explicitly choose Quarkus debugging before building and launching the project.');

  async function create({parent,name,allowProjectWrites,cancellation} = {}) {
    trusted(cancellation);
    return createQuarkusProject({parent:workspacePath(parent,roots()),name,allowProjectWrites,
      workspaceTrusted:vscode.workspace.isTrusted});
  }

  function sourceLocation(value) {
    const uri=vscode.Uri.parse(value.uri);
    if (uri.scheme!=='file' || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri)) {
      throw fail('Quarkus navigation targets must be local workspace files.');
    }
    workspacePath(uri.fsPath,roots(),{directory:false});
    const {start,end}=value.range || {start:{line:0,character:0},end:{line:0,character:0}};
    return new vscode.Location(uri,new vscode.Range(start.line,start.character,end.line,end.character));
  }

  function configurationAt(document,position,includePartial) {
    trusted();
    if (!document || document.uri.scheme!=='file' || document.uri.authority ||
        profileFile(path.basename(document.uri.fsPath))===null) return undefined;
    const project=available().find(item => !path.relative(document.uri.fsPath,
      path.join(item.root,'src/main/resources',path.basename(document.uri.fsPath))));
    if (!project) return undefined;
    const text=document.lineAt(position.line).text;
    const match=/^(\s*)((?:%[A-Za-z][A-Za-z0-9-]{0,45}\.)?)([A-Za-z0-9_.-]*)/.exec(text);
    if (!match || (text[match[0].length] && !/[ =:\t]/.test(text[match[0].length]))) return undefined;
    const start=match[1].length+match[2].length, end=match[0].length;
    if (position.character<start || position.character>end) return undefined;
    const key=includePartial ? match[3].slice(0,position.character-start) : profileKey(match[2]+match[3])?.key;
    const report=inspectQuarkusProject(project);
    return {key,report,range:new vscode.Range(position.line,start,position.line,end)};
  }

  const properties={scheme:'file',pattern:'**/src/main/resources/application*.properties'};
  subscriptions.push(vscode.languages.registerCompletionItemProvider(properties,{
    provideCompletionItems(document,position,cancellation) {
      try {
        if (cancelled(cancellation)) return undefined;
        const match=configurationAt(document,position,true);
        if (!match) return undefined;
        const items=[];
        for (const key of [...new Set(match.report.configuration.map(item => item.key))]) {
          if (!key.startsWith(match.key)) continue;
          const types=[...new Set(match.report.configuration.filter(item => item.key===key).map(item => item.type))];
          const item=new vscode.CompletionItem(key,vscode.CompletionItemKind.Property);
          item.detail='Quarkus · '+types.join(' / ');
          item.range=match.range;
          items.push(item);
        }
        return items;
      } catch { return undefined; }
    }
  },'.'),vscode.languages.registerDefinitionProvider(properties,{
    provideDefinition(document,position,cancellation) {
      try {
        if (cancelled(cancellation)) return undefined;
        const match=configurationAt(document,position,false);
        const sources=match?.report.configuration.filter(item => item.key===match.key);
        if (sources?.length===1) return sourceLocation(sources[0].source);
      } catch { return undefined; }
    }
  }));

  async function choose() {
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh();
    trusted();
    const active=vscode.window.activeTextEditor?.document.uri;
    const items=available().sort((a,b) => b.root.length-a.root.length);
    if (!items.length) throw fail('Import the Maven or Gradle Quarkus project in Java Projects first.');
    const selected=active?.scheme==='file' && items.find(item => inside(item.root,active.fsPath));
    if (selected) return selected.uri;
    return (await vscode.window.showQuickPick(items.map(item => ({label:item.name,uri:item.uri})),
      {title:'Select Quarkus Application'}))?.uri;
  }

  function track(action) {
    const request=Promise.resolve().then(action);
    jobs.add(request);
    void request.finally(() => jobs.delete(request)).catch(() => {});
    return request;
  }

  function register(id,action) {
    subscriptions.push(vscode.commands.registerCommand(id,() => track(async () => {
      try { trusted(); return await action(); }
      catch (error) { void vscode.window.showErrorMessage('Rocketbrain Quarkus: '+error.message); return undefined; }
    })));
  }

  function progress(title,action) {
    return vscode.window.withProgress({title,location:vscode.ProgressLocation.Notification,cancellable:true},
      (_progress,cancellation) => action(cancellation));
  }

  register(COMMANDS.create,async () => {
    const current=vscode.workspace.workspaceFolders?.[0]?.uri;
    const places=await vscode.window.showOpenDialog({defaultUri:current,canSelectFiles:false,canSelectFolders:true,
      canSelectMany:false,openLabel:'Select Project Parent'});
    if (!places?.length || places[0].scheme!=='file') return;
    const name=await vscode.window.showInputBox({title:'New Quarkus Maven Project',prompt:'Enter a new artifact and folder name.',
      validateInput:value => /^[a-z][a-z0-9-]{0,63}$/.test(value) ? undefined : 'Use lowercase letters, numbers and hyphens.'});
    if (!name) return;
    const result=await create({parent:places[0].fsPath,name,allowProjectWrites:true});
    await vscode.window.showTextDocument(vscode.Uri.file(result.pom),{preview:false});
    return result;
  });
  register(COMMANDS.inspect,async () => {
    const projectUri=await choose();
    if (!projectUri) return;
    const report=await inspect({projectUri});
    const selected=await vscode.window.showQuickPick([
      ...report.configuration.map(item => ({label:item.key,description:item.type,
        detail:item.groups?.join(' → '),source:item.source})),
      ...report.configured.map(item => ({label:(item.profile ? '%'+item.profile+'.' : '')+item.key,
        description:'application.properties',source:item})),
      ...report.endpoints.map(item => ({label:item.verb+' '+item.path,description:item.method,source:item.source})),
      ...report.templates.filter(item => item.uri).map(item => ({label:item.name,description:'Qute',source:{uri:item.uri}}))
    ],{title:'Quarkus Configuration, Endpoints and Templates'});
    if (!selected) return;
    const location=sourceLocation(selected.source);
    return vscode.window.showTextDocument(location.uri,{selection:location.range,preview:true});
  });
  register(COMMANDS.start,async () => {
    const projectUri=await choose();
    if (!projectUri) return;
    output.show(true);
    const session=await progress('Start Quarkus Dev Mode',cancellation => start({projectUri,allowProjectExecution:true,cancellation}));
    void vscode.window.showInformationMessage('Quarkus dev application is ready at '+session.baseUrl);
    return session;
  });
  register(COMMANDS.stop,stop);
  register(COMMANDS.test,async () => {
    const projectUri=await choose();
    return projectUri && progress('Run Quarkus Tests',cancellation => tests({projectUri,allowProjectExecution:true,cancellation}));
  });
  register(COMMANDS.build,async()=>{
    const projectUri=await choose();
    return projectUri&&progress('Build Quarkus Application',cancellation=>build({projectUri,allowProjectExecution:true,cancellation}));
  });
  register(COMMANDS.debug,async()=>{
    const projectUri=await choose();
    if (!projectUri) return;
    output.show(true);
    return progress('Debug Quarkus Application',cancellation=>startDebug({projectUri,allowProjectExecution:true,cancellation}));
  });
  register(COMMANDS.debugDev,async()=>{
    const projectUri=await choose();
    if (!projectUri) return;
    output.show(true);
    return progress('Debug Quarkus Dev Mode',
      cancellation=>startDebug({projectUri,allowProjectExecution:true,cancellation},'dev'));
  });

  return {
    create:options => track(() => create(options)),
    inspect:options => track(() => inspect(options)), startDev:options => track(() => start(options)),
    runTests:options => track(() => tests(options)),build:options=>track(()=>build(options)),
    debug:options=>track(()=>startDebug(options)),debugDev:options=>track(()=>startDebug(options,'dev')),stopDev:stop,
    dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try { await stop(); }
        finally {
          await Promise.allSettled(jobs);
          try { await dev.dispose(); }
          finally { for (const item of subscriptions) item.dispose(); }
        }
      })();
      return closing;
    }
  };
}

module.exports = { registerQuarkusWorkbench,COMMANDS };
