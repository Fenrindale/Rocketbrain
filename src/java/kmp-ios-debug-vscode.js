'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createKmpIosDebug } = require('./kmp-ios-debug');
const { createKmpIosDebugAdapter } = require('./kmp-ios-debug-adapter');

const type = 'rocketbrain-kotlin-ios-simulator';
const command = 'rocketbrain.kotlin.multiplatform.debugIosSimulator';
const marker = '__rocketbrainKotlinIosReview';

function local(uri) {
  return uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment;
}

function registerKmpIosDebug(vscode) {
  let active, disposed;
  function trust() {
    if (disposed || !vscode.workspace.isTrusted || vscode.env.remoteName) {
      throw Error('Open a trusted local workspace before debugging an iOS Simulator app.');
    }
  }
  const service = createKmpIosDebug({ trust, saved(source) {
    if (vscode.workspace.textDocuments.some(doc => local(doc.uri) && doc.uri.fsPath === source && doc.isDirty)) {
      throw Error('Save the selected Kotlin source and build the app before reviewing its breakpoint.');
    }
  } });
  async function release(record = active) {
    if (!record) return;
    try { await record.adapter?.dispose(); }
    finally {
      record.emitter?.dispose();
      if (record === active) active = undefined;
    }
  }
  const factory = vscode.debug.registerDebugAdapterDescriptorFactory(type, {
    createDebugAdapterDescriptor(session) {
      const record = active;
      if (!record || record.session || session.type !== type || session.configuration.request !== 'launch' ||
          session.configuration[marker] !== record.review.token) {
        throw Error('Start the simulator debugger from the reviewed Rocketbrain command.');
      }
      record.session = session;
      record.emitter = new vscode.EventEmitter();
      record.adapter = createKmpIosDebugAdapter({ service, review: record.review, send: message => record.emitter.fire(message) });
      return new vscode.DebugAdapterInlineImplementation({
        onDidSendMessage: record.emitter.event,
        handleMessage: message => record.adapter.handleMessage(message),
        dispose: () => record.adapter.dispose()
      });
    }
  });
  const finished = vscode.debug.onDidTerminateDebugSession(session => {
    if (active?.session?.id === session.id) {
      void release().catch(error => vscode.window.showErrorMessage(error.message));
    }
  });
  async function start(document, input) {
    trust();
    if (!local(document?.uri) || document.isDirty || document.isClosed || !document.uri.fsPath.endsWith('.kt')) {
      throw Error('Open and save a local Kotlin source file before reviewing its breakpoint.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!local(folder?.uri) || !local(input.app) || !local(input.dsym)) throw Error('Choose local iOS artifacts in the Kotlin workspace.');
    if (active) throw Error('Stop the current owned iOS simulator session first.');
    const review = await service.review({ root: folder.uri.fsPath, source: document.uri.fsPath, line: input.line,
      app: input.app.fsPath, dsym: input.dsym.fsPath, framework: input.framework, runtime: input.runtime, device: input.device });
    const approved = 'Create Simulator and Debug';
    const detail = [review.source + ':' + review.line, review.app, review.bundleId, 'App SHA-256 ' + review.appSha256,
      'Kotlin framework UUID ' + review.frameworkUuid, review.runtime, review.device,
      'Use the app built with this saved Kotlin source. This session creates and deletes its own simulator.'].join('\n');
    if (await vscode.window.showWarningMessage('Debug the reviewed iOS Simulator app?', { modal: true, detail }, approved) !== approved) return;
    trust();
    if (document.isDirty || document.isClosed || active) throw Error('The reviewed source or simulator session changed.');
    const record = active = { review };
    try {
      if (!await vscode.debug.startDebugging(folder, { type, request: 'launch', name: 'Kotlin iOS: ' + review.bundleId,
        [marker]: review.token }, { suppressSaveBeforeStart: true })) throw Error('VS Code did not start the simulator debug session.');
      return { state: 'starting', source: review.source, line: review.line, bundleId: review.bundleId,
        appSha256: review.appSha256, frameworkUuid: review.frameworkUuid, sourceSha256: review.sourceSha256 };
    } catch (error) { await release(record); throw error; }
  }
  const registered = vscode.commands.registerCommand(command, async () => {
    try {
      trust();
      const inventory = await service.devices();
      const editor = vscode.window.activeTextEditor;
      const document = editor?.document;
      if (!local(document?.uri) || !document.uri.fsPath.endsWith('.kt') || document.isDirty) {
        throw Error('Open saved Kotlin source and select a line with one enabled source breakpoint.');
      }
      const line = editor.selection.active.line + 1;
      if (!vscode.debug.breakpoints.some(item => item.enabled && item.location?.uri.fsPath === document.uri.fsPath &&
        item.location.range.start.line === line - 1 && !item.condition && !item.hitCondition && !item.logMessage)) {
        throw Error('Set a plain source breakpoint on the selected Kotlin line.');
      }
      const options = inventory.runtimes.flatMap(runtime => inventory.deviceTypes
        .filter(device => runtime.deviceIds.has(device.id))
        .map(device => ({ label: device.name, description: runtime.name + ' ' + runtime.version, device: device.id, runtime: runtime.id })));
      if (!options.length) throw Error('Install an iOS Simulator runtime and iPhone device type using Xcode.');
      const target = await vscode.window.showQuickPick(options, { title: 'Select New Owned iOS Simulator' });
      if (!target) return;
      const choose = async (title, suffix) => {
        const [entry] = await vscode.window.showOpenDialog({ title, openLabel: 'Select', canSelectFiles: true,
          canSelectFolders: true, canSelectMany: false }) || [];
        if (entry && (!local(entry) || !entry.fsPath.endsWith(suffix))) throw Error('Select a local ' + suffix + ' directory.');
        return entry;
      };
      const app = await choose('Select the Debug iOS Simulator App', '.app');
      if (!app) return;
      const frameworks = fs.readdirSync(path.join(app.fsPath, 'Frameworks'), { withFileTypes: true })
        .filter(item => item.isDirectory() && item.name.endsWith('.framework')).map(item => item.name);
      const framework = await vscode.window.showQuickPick(frameworks, { title: 'Select the Embedded Kotlin Debug Framework' });
      if (!framework) return;
      const dsym = await choose('Select the Matching Kotlin Framework dSYM', '.dSYM');
      if (dsym) await start(document, { ...target, app, dsym, framework, line });
    } catch (error) { void vscode.window.showErrorMessage('Rocketbrain Kotlin iOS: ' + error.message); }
  });
  return { start, stop: async () => {
    if (active?.session) await vscode.debug.stopDebugging(active.session);
    await release();
  }, dispose() {
    disposed = true;
    registered.dispose();
    finished.dispose();
    factory.dispose();
    return release();
  } };
}

module.exports = { registerKmpIosDebug };
