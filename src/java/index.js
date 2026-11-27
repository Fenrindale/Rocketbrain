'use strict';
const path = require('node:path');
const { resolveLaunch, serverSettings, inspectServerPath } = require('./runtime');
const { desktopJavaHome, discoverDesktopJdk, inspectDesktopRuntime } = require('./desktop-runtime');
const { registerDesktopJavaSetup } = require('./desktop-setup-vscode');
const { isRocketbrainDesktop } = require('../workspace-mode');
const { registerSpringFeatures } = require('./spring');
const { registerJavaDebugger } = require('./debug');
const { ACTIONS,namedAction,editorAnchor } = require('./extraction-actions');
const { registerJavaFormatting } = require('./format-vscode');
const { registerFileStructure } = require('./file-structure-vscode');
const { resolveNullChecks, nullCheckUpdates } = require('./null-checks');
const { configureNullChecks } = require('./null-checks-vscode');
const { hash, indexScope, indexStorage, readGeneration } = require('./workspace-index');
const { registerWorkspaceIndex } = require('./workspace-index-vscode');
const { registerJavaAutostart, registerJavaDefinitionStartup, createDefinitionReadiness } = require('./startup');

function registerJavaFeatures(context, vscode) {
  const output = vscode.window.createOutputChannel('Rocketbrain Java', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 29);
  const desktop = isRocketbrainDesktop(vscode) && !vscode.env?.remoteName;
  const profileStorage = context.globalStorageUri?.scheme === 'file' ? context.globalStorageUri.fsPath : context.globalStoragePath;
  const managedEngine = path.join(profileStorage, 'java-engine');
  const config = () => vscode.workspace.getConfiguration('rocketbrain.java');
  const detectJdk = () => discoverDesktopJdk(managedEngine);
  const desktopRuntime = () => inspectDesktopRuntime(config(), managedEngine, detectJdk);
  const enginePaths = () => {
    if (desktop) {
      const { jdk, serverPath, debugBundlePath, problems } = desktopRuntime();
      return { javaHome: jdk?.path, serverPath, debugBundlePath, problems };
    }
    const settings = config();
    return { javaHome: settings.get('javaHome'), serverPath: settings.get('serverPath'), debugBundlePath: settings.get('debugBundlePath') };
  };
  let client, lastSettings, fileWatcher, debuggerController, disposing, containerOwner, definitionReadiness, epoch = 0;
  let workspaceMode, setup, autostart;
  let setupPrompted = false;
  const javaModeActive = () => !desktop || (workspaceMode !== undefined && workspaceMode !== 'datagrip');
  const canStartDesktop = () => javaModeActive() && Boolean(vscode.workspace.workspaceFolders?.length ||
    vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && ['java', 'kotlin', 'groovy'].includes(document.languageId)));
  status.command = desktop ? 'rocketbrain.java.setup' : 'rocketbrain.javaSupport';
  let disposed = false, configuring = false, installing = false, pending = Promise.resolve();
  let state = { state: 'stopped', message: 'Java server is stopped.' };
  const subscriptions = [output, status];
  const spring = registerSpringFeatures(vscode, context, output, { verifiedLocalPid: session => debuggerController?.verifiedLocalPid(session) });
  subscriptions.push(spring);
  function update(next, message) {
    state = { ...state, state: next, message };
    showStatus();
    output.appendLine(`${next}: ${message}`);
  }
  function showStatus() {
    const next = state.state;
    const indexing = next === 'running' && definitionReadiness && !definitionReadiness.isReady;
    const label = indexing ? 'Indexing' : next === 'running' ? 'Ready' : next === 'starting' ? 'Starting' :
      next === 'configuration-required' ? 'Setup' : next;
    status.text = `$(coffee) Rocketbrain Java · ${label}`;
    status.tooltip = indexing ? 'Java is connected. Wait for project indexing before navigating to definitions.' : state.message;
    if (javaModeActive()) status.show(); else status.hide();
    void vscode.commands.executeCommand('setContext', 'rocketbrain.javaEngineState', indexing ? 'indexing' : next);
    setup?.refresh();
  }
  const serial = action => { const run = pending.then(() => action(), () => action()); pending = run.catch(() => {}); return run; };
  function readNullChecks(config) {
    const selected=config.get('nullChecks');
    try { return resolveNullChecks(selected); }
    catch(error) {
      output.appendLine(`Java null checks are disabled: ${error.message}`);
      return resolveNullChecks();
    }
  }
  async function syncNullChecks() {
    if(!client?.isRunning()||!lastSettings||disposed||!vscode.workspace.isTrusted)return;
    const server=client,{profile,...nullAnalysis}=readNullChecks(vscode.workspace.getConfiguration('rocketbrain.java'));
    const next={java:{...lastSettings.java,compile:{...lastSettings.java.compile,nullAnalysis}}};
    for(const settings of nullCheckUpdates(lastSettings,next)) {
      await server.sendNotification('workspace/didChangeConfiguration',{settings});
      if(client!==server)return;
      lastSettings=settings;
    }
    state={...state,nullChecks:profile};
  }
  async function stopNow(strict = false) {
    if (!strict) {
      await api.workbench?.stop();
      await debuggerController?.stopSessions();
    }
    const previous = client; client = undefined; lastSettings = undefined;
    definitionReadiness?.stop();
    definitionReadiness = undefined;
    if (previous) await previous.stop(5000).catch(error => {
      output.appendLine(`Java shutdown: ${error.message}`);
      if (strict) {
        update('error', 'Could not confirm the Java engine stopped. Its active index files were retained.');
        throw Error(state.message);
      }
    });
    if (!disposed) update('stopped', 'Java server is stopped.');
  }
  function currentIndex() {
    if (!client?.isRunning() || state.state !== 'running') return undefined;
    return { session: epoch, generation: state.indexGeneration, runtimeIdentity: state.runtimeIdentity,
      workspaceData: state.workspaceData, applied: hash(lastSettings ?? null) };
  }
  function storedIndex() {
    const legacy = { storage: path.join((context.storageUri || context.globalStorageUri).fsPath,'java'), generation: null };
    if (vscode.env.remoteName || !context.storageUri || !vscode.workspace.workspaceFolders?.length) return legacy;
    try {
      const scope = indexScope(vscode.workspace.workspaceFolders, context.storageUri);
      const generation = readGeneration(scope, context.workspaceState);
      return { storage: indexStorage(scope, generation), generation };
    } catch (error) {
      output.appendLine('Using the original Java cache location. ' + error.message);
      return legacy;
    }
  }
  async function startNow(override) {
    if (disposed || client) return { ...state };
    if (!javaModeActive()) return { ...state, message: 'Switch to Java mode to start the Java engine.' };
    if (containerOwner) {
      update('container', 'The managed container Java session owns editor navigation and diagnostics.');
      return { ...state };
    }
    const config = vscode.workspace.getConfiguration('rocketbrain.java');
    if (!config.get('enabled', true)) { update('disabled', 'Enable rocketbrain.java.enabled to start Java support.'); return { ...state }; }
    if (!vscode.workspace.isTrusted) { update('restricted', 'Java project import requires a trusted workspace.'); return { ...state }; }
    const { javaHome, serverPath, debugBundlePath, problems } = enginePaths();
    if (!serverPath || !javaHome) {
      update('configuration-required', desktop ? problems.join(' ') || 'Open Java Setup to finish configuring the Java engine.' :
        'Set rocketbrain.java.serverPath to an extracted official JDT LS distribution and rocketbrain.java.javaHome to an independent JDK 25+.');
      return { ...state };
    }
    try {
      const index = override || storedIndex();
      const gradleAnnotationProcessing = config.get('annotationProcessing.gradleEnabled',false) === true;
      const launch = resolveLaunch({
        serverPath,javaHome,debugBundlePath,
        storagePath:index.storage,trustedWorkspace:vscode.workspace.isTrusted,
        lombokJar:config.get('annotationProcessing.lombokJar',''),gradleAnnotationProcessing,
        cacheContext:{projectJdks:config.get('projectJdks',[]),gradleHome:config.get('gradleHome',''),gradleJavaHome:config.get('gradleJavaHome','')}
      });
      const extractInterfaceReplaceUsages = config.get('extractInterface.replaceUsages', false) === true;
      const settings = serverSettings(config.get('projectJdks', []), { gradleHome: config.get('gradleHome'),
        gradleJavaHome: config.get('gradleJavaHome'),extractInterfaceReplaceUsages,gradleAnnotationProcessing,
        favoriteStaticMembers:config.get('staticImport.favorites') });
      const {profile:nullChecks,...nullAnalysis}=readNullChecks(config);
      settings.java.compile.nullAnalysis=nullAnalysis;
      const { LanguageClient, ErrorAction, CloseAction } = require('vscode-languageclient/node');
      if (!fileWatcher) {
        fileWatcher = vscode.workspace.createFileSystemWatcher('**/{*.java,pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,gradle.properties}');
        subscriptions.push(fileWatcher);
      }
      const readiness = createDefinitionReadiness();
      const next = new LanguageClient('rocketbrain-java', 'Rocketbrain Java', { command: launch.command, args: launch.args, options: launch.options }, {
        documentSelector: [{ scheme: 'file', language: 'java' }],
        outputChannel: output,
        initializationOptions: { bundles: launch.bundles, workspaceFolders: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()), settings, extendedClientCapabilities: { progressReportProvider: true, classFileContentsSupport: true, overrideMethodsPromptSupport: false, hashCodeEqualsPromptSupport: false, advancedOrganizeImportsSupport: false,advancedExtractRefactoringSupport:false } },
        synchronize: { fileEvents: fileWatcher },
        middleware: {
          async provideDefinition(document, position, token, provide) {
            const version = document.version;
            await readiness.wait(token);
            if (token.isCancellationRequested || client !== next || document.isClosed ||
                document.version !== version || !vscode.workspace.isTrusted) return;
            return provide(document, position, token);
          },
          workspace:{willRenameFiles(event,next){
            // This exact folder change already includes approved JDT-equivalent text edits.
            return api.refactoring?.isApplyingPackageRename(event.files)?undefined:next(event);
          }},
          provideInlayHints(document,range,token,next) {
            return api.codeHints?.available(document)?[]:next(document,range,token);
          },
          provideDocumentSymbols(document,token,next) {
            return api.structure.outline(document,token,next);
          },
          provideDocumentFormattingEdits(document,options,token,next) {
            return api.formatting.native(document,undefined,options,token,()=>next(document,options,token));
          },
          provideDocumentRangeFormattingEdits(document,range,options,token,next) {
            return api.formatting.native(document,range,options,token,()=>next(document,range,options,token));
          },
          async provideCodeActions(document,range,context,token,provide) {
            const version = document.version;
            const actions = await provide(document,range,context,token);
            if (document.isClosed || document.version !== version || token.isCancellationRequested) return [];
            return actions?.map(action => {
              const named = namedAction(action.kind?.value,action.title);
              if (!named || named !== ACTIONS.constant && (document.isDirty || range.isEmpty)) return action;
              const reviewed = new vscode.CodeAction(named === ACTIONS.constant ? 'Extract Java Constant…' : action.title,action.kind);
              reviewed.disabled = action.disabled;
              reviewed.command = {command:named.command,title:reviewed.title,arguments:[editorAnchor(document,range)]};
              return reviewed;
            });
          },
          resolveCodeAction(item,token,resolve) {
            return Object.values(ACTIONS).some(action => action.command === item.command?.command) ? item : resolve(item,token);
          }
        },
        errorHandler: { error: () => ({ action: ErrorAction.Continue }), closed: () => { if (!disposed && client === next) { client = undefined; lastSettings = undefined; update('error', 'Java server exited. Check Rocketbrain Java output, then restart.'); } return { action: CloseAction.DoNotRestart }; } },
        markdown: { isTrusted: false }
      });
      state = { ...state, serverPath: launch.serverPath, javaHome: launch.javaHome, debugBundlePath: launch.bundles[0], debugBuild: launch.debugBuild, runtimeIdentity: launch.identity,
        workspaceData: launch.data,indexGeneration:index.generation,extractInterfaceReplaceUsages,annotationProcessing:launch.annotationProcessing,nullChecks };
      client = next;
      definitionReadiness = readiness;
      update('starting', 'Starting the independent Eclipse JDT Language Server.');
      next.onNotification('language/status', event => {
        if (event.type === 'ServiceReady') {
          readiness.complete();
          if (client === next && state.state === 'running') showStatus();
        }
        if (event.type === 'Error') output.appendLine(`JDT LS: ${event.message}`);
        else output.appendLine(`JDT LS ${event.type}: ${event.message}`);
      });
      next.onNotification('language/progressReport', event => { status.tooltip = `Java: ${event.task || ''} ${event.subTask || ''}`; });
      await next.start();
      await next.sendNotification('workspace/didChangeConfiguration', { settings });
      lastSettings=settings;
      epoch++;
      const processing = launch.annotationProcessing;
      output.appendLine('Java editor annotation processing: Maven follows the POM, Gradle processor sync '+
        (processing.gradle ? 'enabled' : 'disabled')+', Lombok editor agent '+(processing.lombok?.version || 'disabled')+'.');
      update('running', 'Eclipse JDT LS is connected. Java completion, diagnostics, navigation and rename use this engine. Spring endpoints/settings currently use Rocketbrain source analysis, not Spring LS.');
      api.codeHints?.refresh();
    } catch (error) {
      const failed = client; client = undefined; lastSettings = undefined;
      definitionReadiness?.stop();
      definitionReadiness = undefined;
      if (failed) await failed.stop(1000).catch(() => {});
      update('error', error.message); throw error;
    }
    return { ...state };
  }
  const api = {
    start: () => serial(startNow),
    stop: () => serial(stopNow),
    restart: () => serial(async () => {
      if (!javaModeActive()) return { ...state, message: 'Switch to Java mode to restart the Java engine.' };
      await stopNow();
      return startNow();
    }),
    setWorkspaceMode(mode) {
      workspaceMode = mode;
      if (desktop) {
        showStatus();
        autostart?.check();
      }
    },
    suspendForContainer: () => serial(async () => {
      if (disposed || containerOwner) throw Error('The local Java service already has a container owner.');
      if (vscode.debug.activeDebugSession) throw Error('Finish the active debug session before switching the Java language engine.');
      const wasRunning = Boolean(client);
      const priorState = state;
      const owner = {};
      containerOwner = owner;
      try {
        await stopNow();
      } catch (error) {
        containerOwner = undefined;
        if (wasRunning) void serial(startNow).catch(() => {});
        throw error;
      }
      update('container', 'The managed container Java session owns editor navigation and diagnostics.');
      return { dispose() {
        if (containerOwner !== owner) return;
        containerOwner = undefined;
        if (disposed) return;
        if (wasRunning) void serial(startNow).catch(() => {});
        else update(priorState.state, priorState.message);
      } };
    }),
    getState: () => ({ ...state, ready: state.state === 'running' && Boolean(definitionReadiness?.isReady), springMode: 'local-semantic-index', springLimit: 'Local source/configuration model; runtime and custom Conditions remain unknown. This is not the full Spring Language Server.' }),
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
        disposing = serial(async()=>{await api.workbench?.dispose();await api.groovy?.dispose();await api.quarkus?.dispose();await api.jakarta?.dispose();await api.micronaut?.dispose();await api.scalaEditor?.dispose();await api.scala?.dispose();await api.kotlinMultiplatform?.dispose();await api.androidDebug?.dispose();await api.kotlinEditor?.dispose();await api.coroutines?.dispose();await api.typeRename?.dispose();await api.move?.dispose();await api.memberMove?.dispose();await api.changeSignature?.dispose();await api.safeDelete?.dispose();await api.refactoring?.dispose();await stopNow();}).finally(() => { for (const item of subscriptions) item.dispose(); });
      }
      return disposing;
    }
  };
  const refactoringRequest=async(method,params,cancellation)=>{
    if(!['textDocument/codeAction','codeAction/resolve','textDocument/documentSymbol','textDocument/definition','textDocument/references','textDocument/prepareRename','textDocument/rename','workspace/willRenameFiles','java/getChangeSignatureInfo','java/getRefactorEdit','java/move','java/getMoveDestinations'].includes(method)&&!(method==='workspace/executeCommand'&&['java.project.getClasspaths','java.project.getSettings','java.project.getAll'].includes(params?.command)))throw new Error('Unsupported Java refactoring request.');
    await api.start();if(!vscode.workspace.isTrusted||!client||state.state!=='running')throw new Error('Start Java support in a trusted workspace before refactoring.');
    return client.sendRequest(method,params,...(cancellation?[cancellation]:[]));
  };
  api.navigationLocations=async(kind,position,cancellation)=>{
    const methods={declaration:'textDocument/definition',type:'textDocument/typeDefinition',
      implementation:'textDocument/implementation',super:'java/findLinks',references:'textDocument/references'};
    if(!Object.hasOwn(methods,kind))throw Error('Choose a supported Java navigation relation.');
    await api.start();
    if(!vscode.workspace.isTrusted||!client||state.state!=='running'||cancellation?.isCancellationRequested){
      throw Error('Start the independent Java language server in a trusted workspace.');
    }
    const server=client;
    await definitionReadiness?.wait(cancellation);
    if(client!==server||!vscode.workspace.isTrusted||cancellation?.isCancellationRequested) {
      throw Error('Java navigation changed or was cancelled while waiting for project indexing.');
    }
    const parameters=kind==='super'?{type:'superImplementation',position}:position;
    const locations=await server.sendRequest(methods[kind],parameters,...(cancellation?[cancellation]:[]));
    if(client!==server||!vscode.workspace.isTrusted)throw Error('The Java language server changed during navigation.');
    return locations;
  };
  debuggerController = registerJavaDebugger(vscode,api,output,refactoringRequest);
  api.debug = debuggerController;
  api.debug.asyncTrace = require('./async-trace-vscode').registerJavaAsyncTrace(context, vscode, debuggerController);
  subscriptions.push(debuggerController, api.debug.asyncTrace);
  api.refactoring=require('./refactoring').registerJavaRefactoring(context,vscode,{request:refactoringRequest});
  subscriptions.push(api.refactoring);
  api.formatting=registerJavaFormatting(vscode,{java:api,output,request:async (method,params,cancellation) => {
    const server=client;
    if (!server||state.state!=='running'||!vscode.workspace.isTrusted) throw Error('Start Java support in a trusted workspace before formatting.');
    const edits=await server.sendRequest(method,params,...(cancellation?[cancellation]:[]));
    if (client!==server||!vscode.workspace.isTrusted) throw Error('The Java formatter server changed during formatting.');
    return edits;
  }});
  subscriptions.push(api.formatting);
  api.constantRefactoring=(params,cancellation)=>refactoringRequest('java/getRefactorEdit',{
    command:'extractConstant',context:params,options:{tabSize:4,insertSpaces:true},commandArguments:[]
  },cancellation);
  api.typeImportActions=(textDocument,range,diagnostic,cancellation)=>refactoringRequest('textDocument/codeAction',{
    textDocument,range,context:{diagnostics:[diagnostic],only:['quickfix']}
  },cancellation);
  api.resolveTypeImportAction=(action,cancellation)=>refactoringRequest('codeAction/resolve',action,cancellation);
  api.valueExtraction=(kind,params,cancellation)=>{
    if(!['local','field'].includes(kind))throw Error('Choose Java local variable or field extraction.');
    return refactoringRequest('java/getRefactorEdit',{
      command:ACTIONS[kind].jdt,context:params,options:{tabSize:4,insertSpaces:true},commandArguments:[]
    },cancellation);
  };
  api.innerClassMoveEdit=(params,cancellation)=>refactoringRequest('java/move',params,cancellation);
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
  api.typeRename=require('./java-type-rename-vscode').registerJavaTypeRename(vscode,{request:refactoringRequest,refactoring:api.refactoring,runtime:refactoringRuntime,synchronizeFiles:synchronizeRefactoringFiles,
    beginKotlin:(document,token)=>api.kotlinEditor.beginJavaTypeRename(document,token)});
  api.memberMove=require('./member-move').registerJavaMemberMove(context,vscode,{request:refactoringRequest,refactoring:api.refactoring,runtime:refactoringRuntime,synchronizeFiles:synchronizeRefactoringFiles});
  api.changeSignature=require('./change-signature').registerJavaChangeSignature(context,vscode,{request:refactoringRequest,refactoring:api.refactoring,getJavaHome:()=>api.getState().javaHome});
  api.safeDelete=require('./safe-delete').registerJavaSafeDelete(context,vscode,{request:refactoringRequest,refactoring:api.refactoring,runtime:refactoringRuntime});
  subscriptions.push(api.move,api.memberMove,api.changeSignature,api.safeDelete);
  api.workbench=require('./workbench').registerJavaWorkbench(context,vscode,api,output);
  subscriptions.push(api.workbench);
  api.workspaceIndex = registerWorkspaceIndex(vscode, {
    extension: context, serial, current: currentIndex,
    assertIdle() {
      if (disposed || containerOwner || configuring || installing || debuggerController.hasActiveSessions() || api.workbench.hasActiveRunsOrTasks()) {
        throw Error('Finish active Java builds, runs, debugging or configuration before rebuilding its index.');
      }
    },
    request(command, args, token) {
      if (!currentIndex()) throw Error('The independent Java engine is unavailable.');
      return client.sendRequest('workspace/executeCommand', { command, arguments: args }, token);
    },
    stop: () => stopNow(true),
    async start(scope, generation) {
      await startNow({ storage: indexStorage(scope, generation), generation });
      return currentIndex();
    }
  });
  subscriptions.push(api.workspaceIndex);
  api.delegatedBuild=require('./delegated-build-vscode').registerDelegatedBuild(vscode,{workbench:api.workbench,output});
  subscriptions.push(api.delegatedBuild);
  api.groovy=require('./groovy-vscode').registerGroovyWorkbench(vscode,api);
  api.quarkus=require('./quarkus-vscode').registerQuarkusWorkbench(vscode,api);
  api.jakarta=require('./jakarta-vscode').registerJakartaWorkbench(vscode,api,{storagePath:profileStorage});
  api.micronaut=require('./micronaut-vscode').registerMicronautWorkbench(vscode,api);
  api.scala=require('./scala-vscode').registerScalaWorkbench(context,vscode,api);
  api.scalaEditor=require('./scala-editor-vscode').registerScalaEditor(vscode,api);
  api.kotlinMultiplatform=require('./kmp-vscode').registerKmpWorkbench(vscode,api);
  api.androidDebug=require('./android-debug-vscode').registerAndroidDebug(vscode,api);
  api.kotlinEditor=require('./kotlin-editor-vscode').registerKotlinEditor(context,vscode,api);
  api.structure=registerFileStructure(vscode,{java:api,output,readJava:async (document,token)=>{
    const server=client;
    if (!server?.isRunning()||!vscode.workspace.isTrusted) throw Error('The Java language server is getting ready.');
    const symbols=await server.sendRequest('textDocument/documentSymbol',{textDocument:{uri:document.uri.toString()}},token);
    if (client!==server||!vscode.workspace.isTrusted) throw Error('The Java language server changed during file structure lookup.');
    return symbols;
  }});
  subscriptions.push(api.structure);
  const semanticSelection=require('./semantic-selection-vscode').registerSemanticSelection(vscode,{java:api,
    readJava:async (document,positions,cancellation)=>{
      await api.start();
      const server=client;
      if (!server?.isRunning()||!vscode.workspace.isTrusted||cancellation.isCancellationRequested) {
        throw Error('Start Java support before expanding a semantic selection.');
      }
      const result=await server.sendRequest('textDocument/selectionRange',{
        textDocument:{uri:document.uri.toString()},positions
      },cancellation);
      if (client!==server) throw Error('The Java language server changed. Try expanding again.');
      return result;
    }
  });
  subscriptions.push(semanticSelection);
  api.codeInformation=require('./code-information-vscode').registerCodeInformation(vscode,{java:api,
    readJava:async (document,position,{method},cancellation)=>{
      await api.start();
      const server=client;
      if (!server?.isRunning()||!vscode.workspace.isTrusted||cancellation.isCancellationRequested) {
        throw Error('Start Java support before requesting code information.');
      }
      const response=await server.sendRequest(method,{textDocument:{uri:document.uri.toString()},position},cancellation);
      if(client!==server||!vscode.workspace.isTrusted)throw Error('The Java server changed. Request code information again.');
      return response;
    }
  });
  subscriptions.push(api.codeInformation);
  api.codeHints=require('./code-hints-vscode').registerCodeHints(vscode,{
    output,
    readJava:async (document,range,token)=>{
      const server=client;
      if(!server?.isRunning()||!vscode.workspace.isTrusted||token.isCancellationRequested)return [];
      const response=await server.sendRequest('textDocument/inlayHint',{textDocument:{uri:document.uri.toString()},range},token);
      return client===server?response:[];
    },
    readKotlin:(document,range,token)=>api.kotlinEditor.inlayHints(document,range,token)
  });
  subscriptions.push(api.codeHints);
  api.coroutines=require('./kotlin-coroutines-vscode').registerKotlinCoroutines(vscode,api);
  const reloadSetup = () => {
    if (!desktop || javaModeActive() && (autostart?.admitted || client)) return api.restart();
    return api.getState();
  };
  async function writeEngineSettings(values) {
    configuring = true;
    try {
      const settings = config();
      for (const [key, value] of Object.entries(values)) await settings.update(key, value, vscode.ConfigurationTarget.Global);
    } finally {
      configuring = false;
    }
  }
  async function saveSetup(key, value) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before changing the Java engine.');
    if (key === 'javaHome' && value) value = desktopJavaHome(value).path;
    if (key === 'serverPath') value = inspectServerPath(value).serverPath;
    await writeEngineSettings({ [key]: value });
    await reloadSetup();
  }
  async function installEngine(javaHome, onProgress) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before installing and starting the Java engine.');
    if (installing) throw new Error('Java engine installation is already running.');
    installing = true;
    try {
      const { provision } = require('../../scripts/java-provision');
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rocketbrain · Install and configure Java engine', cancellable: false }, progress => provision({
        target: managedEngine, 'java-home': javaHome,
        onProgress(message) { output.appendLine(message); progress.report({ message }); onProgress?.(message); }
      }));
      await writeEngineSettings({ javaHome: result.javaHome, serverPath: result.serverPath,
        debugBundlePath: result.debugBundlePath, enabled: true });
      const info = await reloadSetup();
      if (!desktop) vscode.window.showInformationMessage(info.state === 'running' ? 'Rocketbrain Java engine is installed and connected.' : info.message);
      return info;
    } finally { installing = false; }
  }
  api.librarySources=require('./library-source-vscode').registerLibrarySources(vscode,{
    java:api,output,
    async readContent(uri,token) {
      await api.start();
      if (!client || token?.isCancellationRequested) return '';
      return client.sendRequest('java/classFileContents', { uri: uri.toString() }, ...(token?[token]:[]));
    }
  });
  subscriptions.push(api.librarySources);

  if (desktop) {
    setup = registerDesktopJavaSetup(vscode, { runtime: desktopRuntime, canStart: canStartDesktop, detectJdk,
      getState: api.getState, install: installEngine, save: saveSetup, restart: api.restart, output });
    subscriptions.push(setup, vscode.workspace.onDidGrantWorkspaceTrust(setup.refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(setup.refresh), vscode.workspace.onDidOpenTextDocument(setup.refresh));
  }
  const reportSetupError = error => vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`);
  const installOrOpenSetup = () => desktop ? setup.open() : installEngine().catch(reportSetupError);
  subscriptions.push(
    vscode.commands.registerCommand('rocketbrain.java.installEngine', installOrOpenSetup),
    vscode.commands.registerCommand('rocketbrain.java.setup', () => desktop ? setup.open() : vscode.commands.executeCommand('rocketbrain.javaSupport')),
    vscode.commands.registerCommand('rocketbrain.java.start', () => api.start().catch(reportSetupError)),
    vscode.commands.registerCommand('rocketbrain.java.restart', () => api.restart().catch(reportSetupError)),
    vscode.commands.registerCommand('rocketbrain.java.status', api.getState),
    vscode.commands.registerCommand('rocketbrain.javaSupport', async () => {
    if (desktop) return setup.open();
    const info = api.getState();
    const selected = await vscode.window.showQuickPick([{ label: 'Install and configure Java engine', description: 'Download Eclipse JDT LS and Temurin JDK; save Java paths', action: 'install' }, { label: 'Start / restart Java server', action: 'restart' }, { label: 'Open Java settings', action: 'settings' }, { label: 'Show Java output', action: 'output' }, { label: 'Browse Spring endpoints', action: 'endpoints' }], { title: `Rocketbrain Java · ${info.state}`, placeHolder: info.message });
    if (selected?.action === 'install') await installEngine().catch(reportSetupError);
    else if (selected?.action === 'restart') await api.restart().catch(reportSetupError);
    else if (selected?.action === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rocketbrain-local.rocketbrain rocketbrain.java');
    else if (selected?.action === 'output') output.show();
    else if (selected?.action === 'endpoints') await vscode.commands.executeCommand('rocketbrain.spring.endpoints');
  }));

  subscriptions.push(vscode.commands.registerCommand('rocketbrain.java.configureNullChecks',()=>{
    return configureNullChecks(vscode).catch(error=>{void vscode.window.showErrorMessage(error.message);});
  }));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{
    if(event.affectsConfiguration('rocketbrain.java.nullChecks'))void serial(syncNullChecks).catch(error=>output.appendLine(error.message));
  }));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    const restartSettings = ['enabled', 'serverPath', 'javaHome', 'debugBundlePath', 'projectJdks', 'gradleHome', 'gradleJavaHome',
      'extractInterface.replaceUsages', 'staticImport.favorites', 'annotationProcessing.gradleEnabled', 'annotationProcessing.lombokJar'];
    if (configuring || !restartSettings.some(key => event.affectsConfiguration(`rocketbrain.java.${key}`))) return;
    setup?.refresh();
    void Promise.resolve(reloadSetup()).catch(error => output.appendLine(error.message));
  }));
  update('stopped', 'Java server is stopped.');
  subscriptions.push(registerJavaDefinitionStartup(vscode, {
    async start(token) {
      await api.start();
      await definitionReadiness?.wait(token);
    },
    provider: document => client?.getFeature('textDocument/definition')?.getProvider(document),
    isAvailable: () => {
      if (disposed || containerOwner || state.state === 'error' || !javaModeActive() || !vscode.workspace.isTrusted) return false;
      if (!config().get('enabled', true)) return false;
      if (client) return true;
      const paths = enginePaths();
      return Boolean(paths.javaHome && paths.serverPath);
    }
  }));
  autostart = registerJavaAutostart(vscode, async () => {
    try {
      const started = await serial(() => javaModeActive() ? startNow() : false);
      if (started === false) return false;
    }
    finally {
      if (setup && !setupPrompted && javaModeActive() && ['configuration-required', 'error'].includes(state.state)) {
        setupPrompted = true;
        setup.open({ automatic: true });
      }
    }
  }, error => output.appendLine(error.message), javaModeActive);
  subscriptions.push(autostart);
  return api;
}

module.exports = { registerJavaFeatures };
