'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { independentJavaExecutable, argumentString, launchCommandMode, KOTLIN_LINE_BUILDS, KOTLIN_FIELD_VALUES_BUILD } = require('./debug-runtime');
const { applyManagedSpringLaunch } = require('./spring-launch');
const { JavaDebugAdapter } = require('./debug-adapter');
const { createJavaBreakpointTools } = require('./debug-breakpoints');
const { createExceptionControls } = require('./debug-exceptions');
const { createSmartStep, mergeStepFilters } = require('./debug-step');
const { createFrameRestart } = require('./debug-frames');
const { createLocalValueInspection } = require('./debug-local-values');
const { createKotlinLocalEditor } = require('./debug-kotlin-local');
const { createKotlinFieldInspector } = require('./debug-kotlin-fields');
const { createDebugProcessDiscovery, processId } = require('./debug-processes');
const { assertManagedAttach } = require('../devcontainer/java-attach');
const DEBUG_TYPE = 'rocketbrain-java';
const PROCESS_SELECTION = '__rocketbrainJavaProcessSelection';
const VERIFIED_ATTACH = '__rocketbrainVerifiedAttach';
const KMP_DEBUG_MARKER = '__rocketbrainKmpDebugSession';
const resumeCommands = new Set(['continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'restart',
  'restartFrame', 'goto', 'terminate', 'disconnect']);

function processAttachTarget(selection) {
  const reviewed = selection && typeof selection === 'object' ? selection : undefined;
  const pid = processId(reviewed?.pid ?? selection);
  return {processId:pid,...(reviewed?{[PROCESS_SELECTION]:{
    pid,startedAt:reviewed.startedAt,hostName:reviewed.hostName,port:reviewed.port
  }}:{})};
}

