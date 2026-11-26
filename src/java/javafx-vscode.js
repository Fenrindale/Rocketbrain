'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readFxml, resolveFxmlFile } = require('./javafx-fxml');
const { workspacePath, workspaceRoots } = require('./workbench-model');
const { buildSpec, nativeTaskRunner } = require('./workbench-tasks');
const {renderFxmlPreview}=require('./javafx-preview-runtime');

const PREVIEW='rocketbrain.javafx.preview',REFRESH='rocketbrain.javafx.refreshPreview';
const htmlText=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

function registerJavaFx(vscode, { java, context }) {
  const selector = { scheme: 'file', pattern: '**/*.fxml' };
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-fxml');
  const tasks = nativeTaskRunner(vscode);
  const disposables = [diagnostics],images=new WeakMap();
  let panel,shown,rendering;

  function root(document) {
    if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file') return null;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return folder ? workspaceRoots([folder])[0] : null;
  }

  function status(document) {
    if (!document.fileName.endsWith('.fxml') || !root(document)) return;
    try {
      diagnostics.set(document.uri, readFxml(document.getText()).diagnostics.map(record =>
        new vscode.Diagnostic(span(document, record), record.message, vscode.DiagnosticSeverity.Warning)));
    } catch (error) {
      const line = Math.max(0, Math.min(document.lineCount - 1, (Number(/^(\d+):/.exec(error.message)?.[1]) || 1) - 1));
      diagnostics.set(document.uri, [new vscode.Diagnostic(document.lineAt(line).range, error.message)]);
    }
  }

  function span(document, item) {
    return new vscode.Range(document.positionAt(item.start), document.positionAt(item.end));
  }

  async function definitions(document, position, token) {
    const workspaceRoot = root(document);
    if (!workspaceRoot || token?.isCancellationRequested) return [];
    const version = document.version;
    const offset = document.offsetAt(position);
    let data;
    try { data = readFxml(document.getText()); } catch { return []; }
    const reference = data.references.find(item => item.start <= offset && offset < item.end);
    if (!reference) return [];
    const filename = resolveFxmlFile({ filename: document.fileName, workspaceRoot, reference, controller: data.controller });
    if (!filename) return [];
    const uri = vscode.Uri.file(filename);
    if (reference.kind === 'include' || reference.kind === 'resource') {
      return [new vscode.Location(uri, new vscode.Position(0, 0))];
    }
    await java.start();
    if (token?.isCancellationRequested || document.version !== version || !root(document)) return [];
    await vscode.workspace.openTextDocument(uri);
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    if (token?.isCancellationRequested || document.version !== version || !root(document)) return [];
    const typeName = data.controller.value.split('.').at(-1);
    const type = (symbols || []).find(symbol => symbol.kind === vscode.SymbolKind.Class && symbol.name === typeName);
    if (!type) return [];
    const candidates = reference.kind === 'controller' ? [type] : (type.children || []).filter(symbol =>
      reference.kind === 'handler' ? symbol.kind === vscode.SymbolKind.Method && symbol.name.split('(')[0] === reference.value :
        symbol.kind === vscode.SymbolKind.Field && symbol.name === reference.value);
    return candidates.filter(symbol => symbol.selectionRange).map(symbol => new vscode.Location(uri, symbol.selectionRange));
  }

  async function build(projectUri, operation, { cancellation, allowProjectExecution } = {}) {
    if (allowProjectExecution !== true || !vscode.workspace.isTrusted || projectUri?.scheme !== 'file') {
      throw Error('Run JavaFX through an explicit action in a trusted local Maven project.');
    }
    const goals = { run: ['compile', 'javafx:run'], image: ['package', 'javafx:jlink'] };
    if (!Object.hasOwn(goals, operation)) throw Error('Choose a JavaFX run or runtime image task.');
    const roots = workspaceRoots(vscode.workspace.workspaceFolders || []);
    const folder = workspacePath(projectUri.toString(), roots);
    const pom = workspacePath(path.join(folder, 'pom.xml'), [folder], { directory: false });
    if (fs.statSync(pom).size > 1024 * 1024 || !/\bjavafx-maven-plugin\b/.test(fs.readFileSync(pom, 'utf8'))) {
      throw Error('Select a Maven module that configures the JavaFX Maven plugin.');
    }
    const config = vscode.workspace.getConfiguration('rocketbrain.java', projectUri);
    const spec = buildSpec({ root: folder, tool: 'maven', uri: projectUri.toString(), name: path.basename(folder) },
      { javaHome: config.get('javaHome'), mavenHome: config.get('mavenHome') }, goals[operation]);
    return tasks.execute(spec, { cancellation });
  }

  const dirty=file=>vscode.workspace.textDocuments.some(document=>!document.isClosed&&document.isDirty&&
    document.uri.scheme==='file'&&!path.relative(file,document.uri.fsPath));

  async function preview({document=vscode.window.activeTextEditor?.document,width,height,allowPreview,cancellation}={}) {
    const workspace=document&&root(document);
    if (!workspace||!document.fileName.endsWith('.fxml')||document.uri.authority||document.isClosed||allowPreview!==true) {
      throw Error('Choose a saved FXML document for preview in a trusted workspace.');
    }
    if (rendering) throw Error('Finish or cancel the current FXML preview.');
    const file=workspacePath(document.fileName,[workspace],{directory:false});
    const settings=vscode.workspace.getConfiguration('rocketbrain.java',document.uri);
    const javaHome=settings.get('javaHome')||java.getState().javaHome;
    const controller=new AbortController();
    const cancel=cancellation?.onCancellationRequested?.(()=>controller.abort());
    if (cancellation?.isCancellationRequested) controller.abort();
    rendering=controller;
    try {
      const {png,report}=await renderFxmlPreview({file,workspace,dirty,javaHome,width,height,
        storage:path.join(context.globalStorageUri.fsPath,'javafx-preview'),workspaceTrusted:true,allowPreview:true,cancellation:controller.signal});
      if (!root(document)||document.isDirty||controller.signal.aborted) throw Error('The FXML source changed. Refresh from the saved file.');
      const receipt=Object.freeze(report);
      images.set(receipt,{png,uri:document.uri,width:report.width,height:report.height});
      return receipt;
    } finally {
      rendering=undefined;
      cancel?.dispose();
    }
  }

  function showPreview(receipt) {
    const image=images.get(receipt);
    if (!vscode.workspace.isTrusted||!image) throw Error('Render the current FXML document before opening its preview.');
    if (!panel) {
      const view=vscode.window.createWebviewPanel('rocketbrainFxmlPreview','JavaFX FXML Preview',
        {viewColumn:vscode.ViewColumn.Beside,preserveFocus:true},
        {enableScripts:false,localResourceRoots:[],enableCommandUris:[REFRESH]});
      panel=view;
      view.onDidDispose(()=>{if(panel===view){panel=undefined;shown=undefined;}});
    }
    shown=image;
    const name=htmlText(path.basename(image.uri.fsPath));
    const omission=receipt.controllersOmitted||receipt.handlersOmitted
      ? '<p>Static view · controller and event hookups omitted</p>' : '';
    panel.webview.html='<!doctype html><html lang="en"><head><meta charset="utf-8">'+
      '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;">'+
      '<title>JavaFX FXML Preview</title><style>body{padding:18px}h1{font-size:1.2rem}img{max-width:100%;height:auto}'+
      'a{color:var(--vscode-textLink-foreground)}</style></head><body><h1>'+name+'</h1>'+omission+
      '<p><a href="command:'+REFRESH+'">Refresh Preview</a></p><img alt="Rendered JavaFX layout" width="'+receipt.width+
      '" height="'+receipt.height+'" src="data:image/png;base64,'+image.png.toString('base64')+'"></body></html>';
    return panel;
  }

  function runPreview(options) {
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Render JavaFX FXML Preview',cancellable:true},
      (_,cancellation)=>preview({...options,allowPreview:true,cancellation}));
  }

  async function refresh() {
    const active=shown;
    if (!active) throw Error('Open a JavaFX FXML preview first.');
    const document=await vscode.workspace.openTextDocument(active.uri);
    const receipt=await runPreview({document,width:active.width,height:active.height});
    if (active===shown) showPreview(receipt);
    return receipt;
  }

  function command(name,handler) {
    disposables.push(vscode.commands.registerCommand(name,async()=>{
      try {return await handler();}
      catch (error) {void vscode.window.showErrorMessage(error.message);}
    }));
  }
  command(PREVIEW,async()=>{
    const receipt=await runPreview({});
    showPreview(receipt);
    return receipt;
  });
  command(REFRESH,refresh);
  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{rendering?.abort();panel?.dispose();}));

  disposables.push(vscode.languages.registerDefinitionProvider(selector, { provideDefinition: definitions }));
  disposables.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols(document) {
      if (!root(document)) return [];
      function symbol(node) {
        const selection = new vscode.Range(document.positionAt(node.start + 1), document.positionAt(node.start + node.name.length + 1));
        const item = new vscode.DocumentSymbol(node.name, node.id || '', vscode.SymbolKind.Object, span(document, node), selection);
        item.children = node.children.map(symbol);
        return item;
      }
      try { return readFxml(document.getText()).elements.map(symbol); } catch { return []; }
    }
  }));
  disposables.push(vscode.workspace.onDidOpenTextDocument(status));
  disposables.push(vscode.workspace.onDidSaveTextDocument(status));
  disposables.push(vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)));
  vscode.workspace.textDocuments.forEach(status);

  disposables.push(vscode.commands.registerCommand('rocketbrain.javafx.build', async () => {
    try {
      const active = vscode.window.activeTextEditor?.document.uri;
      const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
      const selection = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, defaultUri: folder?.uri, title: 'Select JavaFX Maven Module' });
      if (!selection?.length) return;
      const mode = await vscode.window.showQuickPick([{ label: 'Run JavaFX application', value: 'run' },
        { label: 'Build JavaFX runtime image', value: 'image' }], { title: 'JavaFX Maven Task' });
      if (!mode) return;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: mode.label, cancellable: true }, (_, cancellation) => build(selection[0], mode.value, {
        cancellation, allowProjectExecution: true
      }));
      if (!result.cancelled && result.code !== 0) await vscode.window.showErrorMessage('JavaFX Maven task failed. See the Rocketbrain task terminal.');
    } catch (error) {
      await vscode.window.showErrorMessage(error.message);
    }
  }));

  return { definitions, build, preview, showPreview, refresh, async dispose() {
    rendering?.abort();panel?.dispose();
    await tasks.dispose();disposables.forEach(item=>item.dispose());
  } };
}

module.exports = { registerJavaFx };
