'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { debugFixture, verifyHttp, get, assertClosed, pausedLocal, removeFixture } = require('./helpers/micronaut-debug-fixture');
const { withOwnedDatabase } = require('./micronaut-gradle-host');
const { importedSpring } = require('./java-source-analysis-host');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { BuildTasks } = require('../src/java/workbench-tasks');
const { collectProjects } = require('../src/java/workbench-model');
const { execute } = require('../src/java/testing/provision');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');
const { registerMicronautWorkbench } = require('../src/java/micronaut-vscode');
const { MARKER } = require('../src/java/micronaut-debugger');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');

const approval = { allowProjectExecution: true, environment: 'dev' };
const toolsToTest = ['maven', 'gradle'];
const uriOf = file => pathToFileURL(file).href;

async function ownedProject(parent, tool, operation) {
  parent = await fs.realpath(parent);
  const room = await fs.mkdtemp(path.join(parent, 'rb-micronaut-debug-'));
  const identity = await fs.lstat(room, { bigint: true });
  try {
    const fixture = await debugFixture(path.join(room, tool), tool, { mavenRepository: process.env.ROCKETBRAIN_MICRONAUT_MAVEN_REPO });
    return await operation(fixture, room);
  } finally { await removeFixture(room, parent, identity); }
}

function verifiedReceipt(receipt, fixture) {
  assert.equal(receipt.kind, fixture.task === 'package' ? 'maven-jar' : 'gradle-distribution');
  assert.equal(receipt.environment, 'dev');
  assert.match(receipt.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.debug.address, '127.0.0.1');
  assert.equal(receipt.debug.verified, true);
  assert.equal(receipt.debug.httpOwnershipVerified, true);
  assert.ok(Number.isInteger(receipt.debug.pid) && receipt.debug.pid > 0);
  assert.notEqual(receipt.debug.port, Number(new URL(receipt.baseUrl).port));
  assert.ok(receipt.sessionId);
}

function headlessDebug(command, discovery) {
  const starts = new Set(), stops = new Set(), attached = new Map();
  const event = listeners => callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
  const api = {
    onDidStartDebugSession: event(starts), onDidTerminateDebugSession: event(stops),
    async startDebugging(_folder, config, options) {
      assert.ok(config[MARKER]);
      assert.equal(config.type, 'rocketbrain-java');
      assert.equal(config.request, 'attach');
      assert.equal(options.suppressSaveBeforeStart, true);
      const review = config.__rocketbrainJavaProcessSelection;
      const exact = await discovery.resolve(review);
      assert.equal(exact.pid, config.processId);
      const dap = new DapClient(await command('vscode.java.startDebugSession'));
      const session = { id: randomUUID(), configuration: config, type: config.type };
      try {
        await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'rocketbrain-micronaut-fixture',
          linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: false });
        const attach = dap.request('attach', { type: config.type, name: config.name, hostName: exact.hostName,
          port: exact.port, sourcePaths: config.sourcePaths });
        attach.catch(() => {});
        await dap.event('initialized', 0, 20000);
        await dap.request('setExceptionBreakpoints', { filters: [] });
        await dap.request('configurationDone', {}, 20000);
        await attach;
        attached.set(session.id, { session, dap, pid: exact.pid });
        for (const callback of starts) callback(session);
        return true;
      } catch (error) { await dap.close(); throw error; }
    },
    async stopDebugging(session) {
      const record = attached.get(session.id);
      assert.ok(record);
      attached.delete(session.id);
      try { await record.dap.request('disconnect', { terminateDebuggee: false }, 3500); }
      finally {
        record.dap.socket.destroy();
        for (const callback of stops) callback(session);
      }
    }
  };
  return { api, verifiedLocalPid: session => attached.get(session.id)?.pid, attached };
}

