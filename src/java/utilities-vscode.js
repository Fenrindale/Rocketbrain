'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  listFileTemplates, listCopyrightProfiles, matchesFileScope, templateVariableError,
  validIdentifier, checkPackage, writeTemplateFile, contained, physicalDirectory
} = require('./file-templates');
const { runJavaScratch } = require('./scratch-engine');

const COMMANDS = Object.freeze({
  newFile: 'rocketbrain.java.newFileFromTemplate',
  openScratch: 'rocketbrain.java.openScratch',
  runScratch: 'rocketbrain.java.runScratch'
});
const SOURCE_SEARCH_EXCLUDE = '**/{.git,.gradle,.metadata,node_modules,target,build,dist,out}/**';
const BUILD_FILES = '**/{pom.xml,build.gradle,build.gradle.kts}';
const SCRATCH_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const INITIAL_SCRATCH = '// Enter Java statements or expressions here. Run with Rocketbrain: Run Java Scratch.\n';

function localUri(uri) {
  return uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment && path.isAbsolute(uri.fsPath);
}

function sourceKind(directory) {
  const found = /(?:^|[\\/])src[\\/](main|test)[\\/]java$/i.exec(directory);
  return found?.[1].toLowerCase() || 'any';
}

async function directoryExists(directory) {
  try { await physicalDirectory(directory); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sourceRoots(vscode, java) {
  const roots = (vscode.workspace.workspaceFolders || []).filter(folder => localUri(folder.uri));
  const candidates = [], imported=java.workbench?.getSnapshot().projects||[];
  async function add(workspace, directory, create = false, tool = 'java') {
    if (candidates.some(candidate => !path.relative(candidate.path, directory))) return;
    if (!contained(workspace.uri.fsPath, directory)) return;
    try {
      await physicalDirectory(workspace.uri.fsPath);
      if (!create && !await directoryExists(directory)) return;
    } catch {
      // Unavailable paths in a project tree cannot be selected for writing.
      return;
    }
    candidates.push({ workspace, path: directory, source: sourceKind(directory), create, tool });
  }
  function workspaceFor(directory) {
    return roots.filter(folder => contained(folder.uri.fsPath, directory))
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
  }
  for (const project of imported) {
    for (const source of project.sourceRoots) {
      const workspace = source.path && path.isAbsolute(source.path) && workspaceFor(source.path);
      if (workspace && !source.unavailable) await add(workspace, source.path,false,project.tool);
    }
  }
  const descriptors = await vscode.workspace.findFiles(BUILD_FILES, SOURCE_SEARCH_EXCLUDE, 120);
  const builds=new Map();
  for (const uri of descriptors.filter(localUri)) {
    const directory=path.dirname(uri.fsPath),tool=path.basename(uri.fsPath)==='pom.xml'?'maven':'gradle';
    const tools=builds.get(directory)||new Set();
    tools.add(tool);
    builds.set(directory,tools);
  }
  const projects = new Set([
    ...roots.map(folder => folder.uri.fsPath),
    ...builds.keys()
  ]);
  for (const project of projects) {
    const workspace = workspaceFor(project);
    if (!workspace) continue;
    const known=imported.find(candidate=>!path.relative(candidate.root,project)),observed=builds.get(project);
    const tool=known?.tool??(observed?.size===1?[...observed][0]:observed?.size?'unknown':'java');
    const main = path.join(project, 'src', 'main', 'java');
    const test = path.join(project, 'src', 'test', 'java');
    try {
      const hasMain = await directoryExists(main), hasTest = await directoryExists(test);
      if (hasMain || hasTest) {
        await add(workspace, main, !hasMain,tool);
        await add(workspace, test, !hasTest,tool);
      }
    } catch {
      // The other modules in a multi-root workspace remain selectable.
    }
  }
  for (const workspace of roots) {
    if (!candidates.some(candidate => candidate.workspace === workspace)) {
      await add(workspace, workspace.uri.fsPath);
    }
  }
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

function defaultPackage(vscode, source, contextUri) {
  const editor = vscode.window.activeTextEditor;
  const anchor = localUri(contextUri) ? contextUri.fsPath : localUri(editor?.document.uri) ?
    path.dirname(editor.document.uri.fsPath) : '';
  if (!anchor || !contained(source.path, anchor)) return '';
  const value = path.relative(source.path, anchor).split(path.sep).join('.');
  try { return checkPackage(value); } catch { return ''; }
}

function registerJavaUtilities(context, vscode, { java }) {
  const output = vscode.window.createOutputChannel('Rocketbrain Java Scratch');
  const baseStorage = (context.storageUri || context.globalStorageUri).fsPath;
  const scratchDirectory = path.join(baseStorage, 'java-scratch');
  const runDirectory = path.join(baseStorage, 'java-scratch-runs');
  const scratchProjects = new Map();
  let activeRun, disposed = false, disposal;

  function trusted() {
    if (!vscode.workspace.isTrusted || disposed) throw Error('Trust the workspace before creating Java files or running scratch code.');
  }

  function choicesFor(source) {
    const settings = vscode.workspace.getConfiguration('rocketbrain.java', vscode.Uri.file(source.path));
    const available=item=>matchesFileScope(item,source.source,source.tool);
    const profiles=listCopyrightProfiles(settings.get('copyrightProfiles',[])).filter(available);
    return {templates:listFileTemplates(settings.get('fileTemplates',[])).filter(available),profiles,
      defaultProfile:profiles.find(profile=>profile.name===settings.get('defaultCopyrightProfile',''))};
  }

  async function createFile({ sourceRoot, templateName, name, packageName = '', variables, copyrightProfile }, expected) {
    trusted();
    if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) throw Error('Choose a local Java source root.');
    const source = (await sourceRoots(vscode, java)).find(candidate => !path.relative(candidate.path, sourceRoot));
    if (!source) throw Error('Choose a current Java source root in the open workspace.');
    const {templates,profiles,defaultProfile}=choicesFor(source);
    const template = templates.find(template => template.name === templateName);
    if (!template) throw Error('Choose an available template for the selected source root.');
    const profile=copyrightProfile===undefined?defaultProfile:profiles.find(item=>item.name===copyrightProfile);
    if(copyrightProfile!==undefined&&copyrightProfile!==null&&!profile)throw Error('Choose a copyright profile available for this project and source root.');
    if(expected&&(JSON.stringify(expected.template)!==JSON.stringify(template)||JSON.stringify(expected.profile)!==JSON.stringify(profile)||
        expected.tool!==source.tool||expected.kind!==source.source))throw Error('The Java template, profile or source root changed. Select them again.');
    const result = await writeTemplateFile({
      workspaceRoot: source.workspace.uri.fsPath, sourceRoot: source.path, template, name, packageName,
      variables,copyrightProfile:profile,createSourceRoot: source.create,
      assertTrusted: () => {
        trusted();
        if (!vscode.workspace.workspaceFolders?.some(folder => localUri(folder.uri) &&
            !path.relative(folder.uri.fsPath, source.workspace.uri.fsPath))) {
          throw Error('The selected Java workspace folder is no longer open.');
        }
      },
      assertTarget: file => {
        if (vscode.workspace.textDocuments.some(document => document.isDirty && localUri(document.uri) &&
            !path.relative(file, document.uri.fsPath))) {
          throw Error('Save or close the pending editor for this Java source file.');
        }
      }
    });
    const uri = vscode.Uri.file(result.path);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    return { ...result, uri, projectTool:source.tool,copyrightProfile:profile?.name??null };
  }

  async function createInteractive(contextUri) {
    const sources = await sourceRoots(vscode, java);
    if (!sources.length) throw Error('Open a workspace with a local Java source folder.');
    const active = localUri(contextUri) ? contextUri : vscode.window.activeTextEditor?.document.uri;
    const choices = sources.map(source => ({
      label: path.relative(source.workspace.uri.fsPath, source.path) || source.workspace.name,
      description: [source.tool==='java'?'Java':source.tool==='maven'?'Maven':source.tool==='gradle'?'Gradle':'Build tool unconfirmed',
        source.create?'Create '+source.source+' source directory':source.workspace.name].join(' · '),
      picked: localUri(active) && contained(source.path, active.fsPath), source
    }));
    choices.sort((a, b) => Number(b.picked) - Number(a.picked));
    const target = await vscode.window.showQuickPick(choices, { title: 'Java File Template · Source Root' });
    if (!target) return;
    const {templates,profiles,defaultProfile}=choicesFor(target.source);
    const choice = await vscode.window.showQuickPick(templates.map(template => ({
      label: template.name, template
    })), { title: 'Java File Template · Type' });
    if (!choice) return;
    const name = await vscode.window.showInputBox({
      title: 'Java File Template · Type Name', prompt: 'Enter a Java type name',
      validateInput: value => validIdentifier(value) ? undefined : 'Enter a valid type name without the .java extension.'
    });
    if (name === undefined) return;
    const packageName = await vscode.window.showInputBox({
      title: 'Java File Template · Package', value: defaultPackage(vscode, target.source, contextUri),
      validateInput: value => { try { checkPackage(value); } catch (error) { return error.message; } }
    });
    if (packageName === undefined) return;
    let profile;
    if(profiles.length) {
      const items=[{label:'No copyright header'},...profiles.map(profile=>({label:profile.name,profile}))];
      if(defaultProfile)items.sort((a,b)=>Number(b.profile===defaultProfile)-Number(a.profile===defaultProfile));
      const selection=await vscode.window.showQuickPick(items,{title:'Java File Template · Copyright Profile'});
      if(!selection)return;
      profile=selection.profile;
    }
    const values=[];
    for(const item of choice.template.variables??[]) {
      const value=await vscode.window.showInputBox({title:'Java File Template · '+item.name,prompt:item.prompt,
        value:item.default,validateInput:value=>templateVariableError(item.kind,value)});
      if(value===undefined)return;
      values.push([item.name,value]);
    }
    return createFile({sourceRoot:target.source.path,templateName:choice.template.name,name,packageName,
      variables:Object.fromEntries(values),copyrightProfile:profile?.name??null},
    {template:choice.template,profile,tool:target.source.tool,kind:target.source.source});
  }

  async function openScratch({ name } = {}) {
    trusted();
    if (typeof name !== 'string' || !SCRATCH_NAME.test(name)) throw Error('Use a scratch name with letters, digits, underscores or hyphens.');
    await fs.mkdir(scratchDirectory, { recursive: true });
    await physicalDirectory(scratchDirectory);
    const file = path.join(scratchDirectory, name + '.jsh');
    const origin = vscode.window.activeTextEditor?.document.uri;
    const workspace = localUri(origin) && vscode.workspace.getWorkspaceFolder(origin);
    trusted();
    try { await fs.writeFile(file, INITIAL_SCRATCH, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await fs.lstat(file)).isFile() || path.relative(await fs.realpath(file), file)) {
      throw Error('A Java scratch must be a physical file in scratch storage.');
    }
    const uri = vscode.Uri.file(file);
    if (workspace) scratchProjects.set(file, workspace.uri.fsPath);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    return { name, uri };
  }

  async function openInteractiveScratch() {
    const name = await vscode.window.showInputBox({
      title: 'Open Java Scratch', value: 'Scratch',
      prompt: 'Enter a name to open an existing Java scratch or create one',
      validateInput: value => SCRATCH_NAME.test(value) ? undefined : 'Use letters, digits, underscores or hyphens.'
    });
    return name === undefined ? undefined : openScratch({ name });
  }

  async function scratchDocument(uri) {
    if (!localUri(uri) || path.relative(scratchDirectory, path.dirname(uri.fsPath)) ||
        !uri.fsPath.endsWith('.jsh') || !SCRATCH_NAME.test(path.basename(uri.fsPath, '.jsh'))) {
      throw Error('Open a Rocketbrain Java scratch file first.');
    }
    await physicalDirectory(scratchDirectory);
    if (!(await fs.lstat(uri.fsPath)).isFile() || path.relative(await fs.realpath(uri.fsPath), uri.fsPath)) {
      throw Error('A Java scratch must be a physical file in scratch storage.');
    }
    return vscode.workspace.openTextDocument(uri);
  }

  function projects() {
    return java.workbench?.getSnapshot().projects || [];
  }

  async function projectClasspaths(projectUri, signal) {
    const workspace = (vscode.workspace.workspaceFolders || []).filter(folder => localUri(folder.uri));
    let project = projects().find(project => project.uri === projectUri);
    if (!project && java.workbench) {
      await java.workbench.refresh({ cancellation: signal });
      project = projects().find(project => project.uri === projectUri);
    }
    trusted();
    if (!project || !workspace.some(folder => contained(folder.uri.fsPath, project.root))) {
      throw Error('Select a Java project observed in an open workspace.');
    }
    const result = await java.requestWorkspaceCommand('java.project.getClasspaths',
      [project.uri, { scope: 'runtime' }], signal);
    if (!Array.isArray(result?.classpaths) || !Array.isArray(result?.modulepaths) || result.modulepaths.length) {
      throw Error('Java Scratch supports a compiled Java project classpath. Choose the isolated JDK for named modules.');
    }
    const cp = result.classpaths.map(entry => typeof entry === 'string' && entry.startsWith('file:') ?
      vscode.Uri.parse(entry) : entry);
    if (cp.some(entry => typeof entry !== 'string' && !localUri(entry))) {
      throw Error('Java Scratch requires local project classpath paths.');
    }
    return { javaHome: project.jdk, classpaths: cp.map(entry => typeof entry === 'string' ? entry : entry.fsPath) };
  }

  async function runScratch({ uri = vscode.window.activeTextEditor?.document.uri, projectUri, signal, selection } = {}) {
    trusted();
    if (activeRun) throw Error('A Java scratch is already running.');
    const controller = new AbortController();
    const cancellation = new vscode.CancellationTokenSource();
    const cancel = () => { controller.abort(); cancellation.cancel(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const task = (async () => {
      const document = await scratchDocument(uri);
      const target = projectUri ? await projectClasspaths(projectUri, cancellation.token) : {};
      const settings = vscode.workspace.getConfiguration('rocketbrain.java');
      const javaHome = target.javaHome || java.getState().javaHome || settings.get('javaHome');
      const source = document.getText(selection);
      const result = await runJavaScratch({
        source, javaHome, classpaths: target.classpaths, storagePath: runDirectory, signal: controller.signal,
        assertTrusted: trusted
      });
      const contextLabel = result.classpathEntries ? 'project classpath' : 'isolated JDK';
      output.appendLine('Java Scratch · ' + path.basename(uri.fsPath) + ' · JDK ' + (result.jdkVersion || '?') + ' · ' + contextLabel);
      if (result.output) output.appendLine(result.output);
      output.appendLine('Run ' + result.state + '.');
      output.show(true);
      return result;
    })();
    activeRun = { task, cancel };
    try { return await task; }
    finally {
      signal?.removeEventListener('abort', cancel);
      cancellation.dispose();
      activeRun = undefined;
    }
  }

  async function runInteractiveScratch() {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    await scratchDocument(uri);
    const isolate = { label: 'Independent JDK', description: 'No project classpath', useProject: false };
    const available = [isolate];
    if (vscode.workspace.workspaceFolders?.length && java.workbench) {
      available.push({ label: 'Project classpath', description: 'Use a compiled Java project and its libraries', useProject: true });
    }
    const mode = await vscode.window.showQuickPick(available, { title: 'Run Java Scratch · Classpath' });
    if (!mode) return;
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Java Scratch', cancellable: true
    }, async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try {
        let projectUri;
        if (mode.useProject) {
          if (!projects().length) await java.workbench.refresh({ cancellation: token });
          const origin = scratchProjects.get(uri.fsPath);
          const choices = projects().map(project => ({
            label: project.name, description: project.root, project,
            picked: !!origin && contained(origin, project.root)
          })).sort((a, b) => Number(b.picked) - Number(a.picked));
          if (!choices.length) throw Error('Import a Java project before selecting a classpath.');
          const selected = await vscode.window.showQuickPick(choices, { title: 'Run Java Scratch · Project' }, token);
          if (!selected) return;
          projectUri = selected.project.uri;
        }
        return await runScratch({ uri, projectUri, signal: controller.signal,
          selection: editor.selection && !editor.selection.isEmpty ? editor.selection : undefined });
      } finally { subscription.dispose(); }
    });
  }

  function command(name, work) {
    return vscode.commands.registerCommand(name, async value => {
      try { trusted(); return await work(value); }
      catch (error) { await vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message); return null; }
    });
  }
  const subscriptions = [
    command(COMMANDS.newFile, value => value?.sourceRoot ? createFile(value) : createInteractive(value)),
    command(COMMANDS.openScratch, value => value?.name ? openScratch(value) : openInteractiveScratch()),
    command(COMMANDS.runScratch, value => value?.uri ? runScratch(value) : runInteractiveScratch())
  ];
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => activeRun?.cancel()));
  }
  return {
    createFile, openScratch, runScratch,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      activeRun?.cancel();
      disposal = Promise.allSettled(activeRun ? [activeRun.task] : []).then(() => {
        for (const subscription of subscriptions) subscription.dispose();
        output.dispose();
      });
      return disposal;
    }
  };
}

module.exports = { registerJavaUtilities, COMMANDS, sourceRoots };
