'use strict';

const path = require('node:path');
const { inspectQuarkusProject,quarkusMavenProject,profileKey } = require('./quarkus-model');
const { createQuarkusDev } = require('./quarkus-dev');
const { createQuarkusProject } = require('./quarkus-create');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');

const COMMANDS = Object.freeze({
  create:'rocketbrain.quarkus.create',
  inspect:'rocketbrain.quarkus.inspect', start:'rocketbrain.quarkus.startDev',
  stop:'rocketbrain.quarkus.stopDev', test:'rocketbrain.quarkus.runTests'
});

function registerQuarkusWorkbench(vscode,java) {
  let disposed=false, closing, testing=false;
  const subscriptions=[], jobs=new Set();
  const output=vscode.window.createOutputChannel('Rocketbrain Quarkus');
  const dev=createQuarkusDev({log:chunk => output.append(chunk)});
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
        quarkusMavenProject(project);
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
    if (!project) throw fail('Import the Maven Quarkus project in Java Projects first.');
    return project;
  }

  async function inspect({projectUri,cancellation} = {}) {
    return inspectQuarkusProject(await projectFor(projectUri,cancellation),cancellation);
  }

  function saved(project) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
        inside(project.root,document.uri.fsPath))) throw fail('Save modified Quarkus project files before executing Maven.');
  }

  async function start({projectUri,allowProjectExecution,cancellation} = {}) {
    if (allowProjectExecution!==true) throw fail('Explicitly choose Quarkus dev mode before executing Maven.');
    const project=await projectFor(projectUri,cancellation);
    saved(project);
    if (testing || java.workbench.getSnapshot().taskRunning) throw fail('Finish the current managed Java build before starting Quarkus dev mode.');
    const config=vscode.workspace.getConfiguration('rocketbrain.java');
    trusted(cancellation);
    return dev.start({project,javaHome:project.jdk || config.get('javaHome') || java.getState().javaHome,
      mavenHome:config.get('mavenHome'),workspaceTrusted:vscode.workspace.isTrusted,allowProjectExecution,cancellation});
  }

  async function tests({projectUri,allowProjectExecution,cancellation} = {}) {
    if (allowProjectExecution!==true) throw fail('Explicitly choose Quarkus tests before executing Maven.');
    if (testing || dev.running) throw fail('Finish Quarkus tests or stop the owned dev session before running tests.');
    testing=true;
    try {
      const project=await projectFor(projectUri,cancellation);
      saved(project);
      const options={projectUri:project.uri,allowProjectExecution,cancellation};
      const task=(await java.workbench.discoverTasks(options)).find(item => item.name==='test');
      if (!task) throw fail('The Quarkus project has no observed Maven test task.');
      trusted(cancellation);
      saved(project);
      return await java.workbench.runTask({...options,taskId:task.id});
    } finally { testing=false; }
  }

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
        path.basename(document.uri.fsPath)!=='application.properties') return undefined;
    const project=available().find(item => !path.relative(document.uri.fsPath,
      path.join(item.root,'src/main/resources/application.properties')));
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

  const properties={scheme:'file',pattern:'**/src/main/resources/application.properties'};
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
    if (!items.length) throw fail('Import the Maven Quarkus project in Java Projects first.');
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
      ...report.configuration.map(item => ({label:item.key,description:item.type,source:item.source})),
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
  register(COMMANDS.stop,() => dev.stop());
  register(COMMANDS.test,async () => {
    const projectUri=await choose();
    return projectUri && progress('Run Quarkus Tests',cancellation => tests({projectUri,allowProjectExecution:true,cancellation}));
  });

  return {
    create:options => track(() => create(options)),
    inspect:options => track(() => inspect(options)), startDev:options => track(() => start(options)),
    runTests:options => track(() => tests(options)),stopDev:dev.stop,
    dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try { await dev.dispose(); }
        finally {
          await Promise.allSettled(jobs);
          for (const item of subscriptions) item.dispose();
        }
      })();
      return closing;
    }
  };
}

module.exports = { registerQuarkusWorkbench,COMMANDS };
