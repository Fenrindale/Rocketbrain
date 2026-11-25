'use strict';

const path = require('node:path');
const { analyzeMixedClasses,assertMixedCurrent,snapshotMixedSources } = require('./mixed-jvm-index');
const { definitionForCompiledReference } = require('./mixed-jvm-symbols');
const { cancelled,fail,inside } = require('./workbench-model');

const COMMANDS = Object.freeze({
  build:'rocketbrain.java.mixed.build',
  definition:'rocketbrain.java.mixed.definition',
  run:'rocketbrain.java.mixed.run'
});

function registerMixedJvmWorkbench(vscode,{trusted,java,ensureProject,getProjects,refreshProjects,discoverTasks,runTask,track}) {
  const indexes = new Map(), running = new Set(), subscriptions = [];
  const sourceUri = uri => uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment &&
    /\.(?:java|kt)$/.test(uri.fsPath) && Boolean(vscode.workspace.getWorkspaceFolder(uri));
  const isMixed = project => ['gradle','maven'].includes(project.tool) && ['java','kotlin'].every(language => project.languages?.includes(language));

  function assertSaved(project) {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && sourceUri(document.uri) &&
        inside(project.root,document.uri.fsPath))) throw fail('Save modified Java and Kotlin files before running the mixed JVM workflow.');
  }

  async function executeProject({projectUri,allowProjectExecution,cancellation} = {},action) {
    trusted();
    if (allowProjectExecution !== true) throw fail('Choose the mixed JVM build or run command before executing project code.');
    const project = await ensureProject(projectUri);
    trusted();
    if (!isMixed(project) || cancelled(cancellation)) throw fail('Choose a current imported project with Java and Kotlin sources.');
    if (running.has(project.root)) throw fail('Finish the current mixed JVM operation first.');
    running.add(project.root);
    try {
      assertSaved(project);
      if (action === 'run' && project.tool !== 'gradle') throw fail('The mixed JVM run command uses an observed Gradle application run task.');
      const names = action === 'run' ? [':run','run'] : project.tool === 'maven' ? ['compile'] : [':classes','classes'];
      const sources = action === 'build' ? snapshotMixedSources(project,cancellation) : null;
      if (sources) indexes.delete(project.root);
      const options = {projectUri:project.uri,allowProjectExecution:true,cancellation};
      const tasks = await discoverTasks(options);
      const task = tasks.find(item => names.includes(item.name));
      if (!task) throw fail('The project has no observed '+(action === 'run' ? 'Gradle application run' : 'main compilation')+' task.');
      assertSaved(project);
      const result = await runTask({...options,taskId:task.id});
      if (result.state !== 'succeeded') throw fail('The mixed JVM task did not finish successfully. Check its dedicated task terminal.');
      trusted();
      if (cancelled(cancellation)) throw fail('The mixed JVM workflow was cancelled.');
      if (!sources) return result;
      assertSaved(project);
      const state = java.getState();
      if (state.state !== 'running' || !state.javaHome) throw fail('Start the independent Java engine before inspecting JVM classes.');
      const index = await analyzeMixedClasses({project,sources,javaHome:state.javaHome,cancellation});
      trusted();
      if (java.getState().runtimeIdentity !== state.runtimeIdentity || !getProjects().some(item => item.uri === project.uri)) {
        throw fail('The Java engine or its imported project changed during mixed compilation.');
      }
      indexes.set(project.root,{...index,runtimeIdentity:state.runtimeIdentity});
      return {task:result.task,sourceFiles:sources.files.length,classes:index.classes.length,
        languages:[...new Set(sources.files.map(item => item.language))].sort(),projectUri:project.uri};
    } finally { running.delete(project.root); }
  }

  async function definition({document,position,cancellation} = {}) {
    trusted();
    if (!document || !sourceUri(document.uri) || document.isDirty || document.isClosed || !position || cancelled(cancellation)) return undefined;
    const root = document.uri.fsPath, version = document.version;
    const index = [...indexes.values()].sort((a,b) => b.project.root.length-a.project.root.length)
      .find(item => item.sources.files.some(source => !path.relative(root,source.file)));
    if (!index || java.getState().runtimeIdentity !== index.runtimeIdentity ||
        !getProjects().some(item => item.uri === index.project.uri)) return undefined;
    const use = index.sources.files.find(source => !path.relative(source.file,root));
    if (use.text !== document.getText()) return undefined;
    assertMixedCurrent(index,cancellation);
    const target = definitionForCompiledReference(index,{file:root,offset:document.offsetAt(position)});
    if (!target) return undefined;
    const uri = vscode.Uri.file(target.file), targetDocument = await vscode.workspace.openTextDocument(uri);
    const original = index.sources.files.find(source => source.file === target.file);
    trusted();
    if (!sourceUri(uri) || document.isClosed || document.isDirty || document.version !== version ||
        targetDocument.isClosed || targetDocument.isDirty || targetDocument.getText() !== original.text ||
        cancelled(cancellation)) throw fail('A source or editor changed after the mixed JVM build.');
    assertMixedCurrent(index,cancellation);
    return {...target,uri,selection:new vscode.Range(targetDocument.positionAt(target.range.start),targetDocument.positionAt(target.range.end))};
  }

  async function selectProject() {
    if (!getProjects().length) await refreshProjects();
    const document = vscode.window.activeTextEditor?.document, projects = getProjects().filter(isMixed);
    const current = document && sourceUri(document.uri) && projects.filter(project =>
      inside(project.root,document.uri.fsPath)).sort((a,b) => b.root.length-a.root.length)[0];
    if (current) return current.uri;
    const selected = await vscode.window.showQuickPick(projects.map(project => ({
      label:project.name,description:project.tool,uri:project.uri
    })),{title:'Select Imported Mixed JVM Project'});
    return selected?.uri;
  }

  function register(command,action) {
    subscriptions.push(vscode.commands.registerCommand(command,() => track(async () => {
      try { trusted(); return await action(); }
      catch (error) { void vscode.window.showErrorMessage('Rocketbrain JVM: '+error.message); return undefined; }
    })));
  }
  register(COMMANDS.build,async () => {
    const projectUri = await selectProject();
    if (!projectUri) return undefined;
    const result = await vscode.window.withProgress({
      title:'Build and Index Mixed JVM Sources',location:vscode.ProgressLocation.Notification,cancellable:true
    },(_progress,cancellation) => executeProject({projectUri,allowProjectExecution:true,cancellation},'build'));
    void vscode.window.showInformationMessage('Indexed '+result.classes+' compiled JVM classes from '+result.sourceFiles+' Java and Kotlin sources.');
    return result;
  });
  register(COMMANDS.definition,async () => {
    const editor = vscode.window.activeTextEditor;
    const target = await definition({document:editor?.document,position:editor?.selection.active});
    if (!target) throw fail('Build and index the mixed project and place the cursor on a supported cross-language reference.');
    return vscode.window.showTextDocument(target.uri,{selection:target.selection,preview:true});
  });
  register(COMMANDS.run,async () => {
    const projectUri = await selectProject();
    return projectUri && executeProject({projectUri,allowProjectExecution:true},'run');
  });
  if (vscode.languages?.registerDefinitionProvider) {
    subscriptions.push(vscode.languages.registerDefinitionProvider([
      {language:'java',scheme:'file'},{language:'kotlin',scheme:'file'}
    ],{async provideDefinition(document,position,cancellation) {
      const target = await definition({document,position,cancellation}).catch(() => undefined);
      return target && new vscode.Location(target.uri,target.selection);
    }}));
  }
  return {
    buildAndIndex:options => executeProject(options,'build'),definition,run:options => executeProject(options,'run'),
    dispose() { indexes.clear(); for (const item of subscriptions) item.dispose(); }
  };
}

module.exports = { registerMixedJvmWorkbench,COMMANDS };
