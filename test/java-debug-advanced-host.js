'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function until(action, timeout = 120000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await action(); if (value) return value; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw last || new Error('Advanced Java debug operation timed out.');
}

async function runJavaAdvancedDebugChecks(api, vscode, checks) {
  await api.java.start();
  const root = path.join(__dirname, 'fixtures/java/debugger'), source = vscode.Uri.file(path.join(root, 'src/main/java/dev/rocketbrain/debug/AdvancedDebugFixture.java'));
  const target = vscode.Uri.file(path.join(root, 'src/main/java/dev/rocketbrain/debug/HcrTarget.java'));
  const sourceText = fs.readFileSync(source.fsPath, 'utf8'), originalTarget = fs.readFileSync(target.fsPath, 'utf8');
  const line = marker => sourceText.split(/\r?\n/).findIndex(value => value.includes(`// ${marker}`));
  const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', vscode.Uri.file(root).toString()))?.find(item => item.mainClass === 'dev.rocketbrain.debug.AdvancedDebugFixture'));
  const events = [], sessions = new Map(), allBreakpoints = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', { createDebugAdapterTracker(session) {
    sessions.set(session.id, session);
    return { onDidSendMessage(message) { if (message.type === 'event') events.push({ sessionId: session.id, event: message.event, body: message.body }); } };
  } });
  const ended = vscode.debug.onDidTerminateDebugSession(session => events.push({ sessionId: session.id, event: 'session-ended' }));
  async function start(mode = 'advanced', stopOnEntry = false) {
    const before = events.length;
    const ok = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source), { type: 'rocketbrain-java', request: 'launch', name: `Advanced debug ${mode}`, mainClass: main.mainClass, projectName: main.projectName, args: [mode], stopOnEntry, console: 'internalConsole', stepFilters: { skipClasses: ['java.*', 'jdk.*', 'sun.*'] } });
    assert.equal(ok, true);
    const stopped = await until(() => events.slice(before).find(item => item.event === 'stopped'));
    return { session: sessions.get(stopped.sessionId), stopped, before };
  }
  const stoppedAfter = (session, before) => until(() => events.slice(before).find(item => item.sessionId === session.id && item.event === 'stopped'));
  async function frame(session, stopped) { return (await session.customRequest('stackTrace', { threadId: stopped.body.threadId })).stackFrames[0]; }
  const evaluate = (session, frameId, expression, context = 'watch') => session.customRequest('evaluate', { expression, frameId, context });
  async function proceed(session, stopped, command = 'continue') { const before = events.length; await session.customRequest(command, { threadId: stopped.body.threadId }); return stoppedAfter(session, before); }
  async function editTarget(text) {
    const document = await vscode.workspace.openTextDocument(target); const edit = new vscode.WorkspaceEdit(); edit.replace(target, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text); assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(await document.save(), true);
  }
  const report = { main, originalIdeRequired: false, externalJavaVsixRequired: false };
  try {
    const add = (marker, condition, hitCondition, logMessage) => { const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(line(marker), 0)), true, condition, hitCondition, logMessage); allBreakpoints.push(breakpoint); return breakpoint; };
    vscode.debug.addBreakpoints([add('CONDITION', 'i == 3'), add('HIT_COUNT', undefined, '3'), add('LOG_POINT', undefined, undefined, 'Rocketbrain log={log}'), add('MUTATION_GATE'), add('HCR_GATE'), add('HCR_AFTER')]);
    let { session, stopped, before } = await start();
    report.adapterCapabilities = api.java.debug.getState(session.id)?.capabilities;
    assert.equal(report.adapterCapabilities.supportsSetExpression, true);
    let current = await frame(session, stopped); assert.equal(current.line, line('CONDITION') + 1); assert.equal((await evaluate(session, current.id, 'i')).result, '3');
    report.condition = { line: current.line, expression: 'i == 3', observed: '3' };
    stopped = await proceed(session, stopped); current = await frame(session, stopped); assert.equal(current.line, line('HIT_COUNT') + 1); assert.equal((await evaluate(session, current.id, 'hit')).result, '3');
    report.hitCount = { hitCondition: '3', observed: '3' };
    stopped = await proceed(session, stopped); current = await frame(session, stopped); assert.equal(current.line, line('MUTATION_GATE') + 1);
    const logs = events.slice(before).filter(item => item.sessionId === session.id && item.event === 'output' && item.body.output.includes('Rocketbrain log='));
    for (const expected of ['1', '2', '3']) assert.ok(logs.some(item => item.body.output.includes(`Rocketbrain log=${expected}`)), JSON.stringify(logs));
    report.logPoints = logs.map(item => item.body.output.trim());
    assert.equal((await evaluate(session, current.id, 'mutable + box.value')).result, '5');
    const { scopes } = await session.customRequest('scopes', { frameId: current.id }); let locals;
    for (const scope of scopes) { const values = await session.customRequest('variables', { variablesReference: scope.variablesReference }); if (values.variables.some(item => item.name === 'mutable')) locals = scope; }
    assert.ok(locals); const mutation = await session.customRequest('setVariable', { variablesReference: locals.variablesReference, name: 'mutable', value: '7' }); assert.equal(mutation.value, '7');
    await assert.rejects(() => session.customRequest('setVariable', { variablesReference: locals.variablesReference, name: 'mutable', value: '"wrong-type"' }));
    const expression = await session.customRequest('setExpression', { frameId: current.id, expression: 'box.value', value: '41' }); assert.equal(expression.value, '41');
    await assert.rejects(() => session.customRequest('setExpression', { frameId: current.id, expression: 'box.value', value: '"wrong-type"' }));
    const stringExpression = await session.customRequest('setExpression', { frameId: current.id, expression: 'box.text', value: '"edited"' }); assert.equal(stringExpression.value, '"edited"');
    assert.equal((await evaluate(session, current.id, 'mutable + box.value')).result, '48'); assert.equal((await evaluate(session, current.id, 'box.text')).result, '"edited"');
    report.mutation = { watchBefore: 5, setVariable: mutation, setExpression: expression, stringExpression, watchAfter: 48, invalidIntAssignmentRejected: true, invalidExpressionAssignmentRejected: true };
    stopped = await proceed(session, stopped, 'next'); current = await frame(session, stopped); assert.equal(current.line, line('STEP_IN') + 1);
    stopped = await proceed(session, stopped, 'stepIn'); current = await frame(session, stopped); assert.match(current.name, /helper/); assert.equal((await evaluate(session, current.id, 'input')).result, '7');
    stopped = await proceed(session, stopped, 'stepOut'); current = await frame(session, stopped); assert.match(current.name, /main/);
    report.stepping = { stepIn: 'helper(input=7)', stepOut: current.name };
    stopped = await proceed(session, stopped); current = await frame(session, stopped); assert.equal(current.line, line('HCR_GATE') + 1); assert.equal((await evaluate(session, current.id, 'before')).result, '10');
    await editTarget(originalTarget.replace('return 10;', 'return 77;'));
    const reload = await vscode.commands.executeCommand('rocketbrain.java.hotCodeReplace', session.id); assert.equal(reload.success, true, JSON.stringify(reload)); assert.ok(reload.changedClasses.includes('dev.rocketbrain.debug.HcrTarget'), JSON.stringify(reload));
    assert.equal((await evaluate(session, current.id, 'target.value()')).result, '77');
    stopped = await proceed(session, stopped); current = await frame(session, stopped); assert.equal(current.line, line('HCR_AFTER') + 1); assert.equal((await evaluate(session, current.id, 'after')).result, '77');
    const hcr = events.filter(item => item.sessionId === session.id && item.event === 'hotcodereplace').map(item => item.body);
    assert.ok(hcr.some(item => item.changeType === 'BUILD_COMPLETE')); assert.ok(hcr.some(item => item.changeType === 'END'));
    report.hotCodeReplace = { before: 10, after: 77, sameSession: session.id, command: 'rocketbrain.java.hotCodeReplace', reload, events: hcr };
    await editTarget(originalTarget.replace('public class HcrTarget {', 'public class HcrTarget {\n    public int addedField = 1;').replace('return 10;', 'return 77;'));
    const structural = await vscode.commands.executeCommand('rocketbrain.java.hotCodeReplace', session.id); assert.equal(structural.success, false, JSON.stringify(structural)); assert.match(structural.error, /JVM rejected|redefin|schema|structur/i); report.structuralChange = { rejected: true, error: structural.error };
    await vscode.debug.stopDebugging(session); vscode.debug.removeBreakpoints(allBreakpoints);
    await editTarget(originalTarget); await api.java.executeWorkspaceCommand('vscode.java.buildWorkspace', JSON.stringify({ mainClass: main.mainClass, projectName: main.projectName, isFullBuild: false }));
    report.exceptions = [];
    for (const kind of ['caught', 'uncaught']) {
      const launch = await start(kind, true); session = launch.session; stopped = launch.stopped;
      await session.customRequest('setExceptionBreakpoints', { filters: [kind] });
      stopped = await proceed(session, stopped);
      assert.equal(stopped.body.reason, 'exception');
      const info = await session.customRequest('exceptionInfo', { threadId: stopped.body.threadId });
      assert.match(JSON.stringify(info), kind === 'caught' ? /caught-fixture|IllegalStateException/ : /uncaught-fixture|IllegalArgumentException/);
      assert.ok(info.exceptionId); report.exceptions.push({ filter: kind, info });
      await session.customRequest('setExceptionBreakpoints', { filters: [] }); await session.customRequest('continue', { threadId: stopped.body.threadId });
      await until(() => events.find(item => item.sessionId === session.id && item.event === 'terminated'));
    }
    checks.push('Advanced own Java debugger verifies conditional/hit/log breakpoints, caught and uncaught exceptionInfo, watch evaluation, typed variable/expression mutation, step in/out, and manual compile/redefine hot code replace in one live JVM; structural changes fail visibly.');
    return report;
  } finally {
    vscode.debug.removeBreakpoints(allBreakpoints); await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    if (fs.readFileSync(target.fsPath, 'utf8') !== originalTarget) { await editTarget(originalTarget); await api.java.executeWorkspaceCommand('vscode.java.buildWorkspace', JSON.stringify({ mainClass: main.mainClass, projectName: main.projectName, isFullBuild: false })).catch(() => {}); }
    tracker.dispose(); ended.dispose();
  }
}
module.exports = { runJavaAdvancedDebugChecks };
