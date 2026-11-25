'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');

async function runStreamTraceChecks(api,vscode,checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const name = 'RbStreamTrace'+randomBytes(6).toString('hex');
  const file = path.join(workspace,'src/main/java/fixture/boot',name+'.java');
  const pipeline = 'java.util.stream.Stream.of(1, 2, 3, 4, 5).filter(x -> x % 2 == 0)\n' +
    '    .map(x -> x * 10).flatMap(x -> java.util.stream.Stream.of(x,x+1)).limit(3).toList()';
  const content = 'package fixture.boot;\nclass '+name+' {\n  java.util.List<Integer> observe() {\n    return '+pipeline+';\n  }\n}\n';
  await fs.writeFile(file,content,{flag:'wx'});
  try {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.java.traceStream')&&commands.includes('rocketbrain.java.navigateStreamStage'));
    const source = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(source,{preview:false});
    const start = source.offsetAt(new vscode.Position(3,11));
    assert.equal(start,content.indexOf(pipeline));
    const range = new vscode.Range(source.positionAt(start),source.positionAt(start+pipeline.length));
    const service = api.javaSourceAnalysis.streamTrace;
    const receipt = await service.trace(source,range);
    const order = receipt.stages.map(item=>item.name);
    assert.deepEqual(order,['input','filter','map','flatMap','limit','toList']);
    const observed = receipt.events.filter(item=>item.action==='result').map(item=>item.input);
    assert.deepEqual(observed,['20','21','40']);
    assert.ok(!receipt.events.some(item=>item.action==='input'&&item.input==='5'));
    assert.equal(receipt.truncated,false);
    const output = await vscode.workspace.openTextDocument(receipt.uri);
    assert.equal(receipt.uri.scheme,'rocketbrain-java-stream');
    assert.match(output.getText(),/flat value "20" → "21"/);
    const jump = await service.reveal(receipt.uri,3);
    assert.match(jump.document.getText(jump.selection),/^flatMap/);
    const build = await api.java.buildWorkspace();
    assert.ok(build===0||build===1||build?.status==='succeed');
    assert.equal(await fs.readFile(file,'utf8'),content);
    const separator = source.positionAt(content.length);
    assert.ok(await editor.edit(edit=>edit.insert(separator,'// source changed after trace\n')));
    try { await assert.rejects(service.reveal(receipt.uri,3),/source changed/); }
    finally {
      assert.ok(await editor.edit(edit=>edit.delete(new vscode.Range(separator,source.positionAt(source.getText().length)))));
      assert.ok(await source.save());
    }
    const jdbc = await jdbcReadback();
    checks.push('Java Stream generated actual filter/map/flatMap/limit values with a short-circuiting JDK run and precise native source navigation.');
    return { order, observed, shortCircuited:true, staleSourceRejected:true, sourceNavigation:true, springBuild:true,jdbc };
  } finally { await fs.unlink(file); }
}



async function runAdvancedStreamTraceChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api, workspace);
  const name = 'RbAdvancedStreamTrace' + randomBytes(6).toString('hex');
  const file = path.join(workspace, 'src/main/java/fixture/boot', name + '.java');
  const sample = {
    match: 'java.util.stream.IntStream.rangeClosed(1, 20).map(n -> n * 3).filter(n -> n % 2 == 0).anyMatch(n -> n > 8)',
    sorted: 'java.util.stream.IntStream.of(9, 2, 2, 1, 5).distinct().sorted().skip(1).findFirst()',
    count: 'java.util.stream.LongStream.range(9007199254740993L, 9007199254741002L).map(n -> 1L / (n - n)).count()'
  };
  const content = 'package fixture.boot;\nclass ' + name + ' {\n' +
    '  boolean match() { return ' + sample.match + '; }\n' +
    '  java.util.OptionalInt sorted() { return ' + sample.sorted + '; }\n' +
    '  long size() { return ' + sample.count + '; }\n}\n';
  await fs.writeFile(file, content, { flag: 'wx' });
  try {
    const service = api.javaSourceAnalysis.streamTrace;
    const source = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(source, { preview: false });
    const trace = text => {
      const start = source.getText().indexOf(text);
      assert.ok(start > 0);
      return service.trace(source, new vscode.Range(source.positionAt(start), source.positionAt(start + text.length)));
    };
    const matched = await trace(sample.match);
    assert.equal(matched.terminal.value, 'true');
    assert.deepEqual(matched.demand, { evaluation: 'short-circuited', sourceCount: 20, inputEvents: 4 });
    assert.deepEqual(matched.events.filter(event => event.action === 'predicate').map(event => [event.input, event.output]),
      [['6', 'false'], ['12', 'true']]);
    assert.ok(matched.events.every((event, index) => event.sequence === index + 1));
    const output = await vscode.workspace.openTextDocument(matched.uri);
    await vscode.window.showTextDocument(output, { preview: false });
    assert.match(output.getText(), /Evaluation order/);
    assert.match(output.getText(), /anyMatch · predicate "12" → "true" \[java.lang.Integer → java.lang.Boolean\]/);
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input?.uri?.toString() === matched.uri.toString())));
    const reveal = await service.reveal(matched.uri, 3);
    assert.equal(reveal.document.getText(reveal.selection), 'anyMatch(n -> n > 8)');

    const sorted = await trace(sample.sorted);
    assert.equal(sorted.terminal.type, 'java.util.OptionalInt');
    assert.equal(sorted.terminal.value, '2');
    assert.equal(sorted.demand.inputEvents, 5);
    const sortedIndex = sorted.stages.findIndex(stage => stage.name === 'sorted');
    assert.deepEqual(sorted.events.filter(event => event.stage === sortedIndex && event.action === 'emitted').map(event => event.input), ['1', '2']);

    const count = await trace(sample.count);
    assert.deepEqual(count.events, []);
    assert.equal(count.demand.evaluation, 'count-without-traversal');
    assert.equal(count.terminal.value, '9');
    assert.equal(await fs.readFile(file, 'utf8'), content);
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed');
    const jdbc = await jdbcReadback();
    checks.push('Java Stream Trace shows typed primitive events in JDK evaluation order, stateful sort demand, short-circuit, and elided count.');
    return { typedEvents: true, timeline: true, primitive: true, sortedInputEvents: sorted.demand.inputEvents,
      shortCircuitInputs: matched.demand.inputEvents, countWithoutTraversal: true, sourceNavigation: true, springBuild: true, jdbc };
  } finally { await fs.unlink(file); }
}

module.exports = { runStreamTraceChecks, runAdvancedStreamTraceChecks };
