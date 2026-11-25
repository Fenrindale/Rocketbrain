'use strict';

const fs = require('node:fs/promises');
const { lstatSync,readFileSync,realpathSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { analyzeJavaSources } = require('./signature-compiler');
const { inside, local } = require('./workbench-model');
const { classDiagram,mermaidDiagram,dataFlow,callFlow,RELATION_MODES } = require('./source-analysis-model');
const { diagramHtml } = require('./source-diagram-view');
const { structuralQuery,parseCaptureConstraints,reviewedStructuralMatches,structuralEdits } = require('./structural-search');
const { createInterfaceExtraction } = require('./extract-interface-vscode');
const { createMemberHierarchy } = require('./member-hierarchy-vscode');
const { createJavaConversion } = require('./java-conversion-vscode');
const { createConstantExtraction } = require('./extract-constant-vscode');
const { createValueExtraction } = require('./extract-value-vscode');
const { createMethodInline } = require('./inline-method-vscode');
const { createMethodExtraction } = require('./extract-method-vscode');
const { createTypeImport } = require('./type-import-vscode');
const { createTypedFileStructure } = require('./typed-file-structure');
const { createJavaCleanup,COMMAND:cleanupCommand } = require('./java-cleanup-vscode');
const { createExpectedCompletion,COMMAND:expectedCompletionCommand } = require('./expected-completion-vscode');
const { registerQualifierCompletion } = require('./qualifier-completion-vscode');

const COMMANDS = Object.freeze({
  diagram:'rocketbrain.java.showClassDiagram', flow:'rocketbrain.java.traceDataFlow', callFlow:'rocketbrain.java.traceCallDataFlow',
  structural:'rocketbrain.java.structuralSearch', extractInterface:'rocketbrain.java.extractInterface',
  pullUp:'rocketbrain.java.pullUpMembers', pushDown:'rocketbrain.java.pushDownMembers',
  convert:'rocketbrain.java.convertStructure', extractConstant:'rocketbrain.java.extractConstant',
  extractVariable:'rocketbrain.java.extractVariable', extractField:'rocketbrain.java.extractField',cleanup:cleanupCommand,
  expectedCompletion:expectedCompletionCommand
});
const EXCLUDE = '**/{.git,.gradle,.metadata,node_modules,build,target,out,bin,dist}/**';
const MAX_UNITS = 240;
const signatures = value => createHash('sha256').update(value).digest('hex');

function localFile(uri) {
  return uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment &&
    path.isAbsolute(uri.fsPath);
}

async function fileContent(uri) {
  const file = uri.fsPath, fileStat = await fs.lstat(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 512 * 1024 ||
      path.relative(file,await fs.realpath(file))) throw Error('Select bounded Java sources with physical workspace paths.');
  const bytes = await fs.readFile(file);
  if (bytes.length > 512 * 1024) throw Error('A Java source exceeds 512 KiB.');
  return { uri:uri.toString(),text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),sha:signatures(bytes),bytes:bytes.length };
}