function registerJavaDebugger(vscode, api, output, request) {
  const sessions = new Map(), pendingAttaches = new Map(), pendingKotlinLines = new Map(); let disposed = false;
  function record(session) {
    if (!sessions.has(session.id)) {
      const config = session.configuration;
      const pending = pendingAttaches.get(config?.[VERIFIED_ATTACH]);
      if (pending) pendingAttaches.delete(config[VERIFIED_ATTACH]);
      const verifiedPid = pending && pending.expires > Date.now() && config.hostName === pending.hostName && config.port === pending.port ? pending.pid : undefined;
      sessions.set(session.id, { session, verifiedPid, state: 'starting', stopVersion: 0, buildVersion: 0, appliedVersion: 0, hcrEvents: [] });
    }
    return sessions.get(session.id);
  }
  function observe(session, message) {
    const info = sessions.get(session.id); if (!info) return;
    if (message.type === 'response' && message.command === 'initialize' && message.success) info.capabilities = message.body;
    if (message.type === 'response' && message.command === 'attach') {
      info.attached = message.success === true;
    }
    if (message.type === 'response' && info.resuming !== undefined && info.resuming === message.request_seq) {
      if (message.success && info.state === 'stopped') info.state = 'running';
      info.resuming = undefined;
    }
    if (message.type === 'event') {
      if (message.event === 'stopped') { info.state = 'stopped'; info.threadId = message.body?.threadId; info.stopVersion++; info.resuming = undefined; }
      if (message.event === 'continued') info.state = 'running';
      if (message.event === 'terminated') info.state = 'terminated';
      if (message.event === 'hotcodereplace') {
        const event = { ...message.body, time: Date.now() }; info.hcrEvents.push(event); if (info.hcrEvents.length > 20) info.hcrEvents.shift();
        if (event.changeType === 'BUILD_COMPLETE') info.buildVersion++;
        output.appendLine(`Hot code replace ${event.changeType}: ${event.message || ''}`);
      }
    }
  }
  const ensureTrusted = () => { if (disposed) throw new Error('Java debugger is disposed.'); if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running or attaching Java code.'); };
  function registerKotlinSourceLines(token, target, evidence) {
    ensureTrusted();
    if (!KOTLIN_LINE_BUILDS.includes(api.getState().debugBuild) || pendingKotlinLines.has(token) || pendingKotlinLines.size>=8) {
      throw Error('A current managed Kotlin source-line debugger is required.');
    }
    const record={target,evidence};
    pendingKotlinLines.set(token,record);
    return {dispose() {if (pendingKotlinLines.get(token)===record) pendingKotlinLines.delete(token);}};
  }
  const discovery = createDebugProcessDiscovery({
    javaHome: () => api.getState().javaHome || vscode.workspace.getConfiguration?.('rocketbrain.java').get('javaHome'),
    trusted: ensureTrusted
  });
  const breakpoints = createJavaBreakpointTools(vscode,{
    request,ensureTrusted,isSupported:session => session.type === DEBUG_TYPE &&
      sessions.get(session.id)?.capabilities?.supportsBreakpointLocationsRequest === true
  });
  const activeSelection = () => {
    const editor = vscode.window.activeTextEditor;
    return {document:editor?.document,position:editor?.selection.active};
  };
  const breakpointCommand = (id,action) => vscode.commands.registerCommand(id,async () => {
    try { return await action(); }
    catch (error) { void vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`); return undefined; }
  });
  function runReady(command, ...args) {
    ensureTrusted();
    if (!api.getState().debugBundlePath) throw new Error('Install the Rocketbrain Java engine to configure its public Java debug bundle, or set rocketbrain.java.debugBundlePath.');
    return api.executeWorkspaceCommand(command, ...args);
  }
  const run = async (command, ...args) => {
    ensureTrusted(); await api.start();
    return runReady(command, ...args);
  };
  const exceptions = createExceptionControls(vscode, {
    run: runReady, ensureTrusted, engineState: () => api.getState(), output,
    hasSessions: () => [...sessions.values()].some(info => info.state !== 'terminated')
  });
  const smartStep = createSmartStep(vscode, { getState: id => sessions.get(id), ensureTrusted });
  const frames = createFrameRestart(vscode, { getState: id => sessions.get(id), ensureTrusted });
  const localValues = createLocalValueInspection(vscode, { getState: id => sessions.get(id), ensureTrusted });
  const kotlinFrameOptions = { getState: id => sessions.get(id), ensureTrusted };
  const kotlinLocals = createKotlinLocalEditor(vscode, kotlinFrameOptions);
  const kotlinFields = createKotlinFieldInspector(vscode, kotlinFrameOptions);
  async function resolve(folder, value, token) {
    ensureTrusted();
    assertManagedAttach(value, folder);
    const config = { ...value, type: DEBUG_TYPE, name: value.name || 'Rocketbrain Java', request: value.request || 'launch' };
    delete config[VERIFIED_ATTACH];
    if (token?.isCancellationRequested) return undefined;
    const stepFilters = mergeStepFilters(vscode.workspace.getConfiguration?.('rocketbrain.java', folder?.uri).get('stepFilters'), value.stepFilters);
    if (Object.keys(stepFilters).length || value.stepFilters) config.stepFilters = stepFilters;
    if (config.request === 'attach') {
      if (config.processId !== undefined) {
        if (value.hostName !== undefined || value.port !== undefined) throw Error('Choose either a local process ID or a host and port.');
        const pid = processId(config.processId);
        const reviewed = config[PROCESS_SELECTION];
        if (reviewed && reviewed.pid !== pid) throw Error('The selected Java process ID changed.');
        const selected = await discovery.resolve(reviewed || pid, token);
        if (token?.isCancellationRequested) return undefined;
        config.hostName = selected.hostName;
        config.port = selected.port;
        delete config.processId;
        delete config[PROCESS_SELECTION];
        const now = Date.now();
        for (const [key, pending] of pendingAttaches) if (pending.expires <= now) pendingAttaches.delete(key);
        if (pendingAttaches.size >= 64) pendingAttaches.delete(pendingAttaches.keys().next().value);
        const key = randomUUID();
        pendingAttaches.set(key, { ...selected, expires: now + 60000 });
        config[VERIFIED_ATTACH] = key;
      }
      config.hostName = config.hostName || '127.0.0.1'; config.port = config.port === undefined ? 5005 : Number(config.port);
      if (typeof config.hostName !== 'string' || !config.hostName.trim() || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Attach requires a hostName and TCP port from 1 to 65535.');
      return config;
    }
    if (config.request !== 'launch') throw new Error('Rocketbrain Java supports launch and attach requests.');
    const active = vscode.window.activeTextEditor?.document;
    if (!config.mainClass || config.mainClass === '${file}' || /\.java$/i.test(config.mainClass)) {
      const uri = config.mainClass && config.mainClass !== '${file}' ? vscode.Uri.file(config.mainClass) : active?.languageId === 'java' ? active.uri : undefined;
      let candidates = uri ? await run('vscode.java.resolveMainMethod', uri.toString()) : [];
      if (!candidates?.length) candidates = await run('vscode.java.resolveMainClass', folder?.uri.toString());
      if (token?.isCancellationRequested) return undefined;
      if (!candidates?.length) throw new Error('No Java main method was found. Wait for project import, or supply mainClass and projectName in launch.json.');
      const selected = candidates.length === 1 ? candidates[0] : await vscode.window.showQuickPick(candidates.map(item => ({ label: item.mainClass, description: item.projectName, candidate: item })), { title: 'Rocketbrain · Select Java main class' }, token);
      if (!selected || token?.isCancellationRequested) return undefined;
      const main = selected.candidate || selected; config.mainClass = main.mainClass; config.projectName = config.projectName || main.projectName;
    }
    if (typeof config.mainClass !== 'string' || !config.mainClass.trim()) throw new Error('Launch requires a Java mainClass.');
    if (vscode.workspace.textDocuments.some(document => document.languageId === 'java' && document.isDirty)) throw new Error('Save the modified Java source files before debugging so breakpoints and compiled classes agree.');
    const build = await run('vscode.java.buildWorkspace', JSON.stringify({ mainClass: config.mainClass, projectName: config.projectName || '', isFullBuild: false }));
    if (token?.isCancellationRequested) return undefined;
    if (build !== 'SUCCEED' && build !== 1) throw new Error(`Java build did not succeed (${String(build)}). Fix compilation errors before debugging.`);
    if (!config.classPaths?.length && !config.modulePaths?.length) {
      const paths = await run('vscode.java.resolveClasspath', config.mainClass, config.projectName || '');
      if (!Array.isArray(paths) || !Array.isArray(paths[0]) || !Array.isArray(paths[1])) throw new Error('Java engine did not resolve launch classpaths.');
      [config.modulePaths, config.classPaths] = paths;
    }
    if (!config.classPaths?.length && !config.modulePaths?.length) throw new Error('No Java launch classpath was found.');
    config.javaExec = config.javaExec || await run('vscode.java.resolveJavaExecutable', config.mainClass, config.projectName || '');
    config.javaExec = independentJavaExecutable(config.javaExec);
    config.cwd = config.cwd || folder?.uri.fsPath || path.dirname(active?.uri.fsPath || config.javaExec);
    config.console = config.console || 'internalConsole'; config.encoding = config.encoding || 'UTF-8'; config.sourcePaths = config.sourcePaths || [];
    applyManagedSpringLaunch(config);
    config.args = argumentString(config.args); config.vmArgs = argumentString(config.vmArgs);
    config.shortenCommandLine = launchCommandMode(config);
    return token?.isCancellationRequested ? undefined : config;
  }
  const provider = {
    provideDebugConfigurations: () => [{ type: DEBUG_TYPE, name: 'Rocketbrain: Debug Java main', request: 'launch', mainClass: '${file}' }, { type: DEBUG_TYPE, name: 'Rocketbrain: Attach Java', request: 'attach', hostName: '127.0.0.1', port: 5005 }],
    resolveDebugConfiguration: (folder, config) => Object.keys(config).length ? config : { type: DEBUG_TYPE, name: 'Rocketbrain: Debug Java main', request: 'launch', mainClass: '${file}' },
    async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
      try { return await resolve(folder, config, token); }
      catch (error) { output.appendLine(`Debugger: ${error.message}`); void vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`); return undefined; }
    }
  };
  const factory = { async createDebugAdapterDescriptor(session) {
    ensureTrusted();
    assertManagedAttach(session.configuration, session.workspaceFolder);
    await api.start();
    await exceptions.sync();
    assertManagedAttach(session.configuration, session.workspaceFolder);
    const port = await runReady('vscode.java.startDebugSession'); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Java engine returned an invalid debugger port.');
    assertManagedAttach(session.configuration, session.workspaceFolder);
    const info = record(session);
    info.debugBuild = api.getState().debugBuild;
    const marker=session.configuration[KMP_DEBUG_MARKER];
    const owned=pendingKotlinLines.get(marker);
    const evidence=owned && KOTLIN_LINE_BUILDS.includes(info.debugBuild) && info.verifiedPid===owned.target.pid &&
      session.configuration.hostName===owned.target.hostName && session.configuration.port===owned.target.port ? owned.evidence : undefined;
    if (evidence) pendingKotlinLines.delete(marker);
    const adapter = new JavaDebugAdapter(vscode, port, message => observe(session, message), output, message => {
      if (message.type !== 'request') return;
      if (resumeCommands.has(message.command)) { info.stopVersion++; info.resuming = message.seq; }
      if (message.command === 'redefineClasses') info.stopVersion++;
    },evidence,info.debugBuild===KOTLIN_FIELD_VALUES_BUILD && Number.isInteger(info.verifiedPid) &&
      session.configuration.hostName==='127.0.0.1' ? session.configuration.port : undefined);
    return new vscode.DebugAdapterInlineImplementation(adapter);
  } };
  async function attachProcess(selection, { folder, projectName, sourcePaths, name } = {}) {
    ensureTrusted();
    const target = processAttachTarget(selection);
    if (!folder) {
      const uri = vscode.window.activeTextEditor?.document.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
      if (uri) folder = vscode.workspace.getWorkspaceFolder(uri);
    }
    // An external JVM is already running its own bytecode. Attaching is
    // independent of local editor saves, including unrelated untitled editors.
    return vscode.debug.startDebugging(folder, {
      type: DEBUG_TYPE, request: 'attach', name: name || 'Attach to Java PID ' + target.processId,
      ...target, projectName, sourcePaths
    }, { suppressSaveBeforeStart: true });
  }
  async function hotCodeReplace(sessionId) {
    ensureTrusted();
    if (vscode.workspace.getConfiguration?.('rocketbrain.java').get('hotCodeReplace', 'manual') === 'never') throw new Error('Hot code replace is disabled in Rocketbrain Java settings.');
    const session = sessionId ? sessions.get(sessionId)?.session : vscode.debug.activeDebugSession;
    const info = session && sessions.get(session.id);
    if (!info || session.type !== DEBUG_TYPE || info.state !== 'stopped') throw new Error('Pause a Rocketbrain Java debug session before applying code changes.');
    if (info.reloading) throw new Error('Hot code replacement is already running for this session.');
    if (vscode.workspace.textDocuments.some(document => document.languageId === 'java' && document.isDirty)) throw new Error('Save Java source changes before applying hot code replacement.');
    info.reloading = true;
    try {
      const config = session.configuration;
      const build = await run('vscode.java.buildWorkspace', JSON.stringify({ mainClass: config.mainClass || '', projectName: config.projectName || '', isFullBuild: false }));
      if (build !== 'SUCCEED' && build !== 1) throw new Error(`Hot code replacement build failed (${String(build)}).`);
      ensureTrusted();
      if (info.state === 'terminated') throw new Error('The debug session ended during compilation.');
      const result = await session.customRequest('redefineClasses');
      if (result?.errorMessage) throw new Error(`JVM rejected hot code replacement: ${result.errorMessage}. Structural changes may require restarting the JVM.`);
      info.appliedVersion = info.buildVersion; info.lastHcrResult = { success: true, changedClasses: result?.changedClasses || [] };
      output.appendLine(`Hot code replace applied: ${info.lastHcrResult.changedClasses.join(', ') || 'No pending class changes.'}`);
      return { ...info.lastHcrResult, events: info.hcrEvents.slice(-5) };
    } catch (error) { info.lastHcrResult = { success: false, error: error.message }; throw error; }
    finally { info.reloading = false; }
  }
  const disposables = [exceptions, localValues, vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider), vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory), vscode.debug.onDidStartDebugSession(session => { if (session.type === DEBUG_TYPE) record(session); }), vscode.debug.onDidTerminateDebugSession(session => sessions.delete(session.id)), vscode.commands.registerCommand('rocketbrain.java.hotCodeReplace', async sessionId => {
    try { return await hotCodeReplace(typeof sessionId === 'string' ? sessionId : undefined); }
    catch (error) { output.appendLine(error.message); void vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`); return { success: false, error: error.message }; }
  }), vscode.commands.registerCommand('rocketbrain.java.debug', async () => {
    try { ensureTrusted(); const uri = vscode.window.activeTextEditor?.document.uri || vscode.workspace.workspaceFolders?.[0]?.uri; return await vscode.debug.startDebugging(uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined, { type: DEBUG_TYPE, name: 'Rocketbrain: Debug Java main', request: 'launch', mainClass: '${file}' }); }
    catch (error) { void vscode.window.showErrorMessage(`Rocketbrain Java: ${error.message}`); return false; }
  }),
  breakpointCommand('rocketbrain.java.configureExceptionBreakpoints', () => exceptions.edit()),
  breakpointCommand('rocketbrain.java.smartStepInto', () => smartStep.choose()),
  breakpointCommand('rocketbrain.java.restartStackFrame', () => frames.choose()),
  breakpointCommand('rocketbrain.java.inspectLocalValue', () => localValues.choose()),
  breakpointCommand('rocketbrain.java.setKotlinLocal', () => kotlinLocals.choose()),
  breakpointCommand('rocketbrain.java.inspectKotlinObjectFields', () => kotlinFields.choose()),
  breakpointCommand('rocketbrain.java.attachProcess', async () => {
    const candidates = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Finding local Java debug processes', cancellable: true
    }, async (_, token) => {
      try { return await discovery.list(token); }
      catch (error) { if (!token.isCancellationRequested) throw error; }
    });
    if (!candidates) return;
    if (!candidates.length) throw Error('No local Java process is listening for JDWP on 127.0.0.1.');
    const chosen = await vscode.window.showQuickPick(candidates.map(candidate => ({
      label: candidate.label, description: 'PID ' + candidate.pid, detail: candidate.hostName + ':' + candidate.port, candidate
    })), { title: 'Attach to Local Java Process' });
    if (chosen) return attachProcess(chosen.candidate);
  }),
  breakpointCommand('rocketbrain.java.addMethodBreakpoint',() => breakpoints.addMethod(activeSelection())),
  breakpointCommand('rocketbrain.java.addInlineBreakpoints',async () => {
    const report = await breakpoints.inspectInline(activeSelection());
    const chosen = await vscode.window.showQuickPick(report.choices.map(choice => ({
      ...choice,description:'Column '+choice.column
    })),{title:'Add Java Inline Breakpoints',canPickMany:true});
    if (chosen?.length) return breakpoints.addInline(report,chosen.map(item => item.column));
  })];
  return { breakpoints, exceptions, smartStep, frames, localValues, kotlinLocals, kotlinFields, processes: { ...discovery, attach: attachProcess }, hotCodeReplace,
    registerKotlinSourceLines,
    verifiedLocalPid(session) {
      const info = session && sessions.get(session.id);
      return info?.attached && info.state !== 'terminated' ? info.verifiedPid : undefined;
    },
    getState(sessionId) {
      const info = sessions.get(sessionId || vscode.debug.activeDebugSession?.id);
      return info ? { state: info.state, threadId: info.threadId, stopVersion: info.stopVersion, resuming: info.resuming,
        buildVersion: info.buildVersion, capabilities: info.capabilities, hcrEvents: [...info.hcrEvents],
        lastHcrResult: info.lastHcrResult } : undefined;
    },
    async stopSessions() { await Promise.allSettled([...sessions.values()].map(info => vscode.debug.stopDebugging(info.session))); },
    dispose() { disposed = true; pendingAttaches.clear(); pendingKotlinLines.clear(); void this.stopSessions(); for (const item of disposables) item.dispose(); } };
}

module.exports = { DEBUG_TYPE, KMP_DEBUG_MARKER, registerJavaDebugger, processAttachTarget };