async function headlessProject(tool, runtime, fixture, room) {
  const javaHome = runtime.javaHome, gradleHome = process.env.ROCKETBRAIN_MICRONAUT_GRADLE_HOME;
  const projectUri = uriOf(fixture.root), work = path.join(room, 'jdt');
  const launch = resolveLaunch({ ...runtime, storagePath: work });
  const lsp = new StdioLsp(launch);
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args }, 90000);
  let service, logs = '';
  try {
    const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }], { gradleHome, gradleJavaHome: javaHome });
    settings.java.autobuild.enabled = false;
    settings.java.import.gradle.enabled = tool === 'gradle';
    if (tool === 'gradle') {
      settings.java.import.gradle.wrapper.enabled = false;
      settings.java.import.gradle.offline = { enabled: true };
    }
    await lsp.request('initialize', { processId: process.pid, rootUri: projectUri,
      workspaceFolders: [{ uri: projectUri, name: 'micronaut-debug-' + tool }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true } },
      initializationOptions: { workspaceFolders: [projectUri], bundles: [runtime.debugBundlePath], settings } }, 90000);
    lsp.notify('initialized', {});
    lsp.notify('textDocument/didOpen', { textDocument: { uri: uriOf(fixture.source), languageId: 'java', version: 1, text: fixture.text } });
    const project = await until(async () => {
      const view = await collectProjects({ request: (name, args) => command(name, ...args), folders: [projectUri] });
      return view.projects.find(value => value.tool === tool && value.sourceRoots.some(source =>
        !path.relative(source.path, path.join(fixture.root, 'src', 'main', 'java'))));
    }, 130000);
    assert.ok(project);
    const executed = [];
    const runner = {
      async execute(spec, options) {
        const result = await execute(spec.command, spec.args, { ...options, cwd: spec.cwd, env: spec.env });
        if (result.code !== 0) throw Error(result.output);
        return result;
      }
    };
    const tasks = new BuildTasks({ storagePath: work, tools: () => ({ javaHome, gradleHome, mavenHome: runtime.mavenHome }), runner });
    const discovery = createDebugProcessDiscovery({ javaHome: () => javaHome, trusted() {} });
    const adapter = headlessDebug(command, discovery);
    const event = () => ({ dispose() {} });
    const root = { uri: { scheme: 'file', toString: () => projectUri } };
    const vscode = {
      Uri: { parse: value => value }, debug: adapter.api,
      workspace: { workspaceFolders: [root], textDocuments: [], isTrusted: true, getWorkspaceFolder: () => root },
      window: { createOutputChannel: () => ({ append: chunk => { logs = (logs + chunk).slice(-12000); }, appendLine() {}, dispose() {} }) },
      commands: { registerCommand: event }, languages: { registerCompletionItemProvider: event, registerDefinitionProvider: event }
    };
    const java = {
      start: async () => {}, getState: () => runtime, debug: { processes: discovery, verifiedLocalPid: adapter.verifiedLocalPid },
      workbench: { getSnapshot: () => ({ projects: [project] }), discoverTasks: options => tasks.discover(project, options),
        runTask: async options => {
          const result = await tasks.run(project, options.taskId, options);
          executed.push(result.task);
          return result;
        } }
    };
    service = registerMicronautWorkbench(vscode, java);
    await assert.rejects(service.debug({ projectUri }), /Explicitly choose Micronaut debugging/u);
    assert.deepEqual(executed, []);
    const receipt = await service.debug({ projectUri, ...approval });
    verifiedReceipt(receipt, fixture);
    assert.equal(service.getState().sessionId, receipt.sessionId);
    assert.deepEqual(executed, [fixture.task]);
    const before = await verifyHttp(receipt, fixture);
    const dap = adapter.attached.get(receipt.sessionId).dap;
    const source = { name: path.basename(fixture.source), path: fixture.source };
    const configured = await dap.request('setBreakpoints', { source, breakpoints: [{ line: fixture.line }] });
    assert.equal(configured.breakpoints.length, 1);
    const http = get(receipt, fixture.base + '/jdbc');
    http.catch(() => {});
    const stopped = await dap.event('stopped', 0, 30000);
    assert.equal(stopped.reason, 'breakpoint');
    const local = await pausedLocal(dap.request.bind(dap), stopped.threadId, fixture);
    assert.deepEqual((await dap.request('setBreakpoints', { source, breakpoints: [] })).breakpoints, []);
    await dap.request('continue', { threadId: stopped.threadId });
    assert.equal(await http, '2');
    const after = await verifyHttp(receipt, fixture);
    assert.deepEqual(after, before);
    assert.equal((await service.stop()).state, 'stopped');
    assert.equal(adapter.attached.size, 0);
    await Promise.all([assertClosed(receipt.debug.port), assertClosed(Number(new URL(receipt.baseUrl).port))]);
    return { tool, task: fixture.task, local, before, after, artifact: receipt.kind, sha256: receipt.sha256,
      actualJdtDapAttach: true, listenerAndSessionOwnership: true, closedBothPorts: true };
  } catch (error) { if (logs) process.stderr.write(logs + '\n'); throw error; }
  finally {
    try { await service?.dispose(); }
    finally { await lsp.close(); }
  }
}

async function headless() {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const parent = os.tmpdir(), reports = [];
  for (const tool of toolsToTest) reports.push(await ownedProject(parent, tool, (fixture, room) =>
    headlessProject(tool, runtime, fixture, room)));
  return { reports };
}

