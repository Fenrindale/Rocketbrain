'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseMavenDependencyTree, auditMavenPackages, maxTreeBytes, maxSelection } = require('./dependency-advisories');
const { workspacePath, workspaceRoots } = require('./workbench-model');
const { buildSpec, nativeTaskRunner } = require('./workbench-tasks');
const gradle = require('./gradle-advisory-graph');

const pluginGoal = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:tree';
const scheme = 'rocketbrain-maven-advisories';

function formatReport(report) {
  const { project, checkedAt, skipped, packages } = report;
  const hits = packages.filter(item => item.advisories.length).length;
  const gradleReport=report.buildTool==='gradle';
  const title=gradleReport?'Gradle dependency advisories':'Maven dependency advisories';
  return [`${title} · ${project.name}@${project.version}`, `OSV lookup · ${checkedAt}`,
    ...(gradleReport?[`Resolved configuration · ${report.configuration}`,`Unresolved dependency edges · ${report.unresolved}`]:[]),
    `${packages.length} checked · ${hits} with reported advisories · ${skipped} unselected`, '',
    ...packages.flatMap(item => [item.key + ' · ' + (item.direct ? 'direct' : 'transitive') + ' · ' + item.scopes.join(', '),
      ...item.paths.map(chain => '  ' + chain.join(' → ')),
      ...(item.advisories.length ? item.advisories.map(id => '  https://osv.dev/vulnerability/' + id) : ['  No advisory IDs in the OSV response']),
      ...(item.complete ? [] : ['  Further results were returned beyond the lookup limit']), ''])].join('\n');
}

