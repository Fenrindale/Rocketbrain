'use strict';
const path = require('node:path');
const { resolveLaunch, serverSettings } = require('./runtime');
const { registerSpringFeatures } = require('./spring');
const { registerJavaDebugger } = require('./debug');

function registerJavaFeatures(context, vscode) {
  const output = vscode.window.createOutputChannel('Rocketbrain Java', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 29);
  status.command = 'rocketbrain.javaSupport';
  let client, debuggerController, disposing, disposed = false, configuring = false, installing = false, pending = Promise.resolve();
  let state = { state: 'stopped', message: 'Java server is stopped.' };
  const subscriptions = [output, status];
  const spring = registerSpringFeatures(vscode, context, output);
  subscriptions.push(spring);
  function update(next, message) {
    state = { ...state, state: next, message };
    status.text = `$(coffee) Rocketbrain Java · ${next === 'running' ? 'Ready' : next === 'starting' ? 'Starting' : next === 'configuration-required' ? 'Setup' : next}`;
    status.tooltip = message; status.show(); output.appendLine(`${next}: ${message}`);
  }
  const serial = action => { const run = pending.then(action, action); pending = run.catch(() => {}); return run; };
  async function stopNow() {
    await api.workbench?.stop();
    await debuggerController?.stopSessions();
    const previous = client; client = undefined;
    if (previous) await previous.stop(5000).catch(error => output.appendLine(`Java shutdown: ${error.message}`));
    if (!disposed) update('stopped', 'Java server is stopped.');
  }
  async function startNow() {
    if (disposed || client) return { ...state };
    const config = vscode.workspace.getConfiguration('rocketbrain.java');
    if (!config.get('enabled', true)) { update('disabled', 'Enable rocketbrain.java.enabled to start Java support.'); return { ...state }; }
    if (!vscode.workspace.isTrusted) { update('restricted', 'Java project import requires a trusted workspace.'); return { ...state }; }
    if (!config.get('serverPath') || !config.get('javaHome')) { update('configuration-required', 'Set rocketbrain.java.serverPath to an extracted official JDT LS distribution and rocketbrain.java.javaHome to an independent JDK 25+.'); return { ...state }; }
    try {
      const storage = context.storageUri || context.globalStorageUri;
      const gradleAnnotationProcessing = config.get('annotationProcessing.gradleEnabled',false) === true;
      const launch = resolveLaunch({
        serverPath:config.get('serverPath'),javaHome:config.get('javaHome'),debugBundlePath:config.get('debugBundlePath'),
        storagePath:path.join(storage.fsPath,'java'),trustedWorkspace:vscode.workspace.isTrusted,
        lombokJar:config.get('annotationProcessing.lombokJar',''),gradleAnnotationProcessing,
        cacheContext:{projectJdks:config.get('projectJdks',[]),gradleHome:config.get('gradleHome',''),gradleJavaHome:config.get('gradleJavaHome','')}
      });
      const extractInterfaceReplaceUsages = config.get('extractInterface.replaceUsages', false) === true;
      const settings = serverSettings(config.get('projectJdks', []), { gradleHome: config.get('gradleHome'),
        gradleJavaHome: config.get('gradleJavaHome'),extractInterfaceReplaceUsages,gradleAnnotationProcessing });
      const { LanguageClient, ErrorAction, CloseAction } = require('vscode-languageclient/node');
      const watcher = vscode.workspace.createFileSystemWatcher('**/{*.java,pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,gradle.properties}');
      subscriptions.push(watcher);
      const next = new LanguageClient('rocketbrain-java', 'Rocketbrain Java', { command: launch.command, args: launch.args, options: launch.options }, {
        documentSelector: [{ scheme: 'file', language: 'java' }],
        outputChannel: output,
        initializationOptions: { bundles: launch.bundles, workspaceFolders: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()), settings, extendedClientCapabilities: { progressReportProvider: true, classFileContentsSupport: true, overrideMethodsPromptSupport: false, hashCodeEqualsPromptSupport: false, advancedOrganizeImportsSupport: false,advancedExtractRefactoringSupport:false } },
        synchronize: { fileEvents: watcher },
        errorHandler: { error: () => ({ action: ErrorAction.Continue }), closed: () => { if (!disposed) { client = undefined; update('error', 'Java server exited. Check Rocketbrain Java output, then restart.'); } return { action: CloseAction.DoNotRestart }; } },
        markdown: { isTrusted: false }
      });
      state = { ...state, serverPath: launch.serverPath, javaHome: launch.javaHome, debugBundlePath: launch.bundles[0], runtimeIdentity: launch.identity,
        workspaceData: launch.data,extractInterfaceReplaceUsages,annotationProcessing:launch.annotationProcessing };
      client = next; update('starting', 'Starting the independent Eclipse JDT Language Server.');
      next.onNotification('language/status', event => { if (event.type === 'Error') output.appendLine(`JDT LS: ${event.message}`); else output.appendLine(`JDT LS ${event.type}: ${event.message}`); });
      next.onNotification('language/progressReport', event => { status.tooltip = `Java: ${event.task || ''} ${event.subTask || ''}`; });
      await next.start();
      await next.sendNotification('workspace/didChangeConfiguration', { settings });
      const processing = launch.annotationProcessing;
      output.appendLine('Java editor annotation processing: Maven follows the POM, Gradle processor sync '+
        (processing.gradle ? 'enabled' : 'disabled')+', Lombok editor agent '+(processing.lombok?.version || 'disabled')+'.');
      update('running', 'Eclipse JDT LS is connected. Java completion, diagnostics, navigation and rename use this engine. Spring endpoints/settings currently use Rocketbrain source analysis, not Spring LS.');
    } catch (error) {
      const failed = client; client = undefined;
      if (failed) await failed.stop(1000).catch(() => {});
      update('error', error.message); throw error;
    }
    return { ...state };
  }
  const api = {
    start: () => serial(startNow),
    stop: () => serial(stopNow),
    restart: () => serial(async () => { await stopNow(); return startNow(); }),
    getState: () => ({ ...state, springMode: 'local-semantic-index', springLimit: 'Local source/configuration model; runtime and custom Conditions remain unknown. This is not the full Spring Language Server.' }),
    executeWorkspaceCommand: async (command, ...args) => {
      await api.start();
      if (!client || state.state !== 'running') throw new Error(state.message);
      return client.sendRequest('workspace/executeCommand', { command, arguments: args });
    },
    requestWorkspaceCommand: async(command,args,cancellation)=>{await api.start();if(!client||state.state!=='running')throw new Error(state.message);return client.sendRequest('workspace/executeCommand',{command,arguments:args},...(cancellation?[cancellation]:[]));},
    buildWorkspace: async (cancellation,{refreshTestSources=false}={}) => {
      await api.start();if(!client||state.state!=='running')throw new Error(state.message);
      if(refreshTestSources){
        // Reopen saved test units through the public document lifecycle so files added while
        // the server was stopped are present in a reused Eclipse workspace before building.
        const sources=await vscode.workspace.findFiles('**/src/test/**/*.java','**/{node_modules,.git,build,target,bin,out,.gradle}/**',501);
        if(sources.length>500)throw new Error('Configure explicit compiled test profiles for more than 500 Java test source files.');
        for(const uri of sources){if(cancellation?.isCancellationRequested)throw new Error('Java test preparation cancelled.');if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before loading test sources.');await vscode.workspace.openTextDocument(uri);}
      }
      if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before building Java tests.');
      return client.sendRequest('java/buildWorkspace',refreshTestSources,...(cancellation?[cancellation]:[]));
    },
    spring,
    dispose() {
      if (!disposing) {
        disposed = true;
        disposing = serial(async()=>{await api.workbench?.dispose();await api.groovy?.dispose();await api.quarkus?.dispose();await api.jakarta?.dispose();await api.micronaut?.dispose();await api.scala?.dispose();await api.kotlinMultiplatform?.dispose();await api.move?.dispose();await api.memberMove?.dispose();await api.changeSignature?.dispose();await api.safeDelete?.dispose();await api.refactoring?.dispose();await stopNow();}).finally(() => { for (const item of subscriptions) item.dispose(); });
      }
      return disposing;
    }
  };
  const refactoringRequest=async(method,params,cancellation)=>{
    if(!['textDocument/codeAction','codeAction/resolve','textDocument/documentSymbol','textDocument/definition','textDocument/references','workspace/willRenameFiles','java/getChangeSignatureInfo','java/getRefactorEdit','java/move','java/getMoveDestinations'].includes(method)&&!(method==='workspace/executeCommand'&&['java.project.getClasspaths','java.project.getSettings','java.project.getAll'].includes(params?.command)))throw new Error('Unsupported Java refactoring request.');
    await api.start();if(!vscode.workspace.isTrusted||!client||state.state!=='running')throw new Error('Start Java support in a trusted workspace before refactoring.');
    return client.sendRequest(method,params,...(cancellation?[cancellation]:[]));
  };
  debuggerController = registerJavaDebugger(vscode,api,output,refactoringRequest);
  api.debug = debuggerController;
  subscriptions.push(debuggerController);
  api.refactoring=require('./refactoring').registerJavaRefactoring(context,vscode,{request:refactoringRequest});
  subscriptions.push(api.refactoring);
  api.interfaceRefactoring={
    async members(params,cancellation){
      await api.start();
      if(!vscode.workspace.isTrusted||!client||state.state!=='running')throw Error('Start Java support in a trusted workspace to inspect interface members.');
      return client.sendRequest('java/checkExtractInterfaceStatus',params,...(cancellation?[cancellation]:[]));
    },
    edit:(params,cancellation)=>refactoringRequest('java/getRefactorEdit',params,cancellation)
  };
  const refactoringRuntime=()=>({javaHome:api.getState().javaHome,storagePath:(context.storageUri||context.globalStorageUri).fsPath});
  const synchronizeRefactoringFiles=async changes=>{
    if(!vscode.workspace.isTrusted||!Array.isArray(changes)||!changes.length||changes.length>2)throw Error('Invalid Java resource synchronization.');
    const fs=require('node:fs');
    for(const change of changes){const uri=vscode.Uri.parse(change.uri);if(uri.scheme!=='file'||uri.query||uri.fragment||!uri.fsPath.endsWith('.java')||!vscode.workspace.getWorkspaceFolder(uri)||![1,2,3].includes(change.type))throw Error('Java resource synchronization must remain within the reviewed workspace.');const exists=fs.existsSync(uri.fsPath);if(exists!== (change.type!==3)||exists&&!fs.lstatSync(uri.fsPath).isFile())throw Error('Java resource synchronization must describe the current file state.');}
    await api.start();if(!vscode.workspace.isTrusted||!client||state.state!=='running')throw Error('Start Java support before synchronizing reviewed resources.');
    await client.sendNotification('workspace/didChangeWatchedFiles',{changes});
  };
  api.move=require('./move').registerJavaMove(context,vscode,{request:refactoringRequest,refactoring:api.refactoring,runtime:refactoringRuntime,synchronizeFiles:synchronizeRefactoringFiles});
  api.memberMove=require('./member-move').registerJavaMemberMove(context,vscode,{request:refactoringRequest,refactoring:api.refactoring,runtime:refactoringRuntime,synchronizeFiles:synchronizeRefactoringFiles});
  api.changeSignature=require('./change-signature').registerJavaChangeSignature(context,vscode,{request:refactoringRequest,refactoring:api.refactoring,getJavaHome:()=>api.getState().javaHome});
  api.safeDelete=require('./safe-delete').registerJavaSafeDelete(context,vscode,{request:refactoringRequest,refactoring:api.refactoring});
  subscriptions.push(api.move,api.memberMove,api.changeSignature,api.safeDelete);
  api.workbench=require('./workbench').registerJavaWorkbench(context,vscode,api,output);
  subscriptions.push(api.workbench);
  api.groovy=require('./groovy-vscode').registerGroovyWorkbench(vscode,api);
  api.quarkus=require('./quarkus-vscode').registerQuarkusWorkbench(vscode,api);
  api.jakarta=require('./jakarta-vscode').registerJakartaWorkbench(vscode,api);
  api.micronaut=require('./micronaut-vscode').registerMicronautWorkbench(vscode,api);
  api.scala=require('./scala-vscode').registerScalaWorkbench(context,vscode,api);
  api.kotlinMultiplatform=require('./kmp-vscode').registerKmpWorkbench(vscode,api);
  async function installEngine() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before installing and starting the Java engine.');
    if (installing) throw new Error('Java engine installation is already running.');
    installing = true;
    try {
      const { provision } = require('../../scripts/java-provision');
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rocketbrain · Install and configure Java engine', cancellable: false }, progress => provision({
        target: path.join(context.globalStorageUri.fsPath, 'java-engine'),
        onProgress(message) { output.appendLine(message); progress.report({ message }); }
      }));
      configuring = true;
      try {
        const config = vscode.workspace.getConfiguration('rocketbrain.java');
        await config.update('javaHome', result.settings['rocketbrain.java.javaHome'], vscode.ConfigurationTarget.Global);
        await config.update('serverPath', result.settings['rocketbrain.java.serverPath'], vscode.ConfigurationTarget.Global);
        await config.update('debugBundlePath', result.settings['rocketbrain.java.debugBundlePath'], vscode.ConfigurationTarget.Global);
        await config.update('enabled', true, vscode.ConfigurationTarget.Global);
      } finally { configuring = false; }
      const info = await api.restart();
      vscode.window.showInformationMessage(info.state === 'running' ? 'Rocketbrain Java engine is installed and connected.' : info.message);
      return info;
    } finally { installing = false; }
  }
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('jdt', {
    async provideTextDocumentContent(uri, token) {
      await api.start();
      if (!client || token.isCancellationRequested) return '';
      return client.sendRequest('java/classFileContents', { uri: uri.toString() }, token);
    }
  }));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.java.installEngine', () => installEngine().catch(error => vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`))), vscode.commands.registerCommand('rocketbrain.java.start', () => api.start().catch(error => vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`))), vscode.commands.registerCommand('rocketbrain.java.restart', () => api.restart().catch(error => vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`))), vscode.commands.registerCommand('rocketbrain.java.status', () => api.getState()), vscode.commands.registerCommand('rocketbrain.javaSupport', async () => {
    const info = api.getState();
    const selected = await vscode.window.showQuickPick([{ label: 'Install and configure Java engine', description: 'Download Eclipse JDT LS and Temurin JDK; save Java paths', action: 'install' }, { label: 'Start / restart Java server', action: 'restart' }, { label: 'Open Java settings', action: 'settings' }, { label: 'Show Java output', action: 'output' }, { label: 'Browse Spring endpoints', action: 'endpoints' }], { title: `Rocketbrain Java · ${info.state}`, placeHolder: info.message });
    if (selected?.action === 'install') await installEngine().catch(error => vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`));
    else if (selected?.action === 'restart') await api.restart().catch(error => vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`));
    else if (selected?.action === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rocketbrain-local.rocketbrain rocketbrain.java');
    else if (selected?.action === 'output') output.show();
    else if (selected?.action === 'endpoints') await vscode.commands.executeCommand('rocketbrain.spring.endpoints');
  }));
  subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void api.start().catch(error => output.appendLine(error.message)); }));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (!configuring && ['enabled', 'serverPath', 'javaHome', 'debugBundlePath', 'projectJdks', 'gradleHome', 'gradleJavaHome', 'extractInterface.replaceUsages', 'annotationProcessing.gradleEnabled', 'annotationProcessing.lombokJar'].some(key => event.affectsConfiguration(`rocketbrain.java.${key}`))) void api.restart().catch(error => output.appendLine(error.message)); }));
  update('stopped', 'Java server is stopped.');
  void api.start().catch(error => output.appendLine(error.message));
  return api;
}

module.exports = { registerJavaFeatures };
