'use strict';

const path = require('node:path');
const { parseYaml } = require('../spring/configuration');
const { inspectMicronautProject,micronautProject,CONFIG_FILE,PART } = require('./micronaut-model');
const { createMicronautRuntime,packagedJar } = require('./micronaut-runtime');
const { distribution }=require('./micronaut-distribution');
const { workspacePath,workspaceRoots,inside,fail,cancelled } = require('./workbench-model');

const COMMANDS={inspect:'rocketbrain.micronaut.inspect',run:'rocketbrain.micronaut.run',
  tests:'rocketbrain.micronaut.test',build:'rocketbrain.micronaut.build',stop:'rocketbrain.micronaut.stop'};
const IMPORT='Import the Micronaut 5 Maven or Gradle application in Java Projects first.';

function registerMicronautWorkbench(vscode,java) {
  const output=vscode.window.createOutputChannel('Rocketbrain Micronaut');
  const runtime=createMicronautRuntime({log:chunk => output.append(chunk)});
  const subscriptions=[output], jobs=new Set();
  let pendingStart, disposed=false, closing;

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before using Micronaut tools.');
    if (cancelled(cancellation)) throw fail('Micronaut operation cancelled.');
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders || []);}
  function available() {
    return java.workbench.getSnapshot().projects.filter(project => {
      try {workspacePath(project.root,roots());micronautProject(project);return true;}
      catch {return false;}
    });
  }

  async function projectFor(uri,cancellation) {
    trusted(cancellation);
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh({cancellation});
    trusted(cancellation);
    const root=workspacePath(uri,roots());
    const project=available().find(item => !path.relative(item.root,root));
    if (!project) throw fail(IMPORT);
    return project;
  }

  async function inspect({projectUri,cancellation}={}) {
    return inspectMicronautProject(await projectFor(projectUri,cancellation),cancellation);
  }

  function saveNeeded(project) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme==='file' &&
        inside(project.root,document.uri.fsPath))) throw fail('Save modified Micronaut project files before executing build tasks.');
  }

  async function task(project,name,cancellation) {
    saveNeeded(project);
    const options={projectUri:project.uri,allowProjectExecution:true,cancellation};
    const selected=project.tool==='gradle'?':'+name:name;
    const observed=(await java.workbench.discoverTasks(options)).find(item => item.name===selected);
    if (!observed) throw fail('The Micronaut application has no observed '+selected+' build task.');
    trusted(cancellation);
    saveNeeded(project);
    return java.workbench.runTask({...options,taskId:observed.id});
  }

  async function test({projectUri,allowProjectExecution,cancellation}={}) {
    if (allowProjectExecution!==true) throw fail('Explicitly choose Micronaut tests before executing build tasks.');
    return task(await projectFor(projectUri,cancellation),'test',cancellation);
  }

  async function packageProject(project,cancellation){
    const reviewed=micronautProject(project), name=reviewed.tool==='gradle'?'installDist':'package';
    const result=await task(project,name,cancellation);
    trusted(cancellation);
    saveNeeded(project);
    if(result.state!=='succeeded')throw fail('The Micronaut application build did not complete. Check its task terminal.');
    if(reviewed.tool==='gradle'&&micronautProject(project).buildFingerprint!==reviewed.buildFingerprint)
      throw fail('The Micronaut Gradle build changed while packaging. Build again.');
    return {reviewed,result};
  }

  async function build({projectUri,allowProjectExecution,cancellation}={}){
    if(allowProjectExecution!==true)throw fail('Explicitly choose a Micronaut build before executing build tasks.');
    const project=await projectFor(projectUri,cancellation), {reviewed,result}=await packageProject(project,cancellation);
    const verified=reviewed.tool==='gradle'?await distribution(project,reviewed):await packagedJar(project);
    trusted(cancellation);
    return {...result,artifact:verified.artifact,tool:reviewed.tool,
      ...(verified.jars&&{libraryCount:verified.jars.length})};
  }

  async function run({projectUri,environment='dev',allowProjectExecution,cancellation}={}) {
    if (allowProjectExecution!==true) throw fail('Explicitly run the Micronaut application before executing build tasks.');
    trusted(cancellation);
    if (typeof environment!=='string' || !PART.test(environment)) throw fail('Use a literal Micronaut environment name.');
    if (pendingStart || runtime.getState().state!=='stopped') throw fail('Stop the current owned Micronaut application first.');
    const controller=new AbortController();
    pendingStart=controller;
    const cancel=() => controller.abort();
    const subscription=cancellation?.onCancellationRequested?.(cancel);
    cancellation?.addEventListener?.('abort',cancel,{once:true});
    try {
      const signal=controller.signal;
      const project=await projectFor(projectUri,signal);
      const {reviewed}=await packageProject(project,signal);
      const javaHome=project.jdk || vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome') || java.getState().javaHome;
      const result=await runtime.start({project,javaHome,environment,cancellation:signal,allowProjectExecution,
        workspaceTrusted:vscode.workspace.isTrusted,buildFingerprint:reviewed.buildFingerprint});
      output.appendLine(`Micronaut ${environment} · ${result.artifact} · ${result.baseUrl}`);
      output.appendLine('Application artifact SHA-256: '+result.sha256);
      return result;
    } finally {
      pendingStart=undefined;
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort',cancel);
    }
  }

  async function stop() {
    pendingStart?.abort();
    return runtime.stop();
  }

  function nativeRange(range) {
    return new vscode.Range(range.start.line,range.start.character,range.end.line,range.end.character);
  }

  function location(source) {
    const uri=vscode.Uri.parse(source.uri);
    if (uri.scheme!=='file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri)) {
      throw fail('Micronaut navigation targets must be local workspace files.');
    }
    workspacePath(uri.fsPath,roots(),{directory:false});
    return new vscode.Location(uri,nativeRange(source.range));
  }

  function matchDocument(document,position,completion,cancellation) {
    trusted(cancellation);
    if (document.uri.scheme!=='file' || document.uri.authority || !CONFIG_FILE.test(path.basename(document.uri.fsPath))) return undefined;
    const project=available().find(item => !path.relative(path.join(item.root,'src/main/resources'),path.dirname(document.uri.fsPath)));
    if (!project) return undefined;
    workspacePath(document.uri.fsPath,roots(),{directory:false});
    let key, range;
    if (document.uri.fsPath.endsWith('.properties')) {
      const line=document.lineAt(position.line).text;
      const found=/^(\s*)([A-Za-z0-9_.-]*)/.exec(line);
      const start=found[1].length, end=found[0].length;
      if (position.character<start || position.character>end || line[end] && !/[:=\t ]/.test(line[end])) return undefined;
      key=completion ? found[2].slice(0,position.character-start) : found[2];
      range=new vscode.Range(position.line,start,position.line,end);
    } else if (!completion && document.getText().length<=512*1024) {
      const found=parseYaml({uri:document.uri.toString(),text:document.getText().replace(/\r\n/g,'\n')}).entries.find(item =>
        item.range.start.line===position.line && item.range.start.character<=position.character && item.range.end.character>=position.character);
      if (!found) return undefined;
      key=found.key;
    } else return undefined;
    return {key,range,report:inspectMicronautProject(project,cancellation)};
  }

  const properties={scheme:'file',pattern:'**/src/main/resources/application*.properties'};
  const selectors=[properties,...['yaml','yml'].map(ext => ({scheme:'file',pattern:'**/src/main/resources/application*.'+ext}))];
  subscriptions.push(vscode.languages.registerCompletionItemProvider(properties,{
    provideCompletionItems(document,position,cancellation) {
      try {
        const match=matchDocument(document,position,true,cancellation);
        if (!match) return undefined;
        const keys=new Map();
        for (const setting of match.report.settings) {
          if (!setting.key.startsWith(match.key)) continue;
          if (!keys.has(setting.key)) keys.set(setting.key,new Set());
          keys.get(setting.key).add(setting.type);
        }
        return [...keys].map(([key,types]) => {
          const item=new vscode.CompletionItem(key,vscode.CompletionItemKind.Property);
          item.detail='Micronaut · '+[...types].join(' / ');
          item.range=match.range;
          return item;
        });
      } catch {return undefined;}
    }
  },'.'),vscode.languages.registerDefinitionProvider(selectors,{
    provideDefinition(document,position,cancellation) {
      try {
        const match=matchDocument(document,position,false,cancellation);
        const targets=match?.report.settings.filter(item => item.key===match.key);
        if (targets?.length) return targets.map(item => location(item.source));
      } catch {return undefined;}
    }
  }));

  async function choose() {
    if (!java.workbench.getSnapshot().projects.length) await java.workbench.refresh();
    trusted();
    const projects=available().sort((a,b) => b.root.length-a.root.length);
    const active=vscode.window.activeTextEditor?.document.uri;
    const selected=active?.scheme==='file' && projects.find(project => inside(project.root,active.fsPath));
    if (!projects.length) throw fail(IMPORT);
    return selected?.uri || (await vscode.window.showQuickPick(projects.map(project => ({label:project.name,uri:project.uri})),
      {title:'Select Micronaut Application'}))?.uri;
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
      catch (error) {void vscode.window.showErrorMessage('Rocketbrain Micronaut: '+error.message);return undefined;}
    })));
  }

  function progress(title,action) {
    return vscode.window.withProgress({title,location:vscode.ProgressLocation.Notification,cancellable:true},
      (_progress,cancellation) => action(cancellation));
  }

  register(COMMANDS.inspect,async () => {
    const projectUri=await choose();
    if (!projectUri) return;
    const report=await inspect({projectUri});
    const picked=await vscode.window.showQuickPick([
      ...report.settings.map(setting => ({label:setting.key,description:setting.type,source:setting.source})),
      ...report.configured.map(setting => ({label:setting.key,description:setting.environment || 'Base application settings',source:setting})),
      ...report.routes.map(route => ({label:route.verb+' '+route.path,description:route.method,source:route.source})),
      ...report.bindings.map(binding => ({label:binding.from+' → '+binding.type,
        description:binding.state==='source-type' ? 'Constructor wiring · source' : 'Constructor wiring · unconfirmed',
        source:binding.targets[0] || binding.source}))
    ],{title:'Micronaut Settings, HTTP Routes and Constructor Wiring'});
    if (picked) {
      const target=location(picked.source);
      return vscode.window.showTextDocument(target.uri,{selection:target.range,preview:true});
    }
  });
  register(COMMANDS.run,async () => {
    const projectUri=await choose();
    if (!projectUri) return;
    const report=await inspect({projectUri});
    const environments=[...new Set(['dev',...report.configured.map(item => item.environment).filter(Boolean)])];
    const environment=await vscode.window.showQuickPick(environments,{title:'Select Micronaut Environment'});
    if (!environment) return;
    output.show(true);
    const result=await progress('Build and Run Micronaut',cancellation => run({projectUri,environment,allowProjectExecution:true,cancellation}));
    void vscode.window.showInformationMessage('Micronaut '+environment+' is ready at '+result.baseUrl);
    return result;
  });
  register(COMMANDS.tests,async () => {
    const projectUri=await choose();
    if (projectUri) return progress('Run Micronaut Tests',cancellation => test({projectUri,allowProjectExecution:true,cancellation}));
  });
  register(COMMANDS.build,async () => {
    const projectUri=await choose();
    if(projectUri)return progress('Build Micronaut Application',cancellation => build({projectUri,allowProjectExecution:true,cancellation}));
  });
  register(COMMANDS.stop,stop);

  return {inspect:options => track(() => inspect(options)),run:options => track(() => run(options)),
    test:options => track(() => test(options)),build:options => track(() => build(options)),getState:runtime.getState,stop,dispose() {
      if (closing) return closing;
      disposed=true;
      closing=(async () => {
        try {await stop();await runtime.dispose();}
        finally {await Promise.allSettled(jobs);for (const subscription of subscriptions) subscription.dispose();}
      })();
      return closing;
    }};
}

module.exports = { registerMicronautWorkbench,COMMANDS };
