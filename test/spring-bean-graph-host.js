'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function runSpringBeanGraphChecks(api,vscode,checks) {
  const graph = api.java?.spring?.beanGraph, observer = api.java?.spring?.runtime;
  assert.ok(graph && observer);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.spring.beanGraph'));
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(runtime.runtimeUrl,/^http:\/\/127\.0\.0\.1:\d+\/actuator$/);
  assert.match(runtime.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const actual = await observer.connect({url:runtime.runtimeUrl,timeoutMs:10000,maxResponseBytes:4*1024*1024});
  try {
    assert.equal(actual.state,'connected');
    const endpoint = actual.contexts.flatMap(item => item.beans).find(bean => bean.name === 'probeController');
    assert.ok(endpoint?.dependencies.includes('probeService'),'The real Spring container reports the controller/service dependency.');
  } finally { observer.disconnect(); }

  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const root = path.join(workspace,'src/main/java/fixture/boot');
  const tag = 'RbGraph'+randomBytes(5).toString('hex');
  const name = key => tag + key;
  const beanName = key => tag[0].toLowerCase() + tag.slice(1) + key;
  const qualifier = key => '@Qualifier("' + beanName(key) + '") ';
  const component = key => '@Component("' + beanName(key) + '") ';
  const header = 'package fixture.boot;\nimport org.springframework.stereotype.Component;\n' +
    'import org.springframework.beans.factory.ObjectProvider;\n' +
    'import org.springframework.beans.factory.annotation.Autowired;\n' +
    'import org.springframework.beans.factory.annotation.Qualifier;\n' +
    'import org.springframework.beans.factory.annotation.Value;\n';
  const units = {
    A:component('A') + 'class '+name('A')+' { '+name('A')+'('+qualifier('B')+name('B')+' dependency) {} '+
      '@Value("${private.spring.graph:test-private-bean-graph-value}") String hidden; }',
    B:component('B') + 'class '+name('B')+' { @Autowired '+qualifier('A')+name('A')+' reverse; }',
    Provider:component('Provider') + 'class '+name('Provider')+' { '+name('Provider')+
      '('+qualifier('A')+'ObjectProvider<'+name('A')+'> lazy) {} }',
    Port:'interface '+name('Port')+' {}',
    First:component('First') + qualifier('Port')+'class '+name('First')+' implements '+name('Port')+' {}',
    Second:component('Second') + qualifier('Port')+'class '+name('Second')+' implements '+name('Port')+' {}',
    Ambiguous:component('Ambiguous') + 'class '+name('Ambiguous')+' { '+name('Ambiguous')+
      '('+qualifier('Port')+name('Port')+' port) {} }'
  };
  const files = [], panels = [];
  let editedDocument, original;
  try {
    for (const [key,text] of Object.entries(units)) {
      const file = path.join(root,name(key)+'.java');
      await fs.writeFile(file,header+text+'\n',{flag:'wx'});
      files.push(file);
    }
    const report = await graph.capture({refreshModel:true});
    assert.equal(report.mode,'spring-local-bean-dependencies');
    const existingController = report.nodes.find(item => item.name === 'probeController');
    const existingService = report.sites.find(item => item.owner === existingController?.id && item.name === 'service');
    assert.ok(existingController && existingService);
    assert.equal(existingService.state,'unknown','Externally influenced dependencies remain unknown in the local model.');
    const bean = key => report.nodes.find(node => node.name === beanName(key));
    const site = (key,member) => report.sites.find(item => item.owner === bean(key)?.id && item.name === member);
    const observedCycle = report.cycles.find(item => item.members.includes(bean('A')?.id));
    assert.ok(observedCycle);
    assert.deepEqual(new Set(observedCycle.members),new Set([bean('A').id,bean('B').id]));
    assert.equal(observedCycle.witness.length,2);
    const uncertain = site('Ambiguous','port'), deferred = site('Provider','lazy');
    assert.equal(uncertain.state,'ambiguous');
    assert.equal(uncertain.relation,'candidate');
    assert.deepEqual(new Set(uncertain.targets),new Set([bean('First').id,bean('Second').id]));
    assert.equal(deferred.relation,'deferred');
    assert.ok(report.cycles.every(item => !item.members.includes(bean('Provider').id)));
    const displayed = graph.layout(report,{focus:bean('Ambiguous').id,includeCandidates:true});
    const resolvedOnly = graph.layout(report,{focus:bean('Ambiguous').id});
    assert.ok(displayed.links.some(link => link.kind === 'candidate'));
    assert.ok(resolvedOnly.links.every(link => link.kind !== 'candidate'));
    const cycleView = graph.layout(report,{cycle:observedCycle.id});
    assert.equal(cycleView.nodes.length,2);
    assert.equal(cycleView.links.length,2);
    assert.equal(report.sites.some(item => item.name === 'hidden' && item.owner === bean('A').id),false);

    const panel = await vscode.commands.executeCommand('rocketbrain.spring.beanGraph');
    assert.ok(panel?.webview);
    panels.push(panel);
    assert.match(panel.webview.html,/Spring Bean Dependencies/);
    assert.match(panel.webview.html,/id="cycle"/);
    assert.match(panel.webview.html,/id="canvas"/);
    assert.doesNotMatch(panel.webview.html,/test-private-bean-graph-value|private\.spring\.graph|file:\/\//);

    const declaration = await graph.reveal(report,{kind:'bean',id:bean('A').id});
    assert.ok(declaration.document.getText(declaration.selection).includes(name('A')));
    const injection = await graph.reveal(report,{kind:'site',id:site('B','reverse').id});
    assert.ok(injection.document.getText(injection.selection).includes('reverse'));
    await assert.rejects(graph.reveal(report,{kind:'bean',id:'file:///unreviewed.java'}),/modeled Spring declaration/);
    editedDocument = declaration.document;
    original = editedDocument.getText();
    const update = new vscode.WorkspaceEdit();
    update.insert(editedDocument.uri,editedDocument.positionAt(0),'// changed after graph capture\n');
    assert.equal(await vscode.workspace.applyEdit(update),true);
    await assert.rejects(graph.reveal(report,{kind:'bean',id:bean('A').id}),/source changed/);
    const refreshed = await graph.capture({refreshModel:true});
    assert.notEqual(refreshed.revision,report.revision);
    const shifted = refreshed.nodes.find(node => node.name === beanName('A'));
    const current = await graph.reveal(refreshed,{kind:'bean',id:shifted.id});
    assert.ok(current.document.getText(current.selection).includes(name('A')));

    const response = await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(9000)});
    assert.ok(response.ok);
    const jdbc = await response.json();
    assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
    checks.push('Spring Bean Dependencies shows resolved source cycles, ambiguous candidates, deferred providers and guarded source navigation.');
    checks.push('The live Spring Actuator reports a controller/service edge that remains unknown in the source graph. Runtime evidence and source revisions remain separate.');
    return {engine:runtime.dbEngine,resolvedCycleLength:2,ambiguousTargets:2,deferredOutsideCycles:true,candidateLayout:true,
      declarationSource:true,injectionSource:true,staleSourceRejected:true,refreshResolved:true,propertyValuesOmitted:true,
      runtimeControllerDependency:true,localControllerDependencyUnknown:true,nativeWebview:true,jdbc};
  } finally {
    for (const panel of panels) panel.dispose();
    if (editedDocument?.isDirty) {
      const restore = new vscode.WorkspaceEdit();
      restore.replace(editedDocument.uri,new vscode.Range(editedDocument.positionAt(0),editedDocument.positionAt(editedDocument.getText().length)),original);
      await vscode.workspace.applyEdit(restore);
      await editedDocument.save();
    }
    for (const file of files) await fs.unlink(file);
  }
}

module.exports = { runSpringBeanGraphChecks };
