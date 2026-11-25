'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runPythonWorkbenchChecks(api, vscode, checks) {
  const [folder] = vscode.workspace.workspaceFolders || [];
  assert.equal(folder?.uri.scheme, 'file');
  const file = path.join(folder.uri.fsPath, 'rb_python_' + randomUUID().replaceAll('-', '') + '.py');
  const uri = vscode.Uri.file(file);
  await fs.writeFile(file, 'def calculate():\n    amount = 21\n    result = amount * 2\n    return result\n\nprint(calculate())\n', { flag: 'wx' });
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', editor.document.uri);
  assert.equal(symbols.find(item => item.name === 'calculate').selectionRange.start.line, 0);
  const config = api.python.launchConfig(folder, { name: 'Owned Python ' + randomUUID(), program: file });
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(2, 0)));
  let session;
  const events = [];
  const observe = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-python', {
    createDebugAdapterTracker(current) {
      if (current.name !== config.name) return undefined;
      session = current;
      return { onDidSendMessage(message) { if (message?.type === 'event') events.push(message); } };
    }
  });
  vscode.debug.addBreakpoints([breakpoint]);
  async function nextEvent(name, after) {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const event = events.slice(after).find(item => item.event === name);
      if (event) return event.body;
      await delay(70);
    }
    throw Error('The owned Python adapter did not emit ' + name + '.');
  }
  try {
    assert.equal(await vscode.debug.startDebugging(folder, config), true);
    const first = await nextEvent('stopped', 0);
    const { stackFrames: [frame] } = await session.customRequest('stackTrace', { threadId: first.threadId, levels: 1 });
    assert.equal(frame.line, 3);
    assert.equal(path.relative(frame.source.path, file), '');
    const { scopes } = await session.customRequest('scopes', { frameId: frame.id });
    const variablesReference = scopes.find(scope => scope.name === 'Locals').variablesReference;
    const { variables } = await session.customRequest('variables', { variablesReference });
    assert.equal(variables.find(item => item.name === 'amount').value, '21');
    const after = events.length;
    await session.customRequest('next', { threadId: first.threadId });
    const second = await nextEvent('stopped', after);
    const current = await session.customRequest('stackTrace', { threadId: second.threadId, levels: 1 });
    assert.equal(current.stackFrames[0].line, 4);
    await session.customRequest('continue', { threadId: second.threadId });
    await nextEvent('terminated', after);
    const jdbc = await jdbcReadback();
    checks.push('The installed Python workbench produced a native Outline, paused and stepped in debugpy, and read the matching locals.');
    return { outline: true, breakpointLine: frame.line, steppedLine: 4, localValue: '21', jdbc };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    if (session && !events.some(item => item.event === 'terminated')) await vscode.debug.stopDebugging(session);
    observe.dispose();
  }
}

module.exports = { runPythonWorkbenchChecks };