function registerDependencyAdvisories(vscode) {
  const tasks = nativeTaskRunner(vscode);
  const documents = new Map();
  const guard = () => {
    if (!vscode.workspace.isTrusted) throw Error('Open a trusted local build project.');
  };

  async function capturedTree(tool, callback) {
    const temp=await fs.realpath(os.tmpdir());
    const folder=await fs.mkdtemp(path.join(temp,'rocketbrain-'+tool.toLowerCase()+'-tree-'));
    const output=path.join(folder,'tree.json');
    try {
      const result=await callback(folder,output);
      guard();
      if (result.cancelled) throw Error(tool+' dependency resolution was cancelled.');
      if (result.code!==0) throw Error(tool+' dependency resolution failed. See the Rocketbrain task terminal.');
      const stat=await fs.lstat(output);
      if (!stat.isFile()||stat.isSymbolicLink()||stat.size>maxTreeBytes||
          path.relative(output,await fs.realpath(output))) {
        throw Error(tool+' did not produce a regular dependency graph within 4 MiB.');
      }
      return await fs.readFile(output,'utf8');
    } finally {
      const current=await fs.realpath(folder);
      if (!path.relative(folder,current)&&path.dirname(current)===temp) {
        await fs.rm(current,{recursive:true,force:true,maxRetries:3,retryDelay:100});
      }
    }
  }

  async function resolveTree(projectUri, { allowProjectExecution, cancellation } = {}) {
    guard();
    if (allowProjectExecution !== true || projectUri?.scheme !== 'file') throw Error('Choose a local Maven module and start dependency resolution explicitly.');
    const roots = workspaceRoots(vscode.workspace.workspaceFolders || []);
    const directory = workspacePath(projectUri.toString(), roots);
    workspacePath(path.join(directory, 'pom.xml'), [directory], { directory: false });
    const config = vscode.workspace.getConfiguration('rocketbrain.java', projectUri);
    const spec = buildSpec({ root: directory, uri: projectUri.toString(), tool: 'maven', name: path.basename(directory) },
      { javaHome: config.get('javaHome'), mavenHome: config.get('mavenHome') }, [pluginGoal]);
    const text=await capturedTree('Maven',(_,output)=>{
      spec.args.push('--non-recursive', '-DoutputType=json', '-DoutputFile=' + output);
      spec.label = path.basename(directory) + ' · Maven dependency tree';
      return tasks.execute(spec,{cancellation});
    });
    return parseMavenDependencyTree(text);
  }

  async function resolveGradleTree(projectUri, configuration, {allowProjectExecution,cancellation}={}) {
    guard();
    if (allowProjectExecution!==true||projectUri?.scheme!=='file'||!gradle.scopes.includes(configuration)) {
      throw Error('Choose a trusted Gradle module and Java configuration, then start resolution.');
    }
    const roots=workspaceRoots(vscode.workspace.workspaceFolders||[]);
    const directory=workspacePath(projectUri.toString(),roots);
    let buildFile;
    for (const name of ['build.gradle','build.gradle.kts']) {
      try { buildFile=workspacePath(path.join(directory,name),[directory],{directory:false}); break; }
      catch { /* The module may use the other standard script name. */ }
    }
    if (!buildFile) throw Error('Select a Gradle module with a local build script.');
    const config=vscode.workspace.getConfiguration('rocketbrain.java',projectUri);
    const text=await capturedTree('Gradle',async(folder,output)=>{
      const initFile=path.join(folder,'advisories.init.gradle');
      await fs.writeFile(initFile,gradle.gradleInit,{encoding:'utf8',flag:'wx',mode:0o600});
      const spec=buildSpec({root:directory,uri:projectUri.toString(),tool:'gradle',name:path.basename(directory)},
        {javaHome:config.get('javaHome'),gradleHome:config.get('gradleHome')},[gradle.task],{discovery:true,output,initFile});
      spec.args.unshift('-Drocketbrain.advisories.configuration='+configuration);
      spec.args.push('--no-configuration-cache');
      spec.label=path.basename(directory)+' · Gradle '+configuration;
      return tasks.execute(spec,{cancellation});
    });
    return gradle.parseGradleAdvisoryGraph(text,configuration);
  }

  async function publish(report) {
    guard();
    while (documents.size >= 6) documents.delete(documents.keys().next().value);
    const title=report.buildTool==='gradle'?'Gradle Dependency Advisories':'Maven Dependency Advisories';
    const uri = vscode.Uri.from({ scheme, path: '/' + randomUUID() + '/'+title+'.txt' });
    documents.set(uri.path, formatReport(report));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    return uri;
  }

  function audit(tree, keys, { allowLookup, signal } = {}) {
    guard();
    if (allowLookup !== true) throw Error('Select the package versions to send to OSV.');
    return auditMavenPackages(tree, keys, { signal });
  }

  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) { return vscode.workspace.isTrusted ? documents.get(uri.path) || '' : ''; }
  });
  async function runCommand(tool) {
    try {
      guard();
      const editor = vscode.window.activeTextEditor;
      const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) || vscode.workspace.workspaceFolders?.[0];
      const project = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, defaultUri: folder?.uri, title: 'Select '+tool+' Module to Resolve' });
      if (!project?.length) return;
      const configuration=tool==='Gradle' ? await vscode.window.showQuickPick(gradle.scopes,{title:'Choose a Gradle Java Configuration'}) : null;
      if (tool==='Gradle'&&!configuration) return;
      const tree = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Resolving '+tool+' Dependencies', cancellable: true }, (_, cancellation) => {
        const options={allowProjectExecution:true,cancellation};
        return tool==='Gradle'?resolveGradleTree(project[0],configuration,options):resolveTree(project[0],options);
      });
      const selected = await vscode.window.showQuickPick(tree.packages.map(item => ({
        label: item.key, description: item.direct ? 'direct' : 'transitive', item
      })), { title: 'Choose Package Names and Versions to Send to OSV', canPickMany: true,
        placeHolder: `Select up to ${maxSelection} package versions` });
      if (!selected?.length) return;
      guard();
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Looking Up Selected Packages in OSV', cancellable: true }, async (_, cancellation) => {
        const abort = new AbortController();
        const listener = cancellation.onCancellationRequested(() => abort.abort());
        try {
          if (cancellation.isCancellationRequested) abort.abort();
          return await audit(tree, selected.map(choice => choice.item.key), { allowLookup: true, signal: abort.signal });
        } finally { listener.dispose(); }
      });
      return await publish(report);
    } catch (error) {
      void vscode.window.showErrorMessage(error.message);
    }
  }
  const commands=['Maven','Gradle'].map(tool=>vscode.commands.registerCommand('rocketbrain.java.'+tool.toLowerCase()+'Advisories',()=>runCommand(tool)));

  return { resolveTree,resolveGradleTree,audit,publish,async dispose() {
    await tasks.dispose(); documents.clear(); for(const command of commands)command.dispose(); provider.dispose();
  } };
}

module.exports = { registerDependencyAdvisories };
