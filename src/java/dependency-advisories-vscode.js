'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { parseMavenDependencyTree, auditMavenPackages, maxTreeBytes, maxSelection } = require('./dependency-advisories');
const { workspacePath, workspaceRoots, buildFingerprint } = require('./workbench-model');
const { buildSpec, nativeTaskRunner } = require('./workbench-tasks');
const { scanScopedJavaInputs } = require('./dependency-workspace');
const { inspectAdvisoryCalls } = require('./advisory-calls');
const { mavenClasspathGoal, gradleClasspathTask, gradleClasspathInit, parseAdvisoryClasspath } = require('./advisory-classpath');
const gradle = require('./gradle-advisory-graph');

const pluginGoal = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:tree';
const scheme = 'rocketbrain-maven-advisories';
const callScheme = 'rocketbrain-java-advisory-calls';
const sha = data => createHash('sha256').update(data).digest('hex');
const location = link => JSON.stringify([link?.uri, link?.range, link?.signature]);

async function reviewedBuild(directory) {
  const inputs = ['.mvn/maven.config','.mvn/extensions.xml','.mvn/jvm.config','gradle/libs.versions.toml','gradle.lockfile'];
  const selected = [];
  for (const name of inputs) {
    const file = path.join(directory,name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || path.relative(file,await fs.realpath(file))) {
        throw Error('Use bounded physical Java build descriptors.');
      }
      selected.push([name,sha(await fs.readFile(file))]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return sha(JSON.stringify([buildFingerprint(directory),selected]));
}

function formatCallReport(result) {
  const states = {
    'calls-observed': 'Listed API use observed',
    'no-listed-use-observed': 'No listed use observed in the inspected sources',
    'no-supported-signature': 'No supported call signature for this resolved version',
    'multiple-resolved-versions': 'More than one version is present in the reviewed graph',
    'artifact-unverified': 'The compiler did not bind the listed signature to its verified release',
    'compiler-errors': 'Source binding incomplete because compiler diagnostics remain',
    'inspection-incomplete': 'Some listed signatures or call sites could not be verified',
  };
  return [
    'Java Advisory Call Sites', result.tool + ' · ' + result.project,
    'Saved production sources inspected  ' + result.sourceFiles,
    'Runtime reachability and input trust require separate review.', '',
    ...result.rows.flatMap(row => [
      row.key + ' · ' + states[row.state],
      ...row.advisories.map(id => '  ' + id),
      ...(row.vendorFixVersion ? ['  Vendor-fixed release for ' + row.callAdvisories.join(', ') + '  ' + row.vendorFixVersion, '  ' + row.recommendation,
        ...row.sources.map(source => '  ' + source)] : []),
      ...(row.signatures ?? []).map(sig => '  ' + sig.owner + '#' + sig.name + '() · ' + sig.state),
      ...row.calls.map(call => '  ' + call.uri + ' · line ' + (call.range.start.line + 1) + ' · ' + call.kind),
      '',
    ]),
    ...(result.omitted ? ['Additional call sites exceeded the report limit.'] : []),
    ...(result.problems ?? []).map(problem => 'Compiler · ' + problem.message),
    'Run Open Java Advisory Call Site to navigate to verified uses.',
  ].join('\n');
}

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

function registerDependencyAdvisories(vscode, context) {
  const tasks = nativeTaskRunner(vscode);
  const documents = new Map(), callDocuments = new Map();
  const trees = new WeakMap(), reports = new WeakMap(), inspections = new WeakMap();
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
    const before = await reviewedBuild(directory).catch(() => undefined);
    const config = vscode.workspace.getConfiguration('rocketbrain.java', projectUri);
    const spec = buildSpec({ root: directory, uri: projectUri.toString(), tool: 'maven', name: path.basename(directory) },
      { javaHome: config.get('javaHome'), mavenHome: config.get('mavenHome') }, [pluginGoal]);
    const text=await capturedTree('Maven',(_,output)=>{
      spec.args.push('--non-recursive', '-DoutputType=json', '-DoutputFile=' + output);
      spec.label = path.basename(directory) + ' · Maven dependency tree';
      return tasks.execute(spec,{cancellation});
    });
    const tree = parseMavenDependencyTree(text);
    const complete = before && await reviewedBuild(directory).catch(() => undefined) === before;
    if(complete) trees.set(tree,{projectUri,directory,tool:'maven',build:before});
    return tree;
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
    const before = await reviewedBuild(directory).catch(() => undefined);
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
    const tree = gradle.parseGradleAdvisoryGraph(text,configuration);
    const complete = before && await reviewedBuild(directory).catch(() => undefined) === before;
    if(complete) trees.set(tree,{projectUri,directory,tool:'gradle',build:before});
    return tree;
  }

  async function resolveCompilerClasspath(binding,cancellation) {
    const {projectUri,directory,tool}=binding;
    const config = vscode.workspace.getConfiguration('rocketbrain.java',projectUri);
    const settings={javaHome:config.get('javaHome'),mavenHome:config.get('mavenHome'),gradleHome:config.get('gradleHome')};
    const text=await capturedTree(tool==='maven'?'Maven':'Gradle',async(folder,output)=>{
      const project={root:directory,uri:projectUri.toString(),tool,name:path.basename(directory)};
      let spec;
      if(tool==='maven') {
        spec=buildSpec(project,settings,[mavenClasspathGoal]);
        spec.args.push('--non-recursive','-DincludeScope=compile','-Dmdep.outputFile='+output);
      } else {
        const initFile=path.join(folder,'advisory-classpath.init.gradle');
        await fs.writeFile(initFile,gradleClasspathInit,{encoding:'utf8',flag:'wx',mode:0o600});
        spec=buildSpec(project,settings,[gradleClasspathTask],{discovery:true,output,initFile});
        spec.args.push('--no-configuration-cache');
      }
      spec.label=project.name+' · Advisory compile classpath';
      return tasks.execute(spec,{cancellation});
    });
    return parseAdvisoryClasspath(text,tool);
  }

  async function scopedPacket(binding,cancellation) {
    guard();
    if(!binding?.build||await reviewedBuild(binding.directory)!==binding.build) {
      throw Error('The Java build configuration changed. Resolve this module’s dependency advisories again.');
    }
    const {scope,sources,descriptors}=await scanScopedJavaInputs(vscode,binding.projectUri,cancellation);
    const root=path.join(scope.fsPath,'src','main','java');
    const production=sources.filter(file=>{
      const relative=path.relative(root,file.path);
      return Boolean(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
    });
    if(!production.length||production.some(file=>path.basename(file.path)==='module-info.java')) {
      throw Error('Choose a standard Java module with saved src/main/java sources and a compile classpath.');
    }
    const inputs=[...descriptors,...production];
    if(inputs.some(source=>source.dirty||source.invalidUtf8)) throw Error('Save the selected Java sources and build descriptors before inspection.');
    const fingerprint=sha(JSON.stringify(inputs.map(file=>[file.uri,file.hash]).sort((a,b)=>a[0].localeCompare(b[0]))));
    return {sources:production,fingerprint};
  }

  async function inspectCalls(report,{allowProjectExecution,cancellation}={}) {
    guard();
    const captured=reports.get(report);
    if(allowProjectExecution!==true||!captured) {
      throw Error('Open an advisory report from this workspace and explicitly resolve its compiler classpath.');
    }
    const {binding,approvedReport}=captured;
    const packet=await scopedPacket(binding,cancellation);
    const classpath=await resolveCompilerClasspath(binding,cancellation);
    const javaHome=vscode.workspace.getConfiguration('rocketbrain.java',binding.projectUri).get('javaHome');
    const compiled=await inspectAdvisoryCalls({report:approvedReport,sources:packet.sources,classpath,javaHome,release:25,cancellation,
      storagePath:context?.globalStorageUri?.fsPath});
    if((await scopedPacket(binding,cancellation)).fingerprint!==packet.fingerprint) {
      throw Error('A Java source or build descriptor changed during advisory inspection.');
    }
    const {validateClasspath,...visible}=compiled;
    const result={...visible,tool:binding.tool,project:approvedReport.project.name};
    const sites=new Map(result.rows.flatMap(row=>row.calls).map(link=>[location(link),structuredClone(link)]));
    inspections.set(result,{binding,fingerprint:packet.fingerprint,validateClasspath,javaHome,sites});
    return result;
  }

  async function openCall(result,selected,cancellation) {
    const review=inspections.get(result),verified=review?.sites.get(location(selected));
    if(!verified) throw Error('Choose a listed source location from the current Java advisory inspection.');
    const {binding}=review;
    const javaHome=vscode.workspace.getConfiguration('rocketbrain.java',binding.projectUri).get('javaHome');
    if(javaHome!==review.javaHome||(await scopedPacket(binding,cancellation)).fingerprint!==review.fingerprint) {
      throw Error('The reviewed Java sources or compiler configuration changed. Inspect the advisory calls again.');
    }
    review.validateClasspath?.();
    const source=vscode.Uri.parse(verified.uri,true);
    const {start,end}=verified.range;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source),
      {selection:new vscode.Range(start.line,start.character,end.line,end.character),preview:false});
    return source;
  }

  async function publish(report) {
    guard();
    while (documents.size >= 6) documents.delete(documents.keys().next().value);
    const title=report.buildTool==='gradle'?'Gradle Dependency Advisories':'Maven Dependency Advisories';
    const uri = vscode.Uri.from({ scheme, path: '/' + randomUUID() + '/'+title+'.txt' });
    documents.set(uri.path, {text:formatReport(report),report});
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    return uri;
  }

  async function audit(tree, keys, { allowLookup, signal } = {}) {
    guard();
    if (allowLookup !== true) throw Error('Select the package versions to send to OSV.');
    const result=await auditMavenPackages(tree, keys, { signal });
    if(trees.has(tree)) reports.set(result,{binding:trees.get(tree),approvedReport:structuredClone(result)});
    return result;
  }

  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) { return vscode.workspace.isTrusted ? documents.get(uri.path)?.text || '' : ''; }
  });
  const callProvider = vscode.workspace.registerTextDocumentContentProvider(callScheme, {
    provideTextDocumentContent(uri) { return vscode.workspace.isTrusted ? callDocuments.get(uri.path)?.text || '' : ''; }
  });
  async function publishCalls(result) {
    guard();
    if(!inspections.has(result)) throw Error('Open a current inspected Java advisory report.');
    while(callDocuments.size>=6) callDocuments.delete(callDocuments.keys().next().value);
    const uri=vscode.Uri.from({scheme:callScheme,path:'/'+randomUUID()+'/Java Advisory Call Sites.txt'});
    callDocuments.set(uri.path,{text:formatCallReport(result),result});
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:false});
    return uri;
  }
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
  commands.push(vscode.commands.registerCommand('rocketbrain.java.inspectAdvisoryCalls',async()=>{
    try {
      guard();
      const uri=vscode.window.activeTextEditor?.document.uri;
      const result=uri?.scheme===scheme&&documents.get(uri.path)?.report;
      if(!result) throw Error('Open a Maven or Gradle dependency advisories report.');
      const answer=await vscode.window.showInformationMessage('Resolve this module’s compiler classpath and inspect its saved Java sources?',
        {modal:true,detail:'The selected build tool resolves its classpath. The compiler inspects sources locally with annotation processing disabled.'},'Resolve and Inspect');
      if(answer!=='Resolve and Inspect')return;
      const inspection=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Inspecting Java Advisory Calls',cancellable:true},
        (_,cancellation)=>inspectCalls(result,{allowProjectExecution:true,cancellation}));
      return publishCalls(inspection);
    } catch(error) { void vscode.window.showErrorMessage(error.message); }
  }));
  commands.push(vscode.commands.registerCommand('rocketbrain.java.openAdvisoryCall',async()=>{
    try {
      guard();
      const uri=vscode.window.activeTextEditor?.document.uri;
      const result=uri?.scheme===callScheme&&callDocuments.get(uri.path)?.result;
      if(!result)throw Error('Open a Java advisory call-sites report.');
      const sites=result.rows.flatMap(row=>row.calls);
      if(!sites.length)throw Error('The report has no verified source locations.');
      const selected=await vscode.window.showQuickPick(sites.map(link=>({label:link.signature,
        description:path.basename(vscode.Uri.parse(link.uri,true).fsPath)+' · line '+(link.range.start.line+1),link})),
        {title:'Choose an Observed Java Advisory Call'});
      if(selected)return openCall(result,selected.link);
    } catch(error) { void vscode.window.showErrorMessage(error.message); }
  }));

  return { resolveTree,resolveGradleTree,audit,publish,inspectCalls,publishCalls,openCall,async dispose() {
    await tasks.dispose(); documents.clear(); callDocuments.clear(); for(const command of commands)command.dispose();
    provider.dispose(); callProvider.dispose();
  } };
}

module.exports = { registerDependencyAdvisories };
