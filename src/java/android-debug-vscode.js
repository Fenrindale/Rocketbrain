'use strict';

const path = require('node:path');
const { createAndroidDebug } = require('./android-debug');

function registerAndroidDebug(vscode, java) {
  const output = vscode.window.createOutputChannel('Rocketbrain Kotlin Android');
  let active;
  function trusted() {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw Error('Open a trusted local workspace to debug an Android emulator.');
  }
  const service = createAndroidDebug({
    trusted,
    saved(file) {
      if (vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && !path.relative(file, doc.uri.fsPath) && doc.isDirty)) {
        throw Error('Save the selected Kotlin file before reviewing the Android breakpoint.');
      }
    },
    getTools() {
      const config = vscode.workspace.getConfiguration('rocketbrain.kotlin.android');
      return { sdk: config.get('sdkPath') || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT,
        buildTools: config.get('buildToolsVersion') || '35.0.0', port: config.get('adbPort') || 5037,
        javaHome: java.getState().javaHome || vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome') };
    }
  });
  async function launch() {
    trusted();
    const editor = vscode.window.activeTextEditor, document = editor?.document;
    if (document?.uri.scheme !== 'file' || document.languageId !== 'kotlin' || document.isDirty) {
      throw Error('Open a saved Android Kotlin class and select the intended breakpoint line.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder?.uri.scheme !== 'file') throw Error('Open the Android project as a local workspace folder.');
    const line = editor.selection.active.line + 1;
    const emulators = await service.devices();
    if (!emulators.length) throw Error('Start a local Android emulator using the Android SDK before debugging.');
    const selected = await vscode.window.showQuickPick(emulators.map(item => ({ label: item.serial, device: item })),
      { title: 'Select Local Android Emulator' });
    if (!selected) return;
    const [apk] = await vscode.window.showOpenDialog({ title: 'Select the Current Debuggable APK', defaultUri: folder.uri,
      filters: { 'Android APK': ['apk'] }, canSelectFiles: true, canSelectMany: false }) || [];
    if (apk?.scheme !== 'file') return;
    const review = await service.review({ root: folder.uri.fsPath, apk: apk.fsPath, file: document.uri.fsPath, line, serial: selected.device.serial });
    const approve = 'Install and Debug';
    const detail = [
      review.avd + ' (' + review.serial + ')',
      review.packageName + '/' + review.activity,
      review.apk,
      'SHA-256 ' + review.apkSha256,
      review.source + ':' + review.sourceLine,
      'Use source from this APK build. Stop removes the installation if it still matches the reviewed APK.'
    ].join('\n');
    const confirmed = await vscode.window.showWarningMessage('Temporarily install the reviewed APK on this emulator?', { modal: true, detail }, approve);
    if (confirmed !== approve) return;
    const launched = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting the reviewed Android debugger' },
      () => service.start(review.token, true));
    active = launched;
    output.show(true);
    output.appendLine('Waiting for ' + review.className + ':' + review.sourceLine + ' on ' + review.avd + '. Trigger the code in the emulator.');
    void launched.waitForStop().then(async stop => {
      if (active !== launched) return;
      output.appendLine('Paused at ' + stop.className + ':' + stop.line);
      for (const local of stop.locals) output.appendLine('  ' + local.name + ' (' + local.type + ') = ' + local.value);
      output.appendLine('Run Continue Kotlin Android Breakpoint to resume.');
      const target = await vscode.workspace.openTextDocument(vscode.Uri.file(stop.source));
      await vscode.window.showTextDocument(target, {
        selection: new vscode.Range(stop.line - 1, 0, stop.line - 1, 0), preview: true
      });
    }).catch(error => {
      if (active === launched) {
        active = undefined;
        void vscode.window.showErrorMessage(error.message);
      }
    });
  }
  const action = (name, run) => vscode.commands.registerCommand('rocketbrain.kotlin.android.' + name,
    () => Promise.resolve().then(run).catch(error => { void vscode.window.showErrorMessage(error.message); }));
  const commands = [
    action('debugApk', launch),
    action('continue', async () => {
      trusted();
      if (!active) throw Error('Start a reviewed Android source debug session first.');
      await active.resume();
      output.appendLine('Continued and detached. Stop Kotlin Android Debug removes the temporary APK.');
    }),
    action('stop', async () => {
      active = undefined;
      await service.stop();
    })
  ];
  return { async dispose() {
    active = undefined;
    for (const command of commands) command.dispose();
    output.dispose();
    await service.dispose();
  } };
}

module.exports = { registerAndroidDebug };
