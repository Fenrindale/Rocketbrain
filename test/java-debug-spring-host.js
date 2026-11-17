'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function until(action, timeout = 180000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await action(); if (value) return value; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 150)); }
  throw last || new Error('Spring project debugger check timed out.');
}

async function runSpringProjectDebugChecks(api, vscode, checks, supplied) {
  const config = supplied || JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.ok(Number.isInteger(config.debugPort) && config.debugPort > 0, 'Spring fixture must be started with debug:true');
  console.log('[Spring debugger test] starting Java engine');
  await api.java.start();
  const project = config.projectPath, source = vscode.Uri.file(path.join(project, 'src/main/java/fixture/boot/ProbeService.java'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source));
  const text = fs.readFileSync(source.fsPath, 'utf8'), marker = text.split(/\r?\n/).findIndex(line => line.includes('// DEBUG_GATE'));
  assert.ok(marker >= 0); const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(marker + 1, 0)), true);
  console.log('[Spring debugger test] resolving application main class');
  const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', vscode.Uri.file(project).toString()))?.find(item => item.mainClass === 'fixture.boot.FixtureApplication'));
  console.log('[Spring debugger test] attaching to application');
  const events = [], sessions = new Map();
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', { createDebugAdapterTracker(session) {
    sessions.set(session.id, session); return { onDidSendMessage(message) { if (message.type === 'event') events.push({ sessionId: session.id, event: message.event, body: message.body }); } };
  } });
  let session, http;
  vscode.debug.addBreakpoints([breakpoint]);
  try {
    assert.equal(await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source), { type: 'rocketbrain-java', request: 'attach', name: `Rocketbrain real Spring Boot ${config.dbEngine}`, hostName: '127.0.0.1', port: config.debugPort, projectName: main.projectName, sourcePaths: config.sourcePaths, stepFilters: { skipClasses: ['java.*', 'jdk.*', 'sun.*', 'org.springframework.*', 'org.hibernate.*'] } }), true);
    session = [...sessions.values()].at(-1); assert.ok(session);
    console.log('[Spring debugger test] waiting for service breakpoint');
    await session.customRequest('setExceptionBreakpoints', { filters: [] });
    http = fetch((config.appURL || config.baseUrl) + '/probe', { signal: AbortSignal.timeout(90000) }); http.catch(() => {});
    const stopped = await until(() => events.find(item => item.sessionId === session.id && item.event === 'stopped' && item.body.reason === 'breakpoint'), 60000);
    console.log('[Spring debugger test] inspecting entity and stepping');
    const { stackFrames } = await session.customRequest('stackTrace', { threadId: stopped.body.threadId }); const top = stackFrames[0];
    assert.match(top.name, /ProbeService.probe/); assert.equal(top.line, marker + 2); assert.ok(top.source?.path?.endsWith('ProbeService.java'));
    const { scopes } = await session.customRequest('scopes', { frameId: top.id }); const variables = [];
    for (const scope of scopes) if (scope.variablesReference) variables.push(...(await session.customRequest('variables', { variablesReference: scope.variablesReference })).variables);
    assert.ok(variables.some(variable => variable.name === 'person' && /Person/.test(variable.type || variable.value)), JSON.stringify(variables));
    assert.ok(variables.some(variable => variable.name === 'result'));
    const person = await session.customRequest('evaluate', { expression: 'person.getDisplayName()', frameId: top.id, context: 'watch' }); assert.equal(person.result, '"Alex"');
    const lazy = await session.customRequest('evaluate', { expression: 'org.hibernate.Hibernate.isInitialized(person.getDepartment())', frameId: top.id, context: 'watch' }); assert.equal(lazy.result, 'false');
    const after = events.length; await session.customRequest('next', { threadId: stopped.body.threadId });
    const step = await until(() => events.slice(after).find(item => item.sessionId === session.id && item.event === 'stopped' && item.body.reason === 'step'), 30000);
    const stepFrame = (await session.customRequest('stackTrace', { threadId: step.body.threadId })).stackFrames[0]; assert.match(stepFrame.name, /ProbeService.probe/);
    const count = await session.customRequest('evaluate', { expression: '((Number) result.get("derivedCount")).intValue()', frameId: stepFrame.id, context: 'watch' }); assert.ok(Number(count.result) >= 1, JSON.stringify(count));
    vscode.debug.removeBreakpoints([breakpoint]); await session.customRequest('continue', { threadId: step.body.threadId });
    const response = await http; assert.equal(response.ok, true); const probe = await response.json();
    assert.equal(probe.department, 'Engineering'); assert.equal(probe.lazyBefore, false); assert.equal(probe.lazyAfter, true);
    await vscode.debug.stopDebugging(session);
    const ready = await fetch((config.appURL || config.baseUrl) + '/probe/ready', { signal: AbortSignal.timeout(10000) }); assert.equal(ready.ok, true, 'Detaching preserves the separately managed Spring application');
    checks.push(`Own Java debugger attaches to the actual Spring Boot/JPA ${config.dbEngine} process, stops in the transactional service, inspects a real entity and lazy proxy, evaluates watches, steps over a repository query and resumes the successful HTTP request.`);
    return { engine: config.dbEngine, processId: config.javaProcessId || config.processId, projectName: main.projectName, type: session.type, topFrame: { name: top.name, source: top.source, line: top.line }, stackSample: stackFrames.slice(0, 8).map(frame => frame.name), locals: variables.filter(variable => ['person', 'result'].includes(variable.name)).map(({ name, type, value }) => ({ name, type, value })), watch: { person: person.result, lazyBefore: lazy.result, derivedCount: count.result }, step: { reason: step.body.reason, line: stepFrame.line }, response: probe, detachedAppStillReady: true, noExternalJavaExtension: true };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]); if (session) await vscode.debug.stopDebugging(session); tracker.dispose();
    if (http) await http.catch(() => {});
  }
}
module.exports = { runSpringProjectDebugChecks };