function registerJavaSourceAnalysis(context,vscode,{java}) {
  const owned = (context.storageUri || context.globalStorageUri).fsPath;
  const storagePath = path.join(owned,'java-source-analysis');
  const streamTrace = require('./stream-trace-vscode').registerStreamTrace(vscode,java);
  const snapshotByReport = new WeakMap(), diagramReviews = new WeakMap(), callReviews = new WeakMap();
  const structuralReports = new WeakMap(), active = new Set(), panels = new Set();
  let disposed = false, stopping;

  function assertReady(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before compiler-backed Java analysis.');
    if (cancellation?.isCancellationRequested) throw Error('Java analysis cancelled.');
  }

  function dirty(uri) {
    return vscode.workspace.textDocuments.some(document => localFile(document.uri) &&
      !path.relative(document.uri.fsPath,uri.fsPath) && document.isDirty);
  }

  function matchesDraft(uri,draftUri) { return localFile(draftUri)&&!path.relative(uri.fsPath,draftUri.fsPath); }

  function assertUnchangedSourceSnapshots(sources,draftUri) {
    const open = vscode.workspace.textDocuments.filter(document => !document.isClosed && localFile(document.uri));
    const normalize = text => text.replace(/\r\n/g,'\n');
    for (const source of sources) {
      const uri = vscode.Uri.parse(source.uri), file = uri.fsPath, stat = lstatSync(file);
      const document = open.find(candidate => !path.relative(candidate.uri.fsPath,file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.bytes || path.relative(file,realpathSync(file)) ||
          signatures(readFileSync(file)) !== source.sha ||
          document && !matchesDraft(uri,draftUri) && (document.isDirty || normalize(document.getText()) !== normalize(source.text))) {
        throw Error('A Java dependency source changed after review.');
      }
    }
  }

  async function projects(cancellation) {
    assertReady(cancellation);
    const state = await java.start();
    assertReady(cancellation);
    if (state.state !== 'running' || !state.javaHome || !java.workbench) {
      throw Error('Start the configured independent Java language server.');
    }
    let projects = java.workbench.getSnapshot().projects;
    if (!projects.length) projects = (await java.workbench.refresh({cancellation})).projects;
    return { javaHome:state.javaHome,runtimeIdentity:state.runtimeIdentity,
      extractInterfaceReplaceUsages:state.extractInterfaceReplaceUsages,projects };
  }

  function findProject(projects,documentUri,projectUri) {
    const found = projectUri ? projects.find(project => project.uri === projectUri) :
      projects.filter(project => localFile(documentUri) && project.sourceRoots.some(root =>
        !root.unavailable && inside(root.path,documentUri.fsPath))).sort((a,b) => b.root.length - a.root.length)[0];
    if (!found || !vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(found.uri))) {
      throw Error('Choose an imported Java project in the open workspace.');
    }
    return found;
  }

  async function classpaths(project,cancellation) {
    const answer = await java.requestWorkspaceCommand('java.project.getClasspaths',[project.uri,{scope:'runtime'}],cancellation);
    assertReady(cancellation);
    if (!Array.isArray(answer?.classpaths) || !Array.isArray(answer?.modulepaths) || answer.modulepaths.length) {
      throw Error('This analysis supports observed Java classpath projects.');
    }
    const entries = [];
    for (const item of answer.classpaths) {
      const file = local(item);
      try { await fs.stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!entries.includes(file)) entries.push(file);
    }
    return entries;
  }

  async function snapshot(uri,cancellation,draftUri) {
    assertReady(cancellation);
    if (!localFile(uri) || !vscode.workspace.getWorkspaceFolder(uri) || !uri.fsPath.toLowerCase().endsWith('.java') ||
        !matchesDraft(uri,draftUri)&&dirty(uri)) {
      throw Error('Save each Java source before compiler analysis.');
    }
    return fileContent(uri);
  }

  async function classSources(project,cancellation,draftUri) {
    const production = project.sourceRoots.filter(root => !root.unavailable &&
      !/(?:^|[\\/])src[\\/](?:test|testFixtures|integrationTest)[\\/]/i.test(root.path));
    if (!production.length) throw Error('Import a production Java source root for analysis.');
    const root = vscode.Uri.parse(project.uri);
    const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(root,'**/*.java'),EXCLUDE,MAX_UNITS + 1,cancellation);
    if (candidates.length > MAX_UNITS) throw Error('Compiler analysis supports at most 240 Java files per imported project.');
    const sources = [];
    let total = 0;
    for (const uri of candidates) {
      if (!localFile(uri) || !production.some(root => inside(root.path,uri.fsPath))) continue;
      if (path.basename(uri.fsPath) === 'module-info.java') throw Error('This analysis currently supports Java classpath projects.');
      const file = await snapshot(uri,cancellation,draftUri);
      if ((total += file.bytes) > 8 * 1024 * 1024) throw Error('Java analysis source inputs exceed 8 MiB.');
      sources.push(file);
    }
    return sources;
  }

  async function compile(state,project,sources,inspection,cancellation,{newSources = [],errorTitle,allowTypeImportErrors=false,draftUri} = {}) {
    if (!sources.length) throw Error('No saved Java source was found in this scope.');
    if (draftUri && !['expectedCompletion','springQualifier'].includes(inspection.kind)) {
      throw Error('An unsaved source is only supported for Java completion.');
    }
    const classpath = await classpaths(project,cancellation);
    const compliance = /^(?:1\.)?(\d+)$/.exec(String(project.compliance || ''))?.[1];
    const report = await analyzeJavaSources({
      javaHome:state.javaHome,classpath,release:Number(compliance || 25),storagePath,cancellation,
      sources:[...sources,...newSources].map(({uri,text}) => ({uri,text})),manifestLimit:256*1024,inspection
    });
    if (report.errors.length&&!(allowTypeImportErrors&&['typeImport','staticImport'].includes(inspection.kind))) {
      const prefix = errorTitle || (inspection.kind === 'check' ? 'The replacement would fail Java compiler analysis: ' :
        'Resolve Java compiler errors before analysis: ');
      throw Error(prefix + report.errors[0].message);
    }
    for (const source of sources) {
      const saved = await snapshot(vscode.Uri.parse(source.uri),cancellation,draftUri);
      if (saved.sha !== source.sha) throw Error('Java source changed during analysis. Run it again.');
    }
    assertReady(cancellation);
    return { ...report,classpathEntries:classpath };
  }

  async function diagram({ projectUri,uri,cancellation } = {}) {
    const state = await projects(cancellation);
    const project = findProject(state.projects,uri,projectUri);
    const sources = await classSources(project,cancellation);
    const compiler = await compile(state,project,sources,{kind:'diagram'},cancellation);
    const report = { ...classDiagram(compiler,sources),project:project.name,sourceFiles:sources.length,projectUri:project.uri };
    if (!report.localCount) throw Error('The compiler found no Java class declarations in this scope.');
    const hashes=new Map(sources.map(item=>[item.uri,item.sha]));
    snapshotByReport.set(report,hashes);
    const locations=new Map(report.edges.filter(edge=>edge.origins).map(edge=>[edge.id,edge.origins.map(item=>structuredClone(item.location))]));
    diagramReviews.set(report,{state,project,sources,hashes,locations,compiler});
    return report;
  }

  async function refreshDiagram(report,{cancellation}={}) {
    const reviewed=diagramReviews.get(report);
    if (!reviewed) throw Error('Open a current Java class diagram before refreshing it.');
    return diagram({projectUri:reviewed.project.uri,cancellation});
  }

  async function revealRelationship(report,id,origin,{cancellation}={}) {
    assertReady(cancellation);
    const reviewed=diagramReviews.get(report), location=Number.isSafeInteger(origin)&&origin>=0?reviewed?.locations.get(id)?.[origin]:null;
    if (!location) throw Error('Choose a relationship source from the current Java class diagram.');
    const {state,project,sources,hashes,compiler}=reviewed;
    function checkRuntime() {
      assertReady(cancellation);
      const current=java.getState();
      if (current.state!=='running'||current.runtimeIdentity!==state.runtimeIdentity) throw Error('The Java runtime changed. Refresh the class diagram.');
    }
    checkRuntime();
    const current=java.workbench.getSnapshot().projects.find(item=>item.uri===project.uri);
    if (!current||current.compliance!==project.compliance||!vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(current.uri))) {
      throw Error('Java project settings changed. Refresh the class diagram before following this link.');
    }
    const live=await classSources(current,cancellation);
    if (live.length!==hashes.size||live.some(item=>hashes.get(item.uri)!==item.sha)) {
      throw Error('Java sources changed. Refresh the class diagram before following this link.');
    }
    const entries=await classpaths(current,cancellation);
    if (entries.length!==compiler.classpathEntries.length||entries.some((item,index)=>item!==compiler.classpathEntries[index])) {
      throw Error('Java sources or classpath changed. Refresh the class diagram before following this link.');
    }
    return reveal(report,location,()=>{
      checkRuntime();assertUnchangedSourceSnapshots(sources);compiler.validateClasspath();
    });
  }

  function flowOffset(source,position) {
    const lines = source.text.split('\n');
    if (position.line < 0 || position.line >= lines.length || position.character < 0 ||
        position.character > lines[position.line].replace(/\r$/,'').length) throw Error('Choose a cursor within the saved Java source.');
    return lines.slice(0,position.line).reduce((sum,line) => sum + line.length + 1,position.character);
  }

  async function trace({ document,position,cancellation }) {
    if (!document || document.languageId !== 'java' || document.isClosed || !position) {
      throw Error('Place the cursor on a saved Java value to trace it.');
    }
    const version = document.version;
    const source = await snapshot(document.uri,cancellation),offset = flowOffset(source,position);
    const state = await projects(cancellation);
    const project = findProject(state.projects,document.uri);
    const compiled = await compile(state,project,[source],{kind:'dataflow',uri:source.uri,offset},cancellation);
    if (document.isClosed || document.version !== version) throw Error('The selected Java editor changed during tracing.');
    const result = dataFlow(compiled,source,offset);
    snapshotByReport.set(result,new Map([[source.uri,source.sha]]));
    return result;
  }

  async function compileCallFlow(state,project,sources,source,offset,cancellation,caller) {
    const compiler=await compile(state,project,sources,{kind:'callFlow',uri:source.uri,offset,caller},cancellation);
    const report=callFlow(compiler,source,sources,offset);
    const hashes=new Map(sources.map(item=>[item.uri,item.sha]));
    snapshotByReport.set(report,hashes);
    callReviews.set(report,{state,project,sources,source,offset,compiler,hashes,
      directions:new Map([report.origin,...report.inputs,...report.uses].map(event=>[event.id,structuredClone(event)])),
      contexts:new Map(report.contexts.map(context=>[context.id,structuredClone(context)]))});
    return report;
  }

  async function traceCalls({document,position,cancellation}={}) {
    if (!document||document.languageId!=='java'||document.isClosed||!position) {
      throw Error('Place the cursor on a saved Java value to trace direct calls.');
    }
    const version=document.version, state=await projects(cancellation), project=findProject(state.projects,document.uri);
    const sources=(await classSources(project,cancellation)).sort((a,b)=>a.uri.localeCompare(b.uri));
    const source=sources.find(item=>!path.relative(vscode.Uri.parse(item.uri).fsPath,document.uri.fsPath));
    if (!source) throw Error('Select a saved Java file in the imported production source roots.');
    const result=await compileCallFlow(state,project,sources,source,flowOffset(source,position),cancellation);
    if (document.isClosed||document.version!==version) throw Error('The selected Java editor changed during tracing.');
    return result;
  }

  function checkCallRuntime(review,cancellation) {
    assertReady(cancellation);
    const current=java.getState();
    if (current.state!=='running'||current.runtimeIdentity!==review.state.runtimeIdentity) {
      throw Error('The Java runtime changed. Trace the value again.');
    }
  }

  async function checkCallSources(review,cancellation) {
    checkCallRuntime(review,cancellation);
    const current=java.workbench.getSnapshot().projects.find(item=>item.uri===review.project.uri);
    if (!current||current.compliance!==review.project.compliance||!vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(current.uri))) {
      throw Error('Java project settings changed. Trace the value again.');
    }
    const live=await classSources(current,cancellation);
    if(live.length!==review.hashes.size||live.some(item=>review.hashes.get(item.uri)!==item.sha)) {
      throw Error('Java sources changed. Trace the value again.');
    }
    const paths=await classpaths(current,cancellation), reviewed=review.compiler.classpathEntries;
    if(paths.length!==reviewed.length||paths.some((item,index)=>item!==reviewed[index])) {
      throw Error('The Java classpath changed. Trace the value again.');
    }
    review.compiler.validateClasspath();
    return current;
  }

  async function selectCallContext(report,id,{cancellation}={}) {
    const review=callReviews.get(report), caller=review?.contexts.get(id);
    if (!caller) throw Error('Choose a direct caller from the current Java call flow.');
    const project=await checkCallSources(review,cancellation);
    const scoped=await compileCallFlow(review.state,project,review.sources,review.source,review.offset,cancellation,caller);
    if (callReviews.get(scoped).compiler.classpathFingerprint!==review.compiler.classpathFingerprint) {
      throw Error('The Java classpath changed. Trace the value again.');
    }
    checkCallRuntime(review,cancellation);
    return scoped;
  }

  async function revealCallFlow(report,id,{cancellation}={}) {
    const review=callReviews.get(report),event=review?.directions.get(id);
    if (!event) throw Error('Choose a source link from the current Java call flow.');
    await checkCallSources(review,cancellation);
    return reveal(report,event,()=>{
      checkCallRuntime(review,cancellation);
      assertUnchangedSourceSnapshots(review.sources);
      review.compiler.validateClasspath();
    });
  }

  async function structuralSearch({ projectUri,uri,fileOnly = false,cancellation,...input } = {}) {
    const query = structuralQuery(input);
    if (fileOnly && !localFile(uri)) throw Error('Open a local Java source to search this file.');
    const state = await projects(cancellation);
    const project = findProject(state.projects,uri,projectUri);
    const sources = (await classSources(project,cancellation)).sort((a,b) => a.uri.localeCompare(b.uri));
    const scoped = fileOnly ? sources.find(source => !path.relative(vscode.Uri.parse(source.uri).fsPath,uri.fsPath)) : null;
    if (fileOnly && !scoped) throw Error('Select a saved Java file in the production source roots.');
    const compiler = await compile(state,project,sources,{...query,kind:'structural',...(scoped && { uri:scoped.uri })},cancellation);
    const result = reviewedStructuralMatches(compiler.structural,sources);
    const report = { ...result,project:project.name,projectUri:project.uri,sourceFiles:scoped ? 1 : sources.length,
      replacementRequested:query.replacement !== undefined };
    structuralReports.set(report,{ state,project,sources,matches:structuredClone(result.matches),compiler });
    snapshotByReport.set(report,new Map(sources.map(source => [source.uri,source.sha])));
    return report;
  }

  async function prepareStructuralReplacement(report, ids, { cancellation } = {}) {
    assertReady(cancellation);
    const review = structuralReports.get(report);
    if (!review) throw Error('Run Java structural search before reviewing replacements.');
    const { state,project,sources,matches,compiler } = review;
    const original = new Map(sources.map(source => [source.uri,source.sha]));
    async function checkSources(token) {
      const live = await classSources(project,token);
      if (live.length !== original.size || live.some(source => original.get(source.uri) !== source.sha)) {
        throw Error('A Java source or project source membership changed after structural search.');
      }
      compiler.validateClasspath();
    }
    const edits = structuralEdits(matches,ids,sources);
    const dependencies = sources.filter(source => !Object.hasOwn(edits.changes,source.uri));
    await checkSources(cancellation);
    const verified = await compile(state,project,edits.sources,{kind:'check'},cancellation);
    if (verified.classpathFingerprint !== compiler.classpathFingerprint) {
      throw Error('Java classpath changed after structural search. Search again.');
    }
    return java.refactoring.previewWorkspaceEdit({changes:edits.changes},{
      kind:'refactor.replace.structure',title:'Java Structural Replacement',cancellation,
      warnings:['Javac checked the selected edits together. Review the behavioral changes in the diff.'],
      validate:async token => {
        await checkSources(token);
        const liveClasspath = await classpaths(project,token);
        if (liveClasspath.length !== verified.classpathEntries.length ||
            liveClasspath.some((entry,index) => entry !== verified.classpathEntries[index])) {
          throw Error('Java classpath entries changed after structural replacement review.');
        }
        verified.validateClasspath();
      },
      preApply:() => { verified.validateClasspath(); assertUnchangedSourceSnapshots(dependencies); }
    });
  }

  const range = value => new vscode.Range(value.start.line,value.start.character,value.end.line,value.end.character);
  async function reveal(report,item,preOpen) {
    assertReady();
    if (callReviews.has(report)&&!preOpen) throw Error('Choose a source link from the current Java call flow.');
    const hashes = snapshotByReport.get(report), expected = hashes?.get(item?.uri);
    if (!expected) throw Error('Refresh Java analysis before opening a source link.');
    const uri = vscode.Uri.parse(item.uri);
    const read = await snapshot(uri);
    if (read.sha !== expected) throw Error('Java source changed. Refresh the analysis first.');
    const document = await vscode.workspace.openTextDocument(uri);
    const normalized = text => text.replace(/\r\n/g,'\n');
    if (document.isDirty || normalized(document.getText()) !== normalized(read.text)) {
      throw Error('Save the Java editor before opening this source link.');
    }
    const selection = document.validateRange(range(item.range));
    if (preOpen) preOpen();
    return vscode.window.showTextDocument(document,{preview:true,selection});
  }

  async function exportMermaid(report,destination,{external=true,relationships='all'}={}) {
    assertReady();
    if (!snapshotByReport.has(report) || !Array.isArray(report.nodes) || !localFile(destination) ||
        path.extname(destination.fsPath).toLowerCase() !== '.mmd') throw Error('Choose a local .mmd file for this class diagram.');
    const parent = path.dirname(destination.fsPath);
    if (path.relative(parent,await fs.realpath(parent))) throw Error('Choose a physical directory for the Mermaid diagram.');
    try { await fs.writeFile(destination.fsPath,mermaidDiagram(report,{external,relationships}),{flag:'wx',encoding:'utf8'}); }
    catch (error) {
      if (error.code === 'EEXIST') throw Error('A Mermaid diagram already exists at the selected path.');
      throw error;
    }
    return destination;
  }

  function managed(operation) {
    const pending = Promise.resolve().then(operation);
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => {});
    return pending;
  }

  function operation(title,fn) {
    return vscode.window.withProgress({title,cancellable:true,location:vscode.ProgressLocation.Notification},
      (_value,token) => managed(() => fn(token)));
  }

  function showDiagram(initial,{focus:initialFocus='',relationships:initialMode='all'}={}) {
    assertReady();
    if (!diagramReviews.has(initial) || !Array.isArray(initial.nodes) || !RELATION_MODES.has(initialMode) ||
        initialFocus&&!initial.nodes.some(node=>!node.external&&node.id===initialFocus)) throw Error('Choose a supported view of an analyzed Java project.');
    let report=initial,external=true,focus=initialFocus,relationships=initialMode,closed=false,refreshing=false,revision=0;
    const panel = vscode.window.createWebviewPanel('rocketbrainJavaClassDiagram','Java Class Diagram',
      vscode.ViewColumn.Beside,{enableScripts:true,localResourceRoots:[]});
    panels.add(panel);
    const render = () => { if (!closed) panel.webview.html=diagramHtml(report,{focus,external,relationships,revision:++revision}); };
    render();
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (closed || !message || message.revision!==revision || !['source','relationship','options','refresh','export'].includes(message.type)) return;
      try {
        assertReady();
        if (message.type === 'source') {
          const type = report.nodes.find(item => item.id === message.node && !item.external);
          if (!type) return;
          const target = message.member === undefined ? type.location :
            Number.isInteger(message.member) && message.member >= 0 ? type.members[message.member]?.location : null;
          if (target) await reveal(report,target);
        } else if (message.type === 'relationship') {
          await operation('Verify Java Relationship Source',cancellation=>revealRelationship(report,message.id,message.origin,{cancellation}));
        } else if (message.type === 'options') {
          if (typeof message.external !== 'boolean' || !RELATION_MODES.has(message.relationships) ||
              (message.focus !== '' && !report.nodes.some(node => !node.external && node.id === message.focus))) return;
          external = message.external;
          focus = message.focus;
          relationships=message.relationships;
          render();
        } else if (message.type === 'refresh' && !refreshing) {
          refreshing = true;
          try {
            report = await operation('Refresh Java Class Diagram',
              cancellation => refreshDiagram(report,{cancellation}));
            if (focus && !report.nodes.some(node => node.id === focus)) focus = '';
            render();
          } finally { refreshing = false; }
        } else if (message.type === 'export') {
          const file = await vscode.window.showSaveDialog({title:'Export Java Class Diagram',filters:{Mermaid:['mmd']},
            defaultUri:vscode.Uri.joinPath(vscode.Uri.parse(report.projectUri),'class-diagram.mmd')});
          if (file) await exportMermaid(report,file,{external,relationships});
        }
      } catch (error) {
        if (!closed && !disposed) void vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message);
      }
    });
    const changes = vscode.workspace.onDidChangeTextDocument(event => {
      if (!closed && snapshotByReport.get(report)?.has(event.document.uri.toString()) && event.contentChanges.length) {
        void panel.webview.postMessage({type:'stale'});
      }
    });
    const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(initial.projectUri),'**/*.java'));
    const stale=()=>{if(!closed)void panel.webview.postMessage({type:'stale'});};
    const notifications=[watcher.onDidChange(stale),watcher.onDidCreate(stale),watcher.onDidDelete(stale)];
    panel.onDidDispose(() => {
      closed = true;
      messages.dispose();
      changes.dispose();
      for (const notification of notifications) notification.dispose();
      watcher.dispose();
      panels.delete(panel);
    });
    return panel;
  }

  async function showProjectDiagram() {
    const state = await operation('Find Java Projects',projects);
    const selection = await vscode.window.showQuickPick(state.projects.map(project => ({
      label:project.name,description:project.root,projectUri:project.uri
    })),{title:'Java Class Diagram · Project'});
    if (!selection) return;
    return showDiagram(await operation('Analyze Java Class Relationships',
      cancellation => diagram({projectUri:selection.projectUri,cancellation})));
  }

  async function showTrace() {
    const editor = vscode.window.activeTextEditor;
    const report = await operation('Trace Java Values',cancellation =>
      trace({document:editor?.document,position:editor?.selection.active,cancellation}));
    const chosen = await vscode.window.showQuickPick([
      {label:'To Here',description:report.inputs.length + ' source events',items:report.inputs},
      {label:'From Here',description:report.uses.length + ' downstream events',items:report.uses}
    ],{title:'Java Value Flow · ' + report.origin.name});
    if (!chosen) return report;
    if (!chosen.items.length) {
      await vscode.window.showInformationMessage('No linked Java values on this side of the selection.');
      return report;
    }
    const item = (await vscode.window.showQuickPick(chosen.items.map(event => ({
      label:event.name,description:event.kind + ' · ' + event.steps + (event.steps === 1 ? ' step' : ' steps'),
      detail:'Line ' + (event.range.start.line + 1),event
    })),{title:chosen.label + ' · Java Value Flow'}))?.event;
    if (item) await reveal(report,item);
    return report;
  }

  async function showCallTrace() {
    const editor=vscode.window.activeTextEditor;
    let report=await operation('Trace Java Values Across Calls',cancellation=>
      traceCalls({document:editor?.document,position:editor?.selection.active,cancellation}));
    const sourceLabel=event=>vscode.workspace.asRelativePath(vscode.Uri.parse(event.uri))+':'+(event.range.start.line+1);
    if (report.contexts.length) {
      const rows=report.contexts.map(context=>({label:context.method,detail:sourceLabel(context),context}));
      const activeContext=await vscode.window.showQuickPick([{label:'Within the selected method'},...rows],
        {title:'Java Call Flow · Caller Context',placeHolder:report.omittedContexts?
          report.omittedContexts+' direct call sites are outside this list.':'Choose a single caller to trace its arguments and return value'});
      if (!activeContext) return report;
      if (activeContext.context) report=await operation('Trace Selected Java Caller',cancellation=>
        selectCallContext(report,activeContext.context.id,{cancellation}));
    }
    const direction=await vscode.window.showQuickPick([
      {label:'To Here',description:report.inputs.length+' source events',events:report.inputs},
      {label:'From Here',description:report.uses.length+' downstream events',events:report.uses}
    ],{title:'Java Call Flow · '+report.origin.name});
    if (!direction) return report;
    if (!direction.events.length) {
      void vscode.window.showInformationMessage('No linked Java values on this side of the selection.');
      return report;
    }
    const item=await vscode.window.showQuickPick(direction.events.map(event=>({label:event.name,
      description:event.kind+' · '+sourceLabel(event),detail:event.method,event})),
      {title:direction.label+' · Java Call Flow',matchOnDescription:true,matchOnDetail:true});
    if (item) await operation('Verify Java Call Source Link',cancellation=>revealCallFlow(report,item.event.id,{cancellation}));
    return report;
  }

  async function showStructuralSearch() {
    const state = await operation('Find Java Projects',projects);
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const scopes = state.projects.flatMap(project => {
      const item = {label:project.name,description:'Production sources',projectUri:project.uri};
      if (!localFile(activeUri) || !project.sourceRoots.some(root => !root.unavailable && inside(root.path,activeUri.fsPath))) return [item];
      return [item,{...item,description:'Current file',uri:activeUri,fileOnly:true}];
    });
    if (!scopes.length) throw Error('Import a Java classpath project before structural search.');
    const scope = await vscode.window.showQuickPick(scopes,{title:'Java Structural Search · Scope'});
    if (!scope) return;
    const choice = await vscode.window.showQuickPick([
      {label:'Expression',description:'An invocation, operator or other Java expression',mode:'expression'},
      {label:'Statement',description:'A return, expression statement, conditional or other supported statement',mode:'statement'}
    ],{title:'Java Structural Search · Template'});
    if (!choice) return;
    const pattern = await vscode.window.showInputBox({title:'Search Template',prompt:'Use $name$ to capture a Java expression.',
      placeHolder:choice.mode === 'expression' ? 'Math.min($value$, 0)' : 'return $value$;'});
    if (pattern === undefined) return;
    const types = await vscode.window.showInputBox({title:'Capture Types',prompt:'Optional. Use name=Type or name<:Type, separated by commas.',
      placeHolder:'value=int, text<:java.lang.CharSequence'});
    if (types === undefined) return;
    const replacement = await vscode.window.showInputBox({title:'Replacement Template',prompt:'Leave blank to search without replacement.'});
    if (replacement === undefined) return;
    const report = await operation('Match Java Structures',cancellation => structuralSearch({
      ...scope,mode:choice.mode,pattern,replacement:replacement.trim() ? replacement : undefined,
      constraints:parseCaptureConstraints(types),cancellation
    }));
    if (!report.matches.length) {
      await vscode.window.showInformationMessage('No Java structures matched the template.');
      return report;
    }
    const label = report.matches.length + (report.truncated ? '+' : '') + ' Java Structural Matches';
    const resultItem = match => ({
      label:match.snippet.replace(/\s+/g,' '),
      description:vscode.workspace.asRelativePath(vscode.Uri.parse(match.uri)) + ':' + (match.range.start.line + 1),
      detail:match.blocked || match.captures.map(capture => '$' + capture.name + '$ · ' + capture.type).join(', '),
      match
    });
    const replaceable = report.matches.filter(match => match.replacement !== undefined);
    const actions = [{label:'Go to Match',action:'reveal'}];
    if (replaceable.length) actions.push({label:'Review Selected Replacements',description:replaceable.length + ' available',action:'replace'});
    const action = await vscode.window.showQuickPick(actions,{title:label});
    if (!action) return report;
    if (action.action === 'replace') {
      const chosen = await vscode.window.showQuickPick(replaceable.map(resultItem),{title:label,canPickMany:true});
      if (chosen?.length) {
        const plan = await operation('Check Java Structural Replacements',cancellation =>
          prepareStructuralReplacement(report,chosen.map(item => item.match.id),{cancellation}));
        await java.refactoring.review(plan);
      }
    } else {
      const item = await vscode.window.showQuickPick(report.matches.map(resultItem),{title:label,matchOnDescription:true});
      if (item) await reveal(report,item.match);
    }
    return report;
  }

  const extraction = createInterfaceExtraction(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const hierarchy = createMemberHierarchy(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const conversion = createJavaConversion(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const constant = createConstantExtraction(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const values = createValueExtraction(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const inline = createMethodInline(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const methodExtraction = createMethodExtraction(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const typeImport = createTypeImport(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const staticImport = createTypeImport(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation,staticMember:true
  });
  const cleanup=createJavaCleanup(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
  });
  const completion=createExpectedCompletion(vscode,{
    java,assertReady,projects,findProject,classSources,classpaths,compile,assertUnchangedSourceSnapshots,operation
  });
  const qualifierCompletion=registerQualifierCompletion(vscode,{
    java,projects,findProject,classSources,compile,assertUnchangedSourceSnapshots,managed
  });
  const typedStructure = createTypedFileStructure(vscode,{
    java,assertReady,projects,findProject,classSources,compile,snapshot,assertUnchangedSourceSnapshots
  });
  const structureRegistration = java.structure.registerJavaInspection({
    inspect:options => managed(() => typedStructure.inspect(options)),
    reveal:(report,id) => managed(() => typedStructure.reveal(report,id))
  });
  const constantPreparation = java.refactoring.registerConstantPreparation(async options => {
    const report = await constant.inspect(options);
    return constant.prepare(report,{cancellation:options.cancellation});
  });
  const commands = Object.entries({diagram:showProjectDiagram,flow:showTrace,callFlow:showCallTrace,structural:showStructuralSearch,
    extractInterface:extraction.run,pullUp:hierarchy.pullUp,pushDown:hierarchy.pushDown,convert:conversion.run,
    extractConstant:constant.run,extractVariable:anchor => values.run('local',anchor),extractField:anchor => values.run('field',anchor)}).map(([kind,run]) =>
    vscode.commands.registerCommand(COMMANDS[kind],async anchor => {
      try { assertReady(); return await run(kind.startsWith('extract') && kind !== 'extractInterface' ? anchor : undefined); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message); return null; }
    }));
  commands.push(vscode.commands.registerCommand(COMMANDS.cleanup,async()=>{
    try { assertReady(); return await cleanup.run(); }
    catch(error) { if(!disposed)void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);return null; }
  }));
  commands.push(vscode.commands.registerCommand(COMMANDS.expectedCompletion,async()=>{
    try { assertReady(); return await completion.run(); }
    catch(error) { if(!disposed)void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);return null; }
  }));
  return {
    diagram:options => managed(() => diagram(options)),trace:options => managed(() => trace(options)),
    traceCalls:options=>managed(()=>traceCalls(options)),
    selectCallContext:(report,id,options)=>managed(()=>selectCallContext(report,id,options)),
    revealCallFlow:(report,id,options)=>managed(()=>revealCallFlow(report,id,options)),
    refreshDiagram:(report,options)=>managed(()=>refreshDiagram(report,options)),
    revealRelationship:(report,id,origin,options)=>managed(()=>revealRelationship(report,id,origin,options)),
    structuralSearch:options => managed(() => structuralSearch(options)),
    prepareStructuralReplacement:(report,ids,options) => managed(() => prepareStructuralReplacement(report,ids,options)),
    inspectInterface:options => managed(() => extraction.inspect(options)),
    prepareInterfaceExtraction:(report,options) => managed(() => extraction.prepare(report,options)),
    inspectMemberHierarchy:options => managed(() => hierarchy.inspect(options)),
    prepareMemberHierarchyMove:(report,options) => managed(() => hierarchy.prepare(report,options)),
    prepareConversion:options => managed(() => conversion.prepare(options)),
    inspectConstant:options => managed(() => constant.inspect(options)),
    prepareConstantExtraction:(report,options) => managed(() => constant.prepare(report,options)),
    inspectValueExtraction:options => managed(() => values.inspect(options)),
    prepareValueExtraction:(report,options) => managed(() => values.prepare(report,options)),
    prepareInlineMethod:options => managed(() => inline.prepare(options)),
    prepareMethodExtraction:options => managed(() => methodExtraction.prepare(options)),
    inspectTypeImport:options => managed(() => typeImport.inspect(options)),
    prepareTypeImport:(report,options) => managed(() => typeImport.prepare(report,options)),
    inspectStaticMemberImport:options => managed(() => staticImport.inspect(options)),
    prepareStaticMemberImport:(report,options) => managed(() => staticImport.prepare(report,options)),
    prepareCleanup:options => managed(() => cleanup.prepare(options)),
    inspectExpectedCompletion:options => managed(() => completion.inspect(options)),
    applyExpectedCompletion:(report,name,options) => managed(() => completion.apply(report,name,options)),
    streamTrace,
    reveal,showDiagram,exportMermaid,
    dispose() {
      if (stopping) return stopping;
      disposed = true;
      streamTrace.dispose();
      constantPreparation.dispose();
      qualifierCompletion.dispose();
      inline.dispose();
      methodExtraction.dispose();
      typeImport.dispose();
      staticImport.dispose();
      structureRegistration.dispose();
      for (const entry of [...panels,...commands]) entry.dispose();
      stopping = Promise.allSettled(active).then(() => {});
      return stopping;
    }
  };
}

module.exports = { registerJavaSourceAnalysis, COMMANDS };
