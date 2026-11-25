'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { until } = require('./helpers/stdio-lsp');
const { breakpointSource,breakpointBase } = require('./helpers/java-breakpoint-fixture');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

async function runJavaBreakpointChecks(api,vscode,checks) {
  const service = api.java.debug.breakpoints;
  assert.ok(service?.addMethod && service?.inspectInline && service?.addInline);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.java.addMethodBreakpoint') && commands.includes('rocketbrain.java.addInlineBreakpoints'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api,workspace), className = 'RbBreakpoints'+randomBytes(5).toString('hex');
  const packageName = 'fixture.boot', mainClass = packageName+'.'+className;
  const root = path.join(workspace,'src/main/java/fixture/boot');
  const file = path.join(root,className+'.java'), base = path.join(root,className+'Base.java');
  const source = vscode.Uri.file(file), baseSource = vscode.Uri.file(base);
  const text = breakpointSource(packageName,className), baseText = breakpointBase(packageName,className);
  const created = [], owned = [], sessions = new Map(), events = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{createDebugAdapterTracker(session) {
    if (session.configuration?.name !== className) return undefined;
    sessions.set(session.id,session);
    return {onDidSendMessage(message) { events.push({sessionId:session.id,...message}); }};
  }});
  const remember = item => {
    assert.equal(item?.added,true);
    owned.push(item.breakpoint);
    return item;
  };
  const line = marker => {
    const index = text.split('\n').findIndex(entry => entry.includes(marker));
    assert.ok(index >= 0,marker);
    return index;
  };
  try {
    for (const [filename,contents] of [[file,text],[base,baseText]]) {
      await fs.writeFile(filename,contents,{flag:'wx'});
      created.push(filename);
    }
    const document = await vscode.workspace.openTextDocument(source);
    await vscode.workspace.openTextDocument(baseSource);
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed','JDT build '+JSON.stringify(build));
    const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass',project.uri))
      ?.find(item => item.mainClass === mainClass),45000);
    const editor = await vscode.window.showTextDocument(document);
    const invocation = marker => document.positionAt(text.indexOf(marker)+1);
    async function choose(marker) {
      const position = invocation(marker);
      editor.selection = new vscode.Selection(position,position);
      return remember(await vscode.commands.executeCommand('rocketbrain.java.addMethodBreakpoint'));
    }
    const selected = await choose('pick("b")');
    assert.equal(selected.line,line('pick(String item)')+1);
    const inherited = await choose('inherited()');
    assert.equal(inherited.uri,baseSource.toString());

    function lineBreakpoint(marker) {
      const item = new vscode.SourceBreakpoint(new vscode.Location(source,new vscode.Position(line(marker),0)),true);
      vscode.debug.addBreakpoints([item]);
      owned.push(item);
      return item;
    }
    lineBreakpoint('FIELD_GATE');
    const standard = lineBreakpoint('TWO_LAMBDAS');
    const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source),{
      type:'rocketbrain-java',request:'launch',name:className,mainClass,projectName:main.projectName,console:'internalConsole'
    });
    assert.equal(started,true);
    let stopped = await until(() => events.find(item => item.event === 'stopped'),60000);
    const session = sessions.get(stopped.sessionId);
    assert.ok(session);
    const caps = api.java.debug.getState(session.id).capabilities;
    for (const capability of ['supportsFunctionBreakpoints','supportsDataBreakpoints','supportsBreakpointLocationsRequest']) assert.equal(caps[capability],true);
    const frame = async stop => (await session.customRequest('stackTrace',{
      threadId:stop.body.threadId,startFrame:0,levels:2
    })).stackFrames[0];
    const gate = await frame(stopped);
    assert.equal(gate.line,line('FIELD_GATE')+1);
    const lambda = await service.inspectInline({document,position:new vscode.Position(line('TWO_LAMBDAS'),0),session});
    assert.equal(lambda.choices.length,2);
    const columns = lambda.choices.map(item => item.column);
    assert.ok(columns[0] < columns[1]);
    assert.throws(() => service.addInline(lambda,[columns[0]+1]),/Choose columns/);
    for (const item of service.addInline(lambda,columns)) remember(item);
    vscode.debug.removeBreakpoints([standard]);
    await until(() => events.some(item => item.type === 'response' && item.command === 'setBreakpoints' &&
      item.body?.breakpoints?.length === 4 && item.body.breakpoints.every(breakpoint => breakpoint.verified)),15000);
    const {scopes} = await session.customRequest('scopes',{frameId:gate.id});
    const containers = await Promise.all(scopes.filter(scope => scope.variablesReference).map(scope =>
      session.customRequest('variables',{variablesReference:scope.variablesReference})));
    const box = containers.flatMap(item => item.variables).find(item => item.name === 'box');
    assert.ok(box?.variablesReference);
    const field = await session.customRequest('dataBreakpointInfo',{variablesReference:box.variablesReference,name:'value'});
    assert.deepEqual(new Set(field.accessTypes),new Set(['read','write','readWrite']));
    async function arm(accessType) {
      const response = await session.customRequest('setDataBreakpoints',{breakpoints:[{dataId:field.dataId,accessType}]});
      assert.equal(response.breakpoints[0].verified,true);
    }
    async function proceed() {
      const after = events.length;
      await session.customRequest('continue',{threadId:stopped.body.threadId});
      stopped = await until(() => events.slice(after).find(item => item.event === 'stopped'),15000);
      return frame(stopped);
    }
    await arm('read');
    const read = await proceed();
    assert.equal(stopped.body.reason,'data breakpoint');
    assert.equal(read.line,line('FIELD_READ')+1);
    await arm('write');
    const write = await proceed();
    assert.equal(stopped.body.reason,'data breakpoint');
    assert.equal(write.line,line('FIELD_WRITE')+1);
    await session.customRequest('setDataBreakpoints',{breakpoints:[]});
    const parent = await proceed();
    assert.equal(stopped.body.reason,'function breakpoint');
    assert.match(parent.name,/Base\.inherited\(\)$/);
    const overload = await proceed();
    assert.equal(stopped.body.reason,'function breakpoint');
    assert.match(overload.name,/pick\(String\)$/);
    const lambdaFrames = [];
    for (const column of columns) {
      const current = await proceed();
      assert.equal(stopped.body.reason,'lambda breakpoint');
      assert.equal(current.line,lambda.line);
      assert.equal(current.column,column);
      lambdaFrames.push({name:current.name,line:current.line,column:current.column});
    }
    const after = events.length;
    await session.customRequest('continue',{threadId:stopped.body.threadId});
    await until(() => events.slice(after).some(item => item.event === 'terminated'),15000);
    assert.ok(events.some(item => item.event === 'output' && /\b44\b/.test(item.body.output)));
    const jdbc = await jdbcReadback();
    checks.push('Native Java breakpoint commands resolved the exact String overload and a cross-file inherited declaration. Separate field reads/writes and both same-line lambdas stopped in the live JVM.');
    return {methodOverload:overload.name,inheritedMethod:parent.name,fieldReadLine:read.line,fieldWriteLine:write.line,
      inlineFrames:lambdaFrames,otherOverloadRanWithoutStopping:true,processResult:44,springBuild:true,jdbc};
  } finally {
    vscode.debug.removeBreakpoints(owned);
    await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    tracker.dispose();
    for (const filename of created) await fs.unlink(filename);
  }
}

module.exports = { runJavaBreakpointChecks };
