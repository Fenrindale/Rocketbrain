'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { reviewKotlinNativeLaunch } = require('./kmp-native-review');
const { createKotlinNativeDebugAdapter } = require('./kmp-native-debug-adapter');

const type = 'rocketbrain-kotlin-native';
const command = 'rocketbrain.kotlin.multiplatform.debugNative';
const marker = '__rocketbrainKotlinNativeSession';

function startDeadline(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('VS Code did not start the reviewed Kotlin/Native debugger.')), 30000);
  })]).finally(() => clearTimeout(timer));
}

function registerKotlinNativeDebug(vscode) {
  let active;
  async function release(record = active) {
    if (!record) return;
    return record.closing ||= (async () => {
      try { await record.adapter?.dispose(); }
      finally {
        record.emitter?.dispose();
        if (active === record) active = undefined;
      }
    })();
  }
  const factory = vscode.debug.registerDebugAdapterDescriptorFactory(type, {
    createDebugAdapterDescriptor(session) {
      const record = active;
      if (!record || record.session || record.closing || session.type !== type ||
          session.configuration.request !== 'launch' || session.configuration[marker] !== record.token) {
        throw Error('Start Kotlin/Native using the reviewed Rocketbrain command.');
      }
      const emitter = record.emitter = new vscode.EventEmitter();
      record.session = session;
      record.adapter = createKotlinNativeDebugAdapter({ review: record.review, send(message) {
        emitter.fire(message);
        if (message.type === 'response') {
          if (message.command === 'configurationDone' && message.success) record.started.resolve();
          if (['launch', 'configurationDone'].includes(message.command) && !message.success) {
            record.started.reject(Error(message.message));
          }
        }
      } });
      return new vscode.DebugAdapterInlineImplementation({ onDidSendMessage: emitter.event,
        handleMessage: message => record.adapter.handleMessage(message), dispose: () => record.adapter.dispose() });
    }
  });
  const finished = vscode.debug.onDidTerminateDebugSession(session => {
    if (active?.session?.id === session.id) void release().catch(() => {});
  });

  async function start(document, program, args = []) {
    if (active) throw Error('Finish the previous owned Kotlin/Native debug session first.');
    const local = uri => uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment;
    const trusted = () => {
      if (!vscode.workspace.isTrusted || !local(document?.uri) || document.isDirty || document.isClosed) {
        throw Error('Trust the workspace and save the selected local Kotlin source before debugging.');
      }
    };
    trusted();
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || !local(folder.uri) || !local(program)) throw Error('Choose a local Kotlin/Native workspace and executable.');
    const gdb = vscode.workspace.getConfiguration('rocketbrain.kotlin', document.uri).get('nativeGdbPath', '/usr/bin/gdb');
    const reviewed = reviewKotlinNativeLaunch({ workspace: folder.uri.fsPath, program: program.fsPath,
      source: document.uri.fsPath, args, gdb });
    const review = { ...reviewed, validate(full) { trusted(); reviewed.validate(full); } };
    const confirmation = await vscode.window.showInformationMessage('Launch the reviewed Kotlin/Native executable?',
      { modal: true, detail: ['Executable: ' + review.program, 'SHA-256: ' + review.artifactSha256, 'Source: ' + review.source,
        'GDB: ' + review.gdb, 'Arguments: ' + JSON.stringify(args), 'The application runs locally with terminal I/O disabled.'].join('\n') },
      'Start Kotlin/Native Debugger');
    if (confirmation !== 'Start Kotlin/Native Debugger') return;
    if (active) throw Error('Finish the previous owned Kotlin/Native debug session first.');
    review.validate(true);
    const record = { token: randomUUID(), review };
    const ready = new Promise((resolve, reject) => { record.started = { resolve, reject }; });
    void ready.catch(() => {});
    active = record;
    try {
      const accepted = vscode.debug.startDebugging(folder, {
        type, name: 'Kotlin/Native: ' + path.basename(review.program), request: 'launch', [marker]: record.token
      }, { suppressSaveBeforeStart: true });
      if (!await startDeadline(accepted)) throw Error('VS Code refused the Kotlin/Native debug session.');
      await startDeadline(ready);
      return { state: 'launched', sessionId: record.session.id, artifactSha256: review.artifactSha256,
        sourceSha256: review.sourceSha256, localLinuxX64: true };
    } catch (error) {
      await release(record);
      throw error;
    }
  }

  const registered = vscode.commands.registerCommand(command, async () => {
    try {
      if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Use a Linux x64 extension host for Kotlin/Native.');
      const document = vscode.window.activeTextEditor?.document;
      if (!vscode.workspace.isTrusted || document?.isDirty || !document?.uri?.fsPath.endsWith('.kt')) {
        throw Error('Trust the workspace and open a saved local Kotlin source file.');
      }
      const source = document.uri.fsPath;
      if (!vscode.debug.breakpoints.some(site => site.enabled && site.location?.uri?.fsPath === source)) {
        throw Error('Set an enabled breakpoint in the selected Kotlin source before debugging.');
      }
      const [program] = await vscode.window.showOpenDialog({ title: 'Select the Linux x64 Gradle Debug Executable',
        canSelectFiles: true, canSelectMany: false, filters: { 'Kotlin/Native Executable': ['kexe'] } }) || [];
      if (!program) return;
      const text = await vscode.window.showInputBox({ prompt: 'Application arguments as a JSON string array', value: '[]' });
      if (text === undefined) return;
      return await start(document, program, JSON.parse(text));
    } catch (error) { void vscode.window.showErrorMessage('Rocketbrain Kotlin/Native: ' + error.message); }
  });
  return { start, get active() { return Boolean(active); }, stop: () => release(), dispose() {
    registered.dispose(); factory.dispose(); finished.dispose(); return release();
  } };
}

module.exports = { registerKotlinNativeDebug };
