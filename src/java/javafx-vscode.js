'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readFxml, resolveFxmlFile } = require('./javafx-fxml');
const { inside, cancelled, buildFingerprint, workspacePath, workspaceRoots } = require('./workbench-model');
const { buildSpec, nativeTaskRunner } = require('./workbench-tasks');
const { readModule, planImage, observeImage } = require('./javafx-gradle-image');
const { renderFxmlPreview } = require('./javafx-preview-runtime');
const { captureFxmlPreview } = require('./javafx-preview-fxml');
const { registerFxmlCompletion } = require('./javafx-completion');
const { REFRESH, EDIT, APPLY, DISCARD, commandUris, previewHtml } = require('./javafx-preview-panel');

const PREVIEW = 'rocketbrain.javafx.preview';

function registerJavaFx(vscode, { java, context }) {
  const selector = { scheme: 'file', pattern: '**/*.fxml' };
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-fxml');
  const completion = registerFxmlCompletion(vscode, java, selector);
  const tasks = nativeTaskRunner(vscode);
  const disposables = [diagnostics,completion],images=new WeakMap();
  let panel, shown, rendering, pending, applying;

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

  function checkBuildContext(folder, cancellation) {
    if (!vscode.workspace.isTrusted || cancelled(cancellation)) throw Error('JavaFX build cancelled or workspace trust changed.');
    workspacePath(folder, workspaceRoots(vscode.workspace.workspaceFolders || []));
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
        inside(folder, document.uri.fsPath))) throw Error('Save the JavaFX project files before building its runtime image.');
  }

  async function gradleImage(projectUri, folder, cancellation) {
    checkBuildContext(folder, cancellation);
    const module = readModule(folder), fingerprint = buildFingerprint(folder);
    const options = { projectUri: projectUri.toString(), cancellation, allowProjectExecution: true };
    if (!java.workbench.getSnapshot().projects.some(project => !path.relative(folder, project.root))) {
      await java.workbench.resyncProject(options);
    }
    checkBuildContext(folder, cancellation);
    const discovered = await java.workbench.discoverTasks({ ...options, includeJavafxImages: true });
    const task = discovered.find(item => item.tool === 'gradle' && item.name === ':jlink' &&
      item.provenance === 'gradle-observed-task');
    if (!task?.javafxImage) {
      throw Error('Select a Gradle application with the OpenJFX and Badass JLink plugins and one local :jlink image.');
    }
    checkBuildContext(folder, cancellation);
    function checkReviewedBuild() {
      if (buildFingerprint(folder) !== fingerprint || readModule(folder).sha256 !== module.sha256) {
        throw Error('JavaFX build inputs changed. Review the runtime image again.');
      }
    }
    checkReviewedBuild();
    const plan = planImage(folder, module, task.javafxImage);
    const result = await java.workbench.runTask({ ...options, taskId: task.id });
    if (result.state !== 'succeeded') {
      return { ...result, code: result.exitCode, cancelled: result.state === 'cancelled' };
    }
    checkBuildContext(folder, cancellation);
    checkReviewedBuild();
    return { ...result, code: result.exitCode, cancelled: false, image: observeImage(folder, plan) };
  }

  async function build(projectUri, operation, { cancellation, allowProjectExecution } = {}) {
    if (allowProjectExecution !== true || !vscode.workspace.isTrusted || projectUri?.scheme !== 'file') {
      throw Error('Run JavaFX through an explicit action in a trusted local project.');
    }
    const goals = { run: ['compile', 'javafx:run'], image: ['package', 'javafx:jlink'] };
    if (!Object.hasOwn(goals, operation)) throw Error('Choose a JavaFX run or runtime image task.');
    const roots = workspaceRoots(vscode.workspace.workspaceFolders || []);
    const folder = workspacePath(projectUri.toString(), roots);
    if (!fs.existsSync(path.join(folder, 'pom.xml')) &&
        ['build.gradle', 'build.gradle.kts'].some(name => fs.existsSync(path.join(folder, name)))) {
      if (operation !== 'image') throw Error('Select Build JavaFX Runtime Image for a Gradle application.');
      return gradleImage(projectUri, folder, cancellation);
    }
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

  async function render({document=vscode.window.activeTextEditor?.document,width,height,allowPreview,cancellation}={},
    { propertyEdit, expectedFingerprint } = {}) {
    const workspace=document&&root(document);
    if (!workspace||!document.fileName.endsWith('.fxml')||document.uri.authority||document.isClosed||allowPreview!==true) {
      throw Error('Choose a saved FXML document for preview in a trusted workspace.');
    }
    if (rendering) throw Error('Finish or cancel the current FXML preview.');
    const file=workspacePath(document.fileName,[workspace],{directory:false});
    const settings=vscode.workspace.getConfiguration('rocketbrain.java',document.uri);
    const javaHome=settings.get('javaHome')||java.getState().javaHome;
    const controller=new AbortController();
    const abort = () => controller.abort();
    const cancel = cancellation?.onCancellationRequested?.(abort);
    cancellation?.addEventListener?.('abort', abort, {once:true});
    if (cancellation?.isCancellationRequested || cancellation?.aborted) abort();
    rendering=controller;
    try {
      const {png,report,design}=await renderFxmlPreview({file,workspace,dirty,javaHome,width,height,
        storage:path.join(context.globalStorageUri.fsPath,'javafx-preview'),workspaceTrusted:true,allowPreview:true,
        cancellation:controller.signal,propertyEdit,expectedFingerprint});
      if (!root(document)||document.isDirty||controller.signal.aborted) throw Error('The FXML source changed. Refresh from the saved file.');
      const receipt=Object.freeze(report);
      return {receipt,png,design,file,uri:document.uri,width:report.width,height:report.height};
    } finally {
      rendering=undefined;
      cancel?.dispose();
      cancellation?.removeEventListener?.('abort', abort);
    }
  }

  async function preview(options) {
    const image = await render(options);
    images.set(image.receipt, image);
    return image.receipt;
  }

  function repaint() {
    if (panel && shown) panel.webview.html = previewHtml(shown, pending);
  }

  function showPreview(receipt) {
    const image=images.get(receipt);
    if (!vscode.workspace.isTrusted||!image) throw Error('Render the current FXML document before opening its preview.');
    if (!panel) {
      const view=vscode.window.createWebviewPanel('rocketbrainFxmlPreview','JavaFX FXML Preview',
        {viewColumn:vscode.ViewColumn.Beside,preserveFocus:true},
        {enableScripts:false,localResourceRoots:[],enableCommandUris:commandUris});
      panel=view;
      view.onDidDispose(()=>{
        if (panel !== view) return;
        panel = undefined;
        shown = undefined;
        pending = undefined;
        rendering?.abort();
      });
    }
    pending = undefined;
    shown = { ...image, ticket: randomUUID() };
    repaint();
    return panel;
  }

  function checkEditingSource(active, document, version) {
    const workspace = root(document);
    if (shown !== active || active.changed || !workspace || document.isClosed || document.isDirty ||
        document.version !== version || document.getText() !== active.design.sourceText ||
        path.relative(active.file, workspacePath(document.fileName, [workspace], {directory:false}))) {
      throw Error('The FXML editor or preview changed. Refresh from the saved file.');
    }
    return workspace;
  }

  async function reviewProperty({ receipt, id, property, value, allowReview, cancellation } = {}) {
    const active = shown;
    if (!active || active.receipt !== receipt || allowReview !== true || pending || applying) {
      throw Error('Choose a property from the current FXML preview.');
    }
    const document = await vscode.workspace.openTextDocument(active.uri);
    const version = document.version;
    checkEditingSource(active, document, version);
    const frame = await render({document,width:active.width,height:active.height,allowPreview:true,cancellation}, {
      propertyEdit: { id, property, value }, expectedFingerprint: active.receipt.resourcesSha256
    });
    checkEditingSource(active, document, version);
    if (pending || applying) throw Error('Finish the current FXML property review.');
    const { before, after } = frame.design.edit;
    const review = Object.freeze({ id, property, before, after, proposed: frame.receipt });
    pending = { active, frame, version, review, ticket: randomUUID() };
    repaint();
    return review;
  }

  async function applyProperty({ review, allowApply } = {}) {
    if (allowApply !== true || !pending || pending.review !== review || applying) {
      throw Error('Choose the active FXML property review before applying it.');
    }
    const { active, frame, version } = pending;
    pending = undefined;
    applying = true;
    repaint();
    try {
      const document = await vscode.workspace.openTextDocument(active.uri);
      checkEditingSource(active, document, version);
      const editor = await vscode.window.showTextDocument(document,{preview:false});
      const workspace = checkEditingSource(active, document, version);
      const disk = captureFxmlPreview(active.file, workspace, {dirty});
      if (disk.fingerprint !== active.receipt.resourcesSha256) {
        throw Error('FXML or CSS changed since preview. Refresh from the saved resource files.');
      }
      const edit = frame.design.edit;
      const changed = await editor.edit(builder => builder.replace(span(document, edit), edit.encoded));
      if (!changed) throw Error('The FXML editor rejected the reviewed property change.');
      if (shown === active) shown = { ...active, changed: true };
      return { id: edit.id, property: edit.property, value: edit.after };
    } finally {
      applying = false;
      repaint();
    }
  }

  async function pickProperty(ticket, id) {
    const active = shown;
    const target = active?.ticket === ticket && !pending && !applying && !active.changed &&
      active.design.targets.find(item => item.id === id);
    if (!target) throw Error('Choose a property from the current FXML preview.');
    const field = await vscode.window.showQuickPick(target.properties.map(item => ({
      label: item.name, description: item.value, field: item
    })), { title: 'Edit ' + target.type + ' · ' + target.id });
    if (!field) return;
    const value = await vscode.window.showInputBox({title:'Change ' + field.label,
      value:field.field.value,ignoreFocusOut:true});
    if (value === undefined) return;
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Render Proposed FXML Change',cancellable:true},
      (_,cancellation) => reviewProperty({receipt:active.receipt,id,property:field.label,value,allowReview:true,cancellation}));
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
    disposables.push(vscode.commands.registerCommand(name,async(...args)=>{
      try {return await handler(...args);}
      catch (error) {void vscode.window.showErrorMessage(error.message);}
    }));
  }
  command(PREVIEW,async()=>{
    const receipt=await runPreview({});
    showPreview(receipt);
    return receipt;
  });
  command(REFRESH,refresh);
  command(EDIT,pickProperty);
  command(APPLY,ticket => {
    if (!pending || pending.ticket !== ticket) throw Error('The FXML property review changed.');
    return applyProperty({review:pending.review,allowApply:true});
  });
  command(DISCARD,ticket => {
    if (!pending || pending.ticket !== ticket) throw Error('The FXML property review changed.');
    pending = undefined;
    repaint();
  });
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
      if (!vscode.workspace.isTrusted) throw Error('Trust the local workspace before building JavaFX.');
      const active = vscode.window.activeTextEditor?.document.uri;
      const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
      const selection = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, defaultUri: folder?.uri, title: 'Select JavaFX Maven or Gradle Project' });
      if (!selection?.length) return;
      const project = selection[0];
      if (!vscode.workspace.isTrusted || project.scheme !== 'file') throw Error('Select a trusted local JavaFX project.');
      const selectedRoot = workspacePath(project.toString(), workspaceRoots(vscode.workspace.workspaceFolders || []));
      const item = { label: 'Build JavaFX runtime image', value: 'image' };
      const choices = fs.existsSync(path.join(selectedRoot, 'pom.xml')) ?
        [{ label: 'Run JavaFX application', value: 'run' }, item] : [item];
      const mode = await vscode.window.showQuickPick(choices, { title: 'JavaFX Task' });
      if (!mode) return;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: mode.label, cancellable: true }, (_, cancellation) => build(project, mode.value, {
        cancellation, allowProjectExecution: true
      }));
      if (!result.cancelled && result.code !== 0) await vscode.window.showErrorMessage('JavaFX task failed. See the Rocketbrain task terminal.');
      if (result.image) {
        const launcher = vscode.Uri.parse(result.image.launcherUri);
        const action = await vscode.window.showInformationMessage(
          'JavaFX image built. Launcher: ' + launcher.fsPath, 'Reveal Image');
        if (action === 'Reveal Image') {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.parse(result.image.directoryUri));
        }
      }
    } catch (error) {
      await vscode.window.showErrorMessage(error.message);
    }
  }));

  return { definitions, build, preview, showPreview, refresh, reviewProperty, applyProperty, async dispose() {
    rendering?.abort();panel?.dispose();
    await tasks.dispose();disposables.forEach(item=>item.dispose());
  } };
}

module.exports = { registerJavaFx };
