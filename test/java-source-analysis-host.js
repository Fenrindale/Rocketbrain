'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function importedSpring(api,root) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const snapshot = await api.java.workbench.refresh();
      const project = snapshot.projects.find(entry => !path.relative(entry.root,root));
      if (project?.sourceRoots.length) return project;
    } catch (error) {
      if (!error.message.startsWith('Java project metadata timed out.')) throw error;
    }
    await new Promise(resolve => setTimeout(resolve,600));
  }
  throw Error('JDT did not import the Spring source analysis project.');
}

async function jdbcReadback() {
  if (!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) return null;
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(config.baseUrl + '/probe/testing-state',{signal:AbortSignal.timeout(6000)});
  assert.equal(response.ok,true);
  const jdbc = await response.json();
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  return jdbc;
}

async function runJavaSourceAnalysisChecks(api,vscode,checks) {
  const service = api.javaSourceAnalysis;
  assert.ok(service);
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api,workspace);
  const name = 'RbFlow' + randomBytes(5).toString('hex');
  const file = path.join(workspace,'src/main/java/fixture/boot',name + '.java'), uri = vscode.Uri.file(file);
  const source = [
    'package fixture.boot;',
    'public final class ' + name + ' implements java.io.Serializable {',
    '    static final class Nested {}',
    '    int scale(int seed) {',
    '        int /* first */ first = seed + 3;',
    '        var scaled = first * 2;',
    '        first = scaled - 1;',
    '        return first;',
    '    }',
    '    int conditional(int seed) { if (seed < 0) return 0; return seed; }',
    '}',
    ''
  ].join('\n');
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-class-graph-'));
  const save = path.join(temp,'spring.mmd');
  let panel, document, created = false;
  try {
    await fs.writeFile(file,source,{flag:'wx'});
    created = true;
    document = await vscode.workspace.openTextDocument(uri);
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed','JDT project build ' + JSON.stringify(build));
    const diagram = await service.diagram({projectUri:project.uri});
    const scopedType = diagram.nodes.find(node => node.id === 'fixture.boot.' + name);
    assert.ok(scopedType?.members.some(member => member.name === 'scale'));
    assert.ok(diagram.edges.some(edge => edge.from === 'fixture.boot.CashPayment' &&
      edge.kind === 'extends' && edge.to === 'fixture.boot.PaymentBase'));
    assert.ok(diagram.edges.some(edge => edge.from === scopedType.id && edge.kind === 'implements' && edge.to === 'java.io.Serializable'));
    assert.ok(diagram.edges.some(edge => edge.from === scopedType.id + '.Nested' &&
      edge.kind === 'nestedIn' && edge.to === scopedType.id));
    panel = service.showDiagram(diagram);
    assert.equal(panel.viewType,'rocketbrainJavaClassDiagram');
    assert.match(panel.webview.html,/fixture\.boot\.PaymentBase/);
    assert.match(panel.webview.html,/Export Mermaid/);
    const currentSource = await service.reveal(diagram,scopedType.location);
    assert.equal(path.relative(currentSource.document.uri.fsPath,file),'');
    await service.exportMermaid(diagram,vscode.Uri.file(save));
    const saved = await fs.readFile(save,'utf8');
    assert.match(saved,/^classDiagram\n/);
    assert.ok(saved.includes('fixture.boot.' + name));
    assert.match(saved,/\.\.\|>/);
    await assert.rejects(service.exportMermaid(diagram,vscode.Uri.file(save)),/already exists/);
    const position = document.positionAt(source.indexOf('var scaled') + 4);
    const trace = await service.trace({document,position});
    assert.equal(trace.origin.name,'scaled');
    assert.ok(trace.inputs.some(event => event.kind === 'parameter' && event.name === 'seed'));
    const first = trace.inputs.find(event => event.kind === 'definition' && event.name === 'first');
    assert.equal(first.start,source.indexOf('first = seed'));
    assert.ok(trace.uses.some(event => event.kind === 'assignment' && event.name === 'first'));
    assert.ok(trace.uses.some(event => event.kind === 'return'));
    const value = await service.reveal(trace,first);
    assert.equal(value.document.getText(value.selection),'first');
    await assert.rejects(service.trace({document,position:document.positionAt(source.lastIndexOf('return seed'))}),/straight-line/);
    const token = new vscode.CancellationTokenSource();
    token.cancel();
    try {
      await assert.rejects(service.trace({document,position,cancellation:token.token}),/cancelled/);
    } finally { token.dispose(); }
    const change = new vscode.WorkspaceEdit();
    change.insert(uri,document.positionAt(source.length),'// Changed after analysis\n');
    assert.equal(await vscode.workspace.applyEdit(change),true);
    await assert.rejects(service.reveal(diagram,scopedType.location),/Save|changed/);
    await assert.rejects(service.reveal(trace,first),/Save|changed/);
    const jdbc = await jdbcReadback();
    checks.push('Javac-backed Spring class diagram opened in a native panel and linked real inheritance, implementation and nested declarations to source. Mermaid exported, preserved existing destination, and the straight-line data-flow view resolved formal inputs and downstream reads with precise source ranges and stale/refusal checks.');
    return { types:diagram.localCount,relations:diagram.edges.length,sourceFiles:diagram.sourceFiles,
      nativeDiagram:true,mermaid:true,flowInputs:trace.inputs.length,flowUses:trace.uses.length,
      preciseSource:true,unsupportedRefused:true,staleRefused:true,cancellation:true,jdbc };
  } finally {
    panel?.dispose();
    if (document?.isDirty) await document.save();
    if (created) await fs.unlink(file);
    await fs.unlink(save).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(temp);
  }
}

module.exports = { runJavaSourceAnalysisChecks, importedSpring, jdbcReadback };