async function nativeProject(api, vscode, workspace, tool) {
  const { fileURLToPath } = require('node:url');
  return ownedProject(workspace, tool, async fixture => {
    const projectUri = vscode.Uri.file(fixture.root).toString();
    const service = api.java.micronaut, records = [], requests = new Map();
    const source = vscode.Uri.file(fixture.source);
    let breakpoint, pending;
    const within = file => {
      const rel = path.relative(fixture.root, file);
      return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    };
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', { createDebugAdapterTracker(session) {
      if (!session.configuration?.[MARKER]) return;
      return {
        onWillReceiveMessage(message) {
          const configured = message.arguments?.source?.path;
          if (message.type !== 'request' || message.command !== 'setBreakpoints' || !configured) return;
          const file = configured.startsWith('file:') ? fileURLToPath(configured) : configured;
          if (path.isAbsolute(file) && !path.relative(fixture.source, file)) {
            requests.set(message.seq, message.arguments.breakpoints?.length || message.arguments.lines?.length || 0);
          }
        },
        onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'stopped') {
            records.push({ session: session.id, threadId: message.body?.threadId, reason: message.body?.reason });
          }
          if (message.type === 'response' && message.success && message.command === 'configurationDone') {
            records.push({ session: session.id, configurationDone: true });
          }
          if (message.type === 'response' && message.success && message.command === 'setBreakpoints' &&
              requests.has(message.request_seq)) {
            records.push({ session: session.id, assigned: requests.get(message.request_seq),
              reported: message.body?.breakpoints.length });
            requests.delete(message.request_seq);
          }
        }
      };
    } });
    try {
      const imported = await api.java.workbench.resyncProject({ projectUri, ...approval });
      assert.ok(imported.projects.some(project => project.tool === tool && !path.relative(project.root, fixture.root)));
      const document = await vscode.workspace.openTextDocument(source);
      await vscode.window.showTextDocument(document, { preview: false });
      const receipt = await service.debug({ projectUri, ...approval });
      verifiedReceipt(receipt, fixture);
      const active = vscode.debug.activeDebugSession;
      assert.equal(active?.id, receipt.sessionId);
      assert.equal(api.java.debug.verifiedLocalPid(active), receipt.debug.pid);
      const find = predicate => records.find(record => record.session === active.id && predicate(record));
      await until(() => find(record => record.configurationDone), 25000);
      const before = await verifyHttp(receipt, fixture);
      breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(fixture.line - 1, 0)));
      vscode.debug.addBreakpoints([breakpoint]);
      await until(() => find(record => record.assigned === 1 && record.reported === 1), 25000);
      pending = get(receipt, fixture.base + '/jdbc');
      pending.catch(() => {});
      const stopped = await until(() => find(record => record.reason === 'breakpoint'), 30000);
      const local = await pausedLocal(active.customRequest.bind(active), stopped.threadId, fixture);
      vscode.debug.removeBreakpoints([breakpoint]);
      breakpoint = undefined;
      await until(() => find(record => record.assigned === 0 && record.reported === 0), 25000);
      await active.customRequest('continue', { threadId: stopped.threadId });
      assert.equal(await pending, '2');
      const after = await verifyHttp(receipt, fixture);
      assert.deepEqual(after, before);
      assert.equal((await vscode.commands.executeCommand('rocketbrain.micronaut.stop')).state, 'stopped');
      assert.notEqual(vscode.debug.activeDebugSession?.id, active.id);
      await Promise.all([assertClosed(receipt.debug.port), assertClosed(Number(new URL(receipt.baseUrl).port))]);
      return { tool, task: fixture.task, local, before, after, nativeOwnDebugSession: true, closedBothPorts: true };
    } finally {
      tracker.dispose();
      if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
      try { await service.stop(); }
      finally {
        await pending?.catch(() => {});
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
          tab.input?.uri?.scheme === 'file' && within(tab.input.uri.fsPath));
        if (tabs.length) await vscode.window.tabGroups.close(tabs);
        await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
      }
    }
  });
}

async function installed(api, vscode, checks, selected) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api, workspace);
  assert.equal(typeof api.java.micronaut.debug, 'function');
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.micronaut.debug'));
  const evidence = await withOwnedDatabase(async () => {
    const reports = [];
    for (const tool of selected) reports.push(await nativeProject(api, vscode, workspace, tool));
    return { reports };
  });
  checks.push('Micronaut attached to the staged application JVM, paused on the saved Java line, read the JDBC local, and closed its HTTP and JDWP listeners.');
  return evidence;
}

const runMicronautDebugChecks = (api, vscode, checks) => installed(api, vscode, checks, toolsToTest);
const runMicronautMavenDebugChecks = (api, vscode, checks) => installed(api, vscode, checks, ['maven']);
const runMicronautGradleDebugChecks = (api, vscode, checks) => installed(api, vscode, checks, ['gradle']);

module.exports = { runMicronautDebugChecks, runMicronautMavenDebugChecks, runMicronautGradleDebugChecks };
if (require.main === module) withOwnedDatabase(headless).then(value => console.log(JSON.stringify(value))).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
