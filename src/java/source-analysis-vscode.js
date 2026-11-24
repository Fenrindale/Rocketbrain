'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { analyzeJavaSources } = require('./signature-compiler');
const { inside, local } = require('./workbench-model');
const { classDiagram,mermaidDiagram,dataFlow } = require('./source-analysis-model');
const { diagramHtml } = require('./source-diagram-view');

const COMMANDS = Object.freeze({
  diagram:'rocketbrain.java.showClassDiagram', flow:'rocketbrain.java.traceDataFlow'
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
  const snapshotByReport = new WeakMap(), active = new Set(), panels = new Set();
  let disposed = false, stopping;

  function assertReady(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before compiler-backed Java analysis.');
    if (cancellation?.isCancellationRequested) throw Error('Java analysis cancelled.');
  }

  function dirty(uri) {
    return vscode.workspace.textDocuments.some(document => localFile(document.uri) &&
      !path.relative(document.uri.fsPath,uri.fsPath) && document.isDirty);
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
    return { javaHome:state.javaHome,projects };
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

  async function snapshot(uri,cancellation) {
    assertReady(cancellation);
    if (!localFile(uri) || !vscode.workspace.getWorkspaceFolder(uri) || !uri.fsPath.toLowerCase().endsWith('.java') || dirty(uri)) {
      throw Error('Save each Java source before compiler analysis.');
    }
    return fileContent(uri);
  }

  async function classSources(project,cancellation) {
    const production = project.sourceRoots.filter(root => !root.unavailable &&
      !/(?:^|[\\/])src[\\/](?:test|testFixtures|integrationTest)[\\/]/i.test(root.path));
    if (!production.length) throw Error('Import a production Java source root for the class diagram.');
    const root = vscode.Uri.parse(project.uri);
    const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(root,'**/*.java'),EXCLUDE,MAX_UNITS + 1,cancellation);
    if (candidates.length > MAX_UNITS) throw Error('Class diagrams support at most 240 Java files per imported project.');
    const sources = [];
    let total = 0;
    for (const uri of candidates) {
      if (!localFile(uri) || !production.some(root => inside(root.path,uri.fsPath))) continue;
      if (path.basename(uri.fsPath) === 'module-info.java') throw Error('Class diagrams currently inspect named declarations in classpath projects.');
      const file = await snapshot(uri,cancellation);
      if ((total += file.bytes) > 8 * 1024 * 1024) throw Error('Class diagram source inputs exceed 8 MiB.');
      sources.push(file);
    }
    return sources;
  }

  async function compile(state,project,sources,inspection,cancellation) {
    if (!sources.length) throw Error('No saved Java source was found in this scope.');
    const classpath = await classpaths(project,cancellation);
    const compliance = /^(?:1\.)?(\d+)$/.exec(String(project.compliance || ''))?.[1];
    const report = await analyzeJavaSources({
      javaHome:state.javaHome,classpath,release:Number(compliance || 25),storagePath,cancellation,
      sources:sources.map(({uri,text}) => ({uri,text})),manifestLimit:256*1024,inspection
    });
    if (report.errors.length) throw Error('Resolve Java compiler errors before analysis: ' + report.errors[0].message);
    for (const source of sources) {
      const saved = await snapshot(vscode.Uri.parse(source.uri),cancellation);
      if (saved.sha !== source.sha) throw Error('Java source changed during analysis. Run it again.');
    }
    assertReady(cancellation);
    return report;
  }

  async function diagram({ projectUri,uri,cancellation } = {}) {
    const state = await projects(cancellation);
    const project = findProject(state.projects,uri,projectUri);
    const sources = await classSources(project,cancellation);
    const compiler = await compile(state,project,sources,{kind:'diagram'},cancellation);
    const report = { ...classDiagram(compiler,sources),project:project.name,sourceFiles:sources.length,projectUri:project.uri };
    if (!report.localCount) throw Error('The compiler found no Java class declarations in this scope.');
    snapshotByReport.set(report,new Map(sources.map(item => [item.uri,item.sha])));
    return report;
  }

  async function trace({ document,position,cancellation }) {
    if (!document || document.languageId !== 'java' || document.isClosed || !position) {
      throw Error('Place the cursor on a saved Java value to trace it.');
    }
    const version = document.version;
    const source = await snapshot(document.uri,cancellation);
    const lines = source.text.split('\n');
    if (position.line < 0 || position.line >= lines.length || position.character < 0 ||
        position.character > lines[position.line].replace(/\r$/,'').length) throw Error('Choose a cursor within the saved Java source.');
    const offset = lines.slice(0,position.line).reduce((sum,line) => sum + line.length + 1,position.character);
    const state = await projects(cancellation);
    const project = findProject(state.projects,document.uri);
    const compiled = await compile(state,project,[source],{kind:'dataflow',uri:source.uri,offset},cancellation);
    if (document.isClosed || document.version !== version) throw Error('The selected Java editor changed during tracing.');
    const result = dataFlow(compiled,source,offset);
    snapshotByReport.set(result,new Map([[source.uri,source.sha]]));
    return result;
  }

  const range = value => new vscode.Range(value.start.line,value.start.character,value.end.line,value.end.character);
  async function reveal(report,item) {
    assertReady();
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
    return vscode.window.showTextDocument(document,{preview:true,selection});
  }

  async function exportMermaid(report,destination,{external = true} = {}) {
    assertReady();
    if (!snapshotByReport.has(report) || !Array.isArray(report.nodes) || !localFile(destination) ||
        path.extname(destination.fsPath).toLowerCase() !== '.mmd') throw Error('Choose a local .mmd file for this class diagram.');
    const parent = path.dirname(destination.fsPath);
    if (path.relative(parent,await fs.realpath(parent))) throw Error('Choose a physical directory for the Mermaid diagram.');
    try { await fs.writeFile(destination.fsPath,mermaidDiagram(report,{external}),{flag:'wx',encoding:'utf8'}); }
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

  function showDiagram(initial) {
    assertReady();
    if (!snapshotByReport.has(initial) || !Array.isArray(initial.nodes)) throw Error('Analyze a saved Java project first.');
    let report = initial, external = true, focus = '', closed = false, refreshing = false;
    const panel = vscode.window.createWebviewPanel('rocketbrainJavaClassDiagram','Java Class Diagram',
      vscode.ViewColumn.Beside,{enableScripts:true,localResourceRoots:[]});
    panels.add(panel);
    const render = () => { if (!closed) panel.webview.html = diagramHtml(report,{focus,external}); };
    render();
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (closed || !message || !['source','options','refresh','export'].includes(message.type)) return;
      try {
        assertReady();
        if (message.type === 'source') {
          const type = report.nodes.find(item => item.id === message.node && !item.external);
          if (!type) return;
          const target = message.member === undefined ? type.location :
            Number.isInteger(message.member) && message.member >= 0 ? type.members[message.member]?.location : null;
          if (target) await reveal(report,target);
        } else if (message.type === 'options') {
          if (typeof message.external !== 'boolean' ||
              (message.focus !== '' && !report.nodes.some(node => !node.external && node.id === message.focus))) return;
          external = message.external;
          focus = message.focus;
          render();
        } else if (message.type === 'refresh' && !refreshing) {
          refreshing = true;
          try {
            report = await operation('Refresh Java Class Diagram',
              cancellation => diagram({projectUri:report.projectUri,cancellation}));
            if (focus && !report.nodes.some(node => node.id === focus)) focus = '';
            render();
          } finally { refreshing = false; }
        } else if (message.type === 'export') {
          const file = await vscode.window.showSaveDialog({title:'Export Java Class Diagram',filters:{Mermaid:['mmd']},
            defaultUri:vscode.Uri.joinPath(vscode.Uri.parse(report.projectUri),'class-diagram.mmd')});
          if (file) await exportMermaid(report,file,{external});
        }
      } catch (error) {
        if (!closed && !disposed) await vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message);
      }
    });
    const changes = vscode.workspace.onDidChangeTextDocument(event => {
      if (!closed && snapshotByReport.get(report)?.has(event.document.uri.toString()) && event.contentChanges.length) {
        void panel.webview.postMessage({type:'stale'});
      }
    });
    panel.onDidDispose(() => {
      closed = true;
      messages.dispose();
      changes.dispose();
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

  const commands = Object.entries({diagram:showProjectDiagram,flow:showTrace}).map(([kind,run]) =>
    vscode.commands.registerCommand(COMMANDS[kind],async () => {
      try { assertReady(); return await run(); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message); return null; }
    }));
  return {
    diagram:options => managed(() => diagram(options)),trace:options => managed(() => trace(options)),
    reveal,showDiagram,exportMermaid,
    dispose() {
      if (stopping) return stopping;
      disposed = true;
      for (const entry of [...panels,...commands]) entry.dispose();
      stopping = Promise.allSettled(active).then(() => {});
      return stopping;
    }
  };
}

module.exports = { registerJavaSourceAnalysis, COMMANDS };
