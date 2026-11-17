'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { freePort } = require('./java-debug-dap');

async function eventually(action, timeout = 120000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await action(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw last || new Error('Timed out waiting for Rocketbrain Java debugging.');
}

async function runJavaDebugChecks(api, vscode, checks) {
  assert.ok(api.java); await api.java.start(); assert.ok(api.java.getState().debugBundlePath, 'Independent debug bundle is configured');
  const root = path.join(__dirname, 'fixtures/java/maven'), source = vscode.Uri.file(path.join(root, 'src/main/java/dev/rocketbrain/Greeter.java'));
  const rootUri = vscode.Uri.file(root).toString();
  const main = await eventually(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', rootUri))?.find(item => item.mainClass === 'dev.rocketbrain.App'));
  // The language-provider test deliberately changes then restores this fixture in memory.
  for (const document of vscode.workspace.textDocuments) if (document.languageId === 'java' && document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath.startsWith(root) && document.getText() === fs.readFileSync(document.uri.fsPath, 'utf8')) {
    await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  const events = [], sessions = new Map();
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', { createDebugAdapterTracker(session) {
    sessions.set(session.id, session);
    return { onDidSendMessage(message) { if (message.type === 'event') events.push({ sessionId: session.id, event: message.event, body: message.body }); }, onError(error) { events.push({ sessionId: session.id, event: 'tracker-error', body: { message: error.message } }); } };
  } });
  const ended = vscode.debug.onDidTerminateDebugSession(session => { if (session.type === 'rocketbrain-java') events.push({ sessionId: session.id, event: 'session-ended' }); });
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(4, 0)), true);
  vscode.debug.addBreakpoints([breakpoint]); const reports = [];
  let child;
  try {
    async function exercise(request, extra, forceTerminate = false) {
      const before = events.length;
      const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source), { type: 'rocketbrain-java', name: `Rocketbrain integration ${request}`, request, projectName: main.projectName, ...extra });
      assert.equal(started, true, `Own ${request} provider starts the actual VS Code session`);
      const stopped = await eventually(() => events.slice(before).find(event => event.event === 'stopped' && event.body.reason === 'breakpoint'));
      const session = sessions.get(stopped.sessionId); assert.ok(session); assert.equal(session.type, 'rocketbrain-java');
      const { threads } = await session.customRequest('threads'); assert.ok(threads.some(thread => thread.id === stopped.body.threadId));
      const { stackFrames } = await session.customRequest('stackTrace', { threadId: stopped.body.threadId }); assert.equal(stackFrames[0].line, 5); assert.match(stackFrames[0].name, /greet/);
      const { scopes } = await session.customRequest('scopes', { frameId: stackFrames[0].id }); const variables = [];
      for (const scope of scopes) if (scope.variablesReference) variables.push(...(await session.customRequest('variables', { variablesReference: scope.variablesReference })).variables);
      assert.ok(variables.some(variable => variable.name === 'name' && variable.value.includes('Rocketbrain')), JSON.stringify(variables));
      const stepAt = events.length; await session.customRequest('next', { threadId: stopped.body.threadId });
      const step = await eventually(() => events.slice(stepAt).find(event => event.sessionId === session.id && event.event === 'stopped' && event.body.reason === 'step'));
      if (forceTerminate) await vscode.debug.stopDebugging(session);
      else await session.customRequest('continue', { threadId: step.body.threadId });
      await eventually(() => events.slice(before).find(event => event.sessionId === session.id && event.event === (forceTerminate ? 'session-ended' : 'terminated')));
      reports.push({ request, type: session.type, topFrame: { name: stackFrames[0].name, line: stackFrames[0].line, source: stackFrames[0].source }, variable: variables.filter(variable => variable.name === 'name').map(({ name, value, type }) => ({ name, value, type })), stepReason: step.body.reason, terminated: true, forcedTermination: forceTerminate });
      await vscode.debug.stopDebugging(session);
    }
    await exercise('launch', { mainClass: main.mainClass, console: 'internalConsole' });
    const [, classPaths] = await api.java.executeWorkspaceCommand('vscode.java.resolveClasspath', main.mainClass, main.projectName);
    const javaExec = await api.java.executeWorkspaceCommand('vscode.java.resolveJavaExecutable', main.mainClass, main.projectName);
    const port = await freePort(); child = spawn(javaExec, [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`, '-cp', classPaths.join(path.delimiter), main.mainClass], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    await eventually(() => output.includes('Listening for transport dt_socket'), 15000);
    await exercise('attach', { hostName: '127.0.0.1', port });
    await exercise('launch', { mainClass: main.mainClass, console: 'internalConsole' }, true);
    checks.push('Rocketbrain own Java debugger launches and attaches real JVMs in VS Code; source breakpoint, stack, local variables, next step, continue and termination are verified.');
    return { type: 'rocketbrain-java', sessions: reports, externalJavaVsixRequired: false, originalIdeRequired: false };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    if (child && child.exitCode === null) child.kill(); tracker.dispose(); ended.dispose();
  }
}

module.exports = { runJavaDebugChecks };
