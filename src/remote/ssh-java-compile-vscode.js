'use strict';

const normalizeLines = text => text.replace(/\r\n/g, '\n');

function registerSshJavaCompile(vscode, command, requireConnection, uriFor) {
  const output = vscode.window.createOutputChannel('Rocketbrain SSH Java Compile');
  let running;

  async function inspect(uri, javaHome, jars) {
    const client = requireConnection(uri);
    const before = await client.read(uri.path);
    const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
    if (document && (document.isDirty ||
        normalizeLines(document.getText()) !== normalizeLines(before.data.toString('utf8')))) {
      throw Error('Reopen the saved remote Java source before reviewing a compile.');
    }
    const review = await client.inspectProcess('compile', { file: uri.path, javaHome, jars });
    if (requireConnection(uri) !== client || review.selectedSha256 !== before.sha256) {
      throw Error('The remote source changed. Reopen the editor and review the module again.');
    }
    return review;
  }

  async function start(uri, approval, signal) {
    const client = requireConnection(uri);
    if (approval?.allowSshJavaCompile !== true) throw Error('Approve the reviewed SSH Java compile first.');
    if (running) throw Error('Wait for the current SSH Java compile to finish.');
    const controller = new AbortController();
    running = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await client.openProcess('compile', {
        token: approval.token, file: uri.path, allowRemoteProcess: true, signal: controller.signal
      });
      if (requireConnection(uri) !== client) throw Error('The SSH workspace connection changed.');
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (running === controller) running = undefined;
    }
  }

  async function openDiagnostic(uri, review, item) {
    const client = requireConnection(uri);
    const relative = (review.module === '/' ? '' : review.module) + '/src/main/java/' + item.path;
    const remote = uriFor(uri.authority, relative);
    const source = await client.read(relative);
    if (requireConnection(remote) !== client || source.sha256 !== item.sha256) {
      throw Error('The remote diagnostic source changed. Compile it again for updated locations.');
    }
    const target = await vscode.workspace.openTextDocument(remote);
    if (target.isDirty || normalizeLines(target.getText()) !== normalizeLines(source.data.toString('utf8'))) {
      throw Error('Reopen the saved remote diagnostic source before navigating.');
    }
    const position = target.validatePosition(new vscode.Position(item.line - 1, item.column - 1));
    await vscode.window.showTextDocument(target, { selection: new vscode.Range(position, position) });
  }

  function logResult(result) {
    if (result.state === 'cancelled') {
      output.appendLine('Compile cancelled.');
      return;
    }
    output.appendLine(result.state === 'compiled'
      ? 'Compiled ' + result.classCount + ' class files in temporary storage. SHA-256 ' + result.artifactSha256
      : 'Java compilation failed.');
    for (const item of result.classes || []) output.appendLine('  ' + item);
    for (const item of result.diagnostics) {
      output.appendLine(item.file + ':' + item.line + ':' + item.column + ' ' + item.code);
    }
    if (result.truncated) output.appendLine('Compiler diagnostics reached their output limit.');
  }

  const editorCommand = command('javaCompile', async entry => {
    const uri = entry?.resourceUri || (entry?.scheme ? entry : vscode.window.activeTextEditor?.document.uri);
    requireConnection(uri);
    const javaHome = await vscode.window.showInputBox({ title: 'Remote Independent JDK 25 Directory' });
    if (!javaHome) return;
    const raw = await vscode.window.showInputBox({ title: 'Optional Workspace JAR Paths',
      prompt: 'Enter workspace-relative paths separated by commas. Leave empty for JDK-only compilation.' });
    if (raw === undefined) return;
    const jars = raw.trim() ? raw.split(',').map(item => item.trim()) : [];
    const review = await inspect(uri, javaHome, jars);
    output.clear();
    output.appendLine('Java 25 compile review');
    output.appendLine(review.user + '@' + review.host + ':' + review.port);
    output.appendLine(review.root + '\n' + review.file + '\n' + review.javaHome);
    output.appendLine(review.sourceCount + ' sources in ' + review.module + ' (' + review.inputSha256 + ')');
    output.appendLine('Dependency JARs\n' + (review.jars.length ? review.jars.join('\n') : 'JDK only'));
    output.show(true);
    const approved = await vscode.window.showWarningMessage('Compile the reviewed remote Java module?', {
      modal: true,
      detail: review.user + '@' + review.host + ':' + review.port + '\n' + review.file + '\n' + review.sourceCount +
        ' sources and ' + review.jars.length + ' dependency JARs. Java 25 class files are checked in temporary storage.'
    }, 'Compile Reviewed Module');
    if (approved !== 'Compile Reviewed Module') return;
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Compiling the reviewed SSH Java module', cancellable: true
    }, async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await start(uri, { token: review.token, allowSshJavaCompile: true }, controller.signal); }
      catch (error) { if (controller.signal.aborted) return { state: 'cancelled' }; throw error; }
      finally { subscription.dispose(); }
    });
    logResult(result);
    output.show(true);
    const first = result.diagnostics?.find(item => item.path);
    if (result.state === 'failed' && first &&
        await vscode.window.showInformationMessage('The remote Java compiler reported errors.', 'Open First Diagnostic') === 'Open First Diagnostic') {
      await openDiagnostic(uri, review, first);
    }
    return result;
  });
  function retire() { running?.abort(); }
  return { inspect, start, openDiagnostic, retire, dispose() { retire(); editorCommand.dispose(); output.dispose(); } };
}

module.exports = { registerSshJavaCompile };
