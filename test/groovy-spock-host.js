'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createGroovyFixture,scripts } = require('./helpers/groovy-fixture');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

async function runGroovySpockChecks(api,vscode,checks) {
  const service=api.java.groovy;
  assert.ok(service?.evaluate && service?.runScript && service?.runTests && service?.reset);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const fixture=await createGroovyFixture(workspace), root=vscode.Uri.file(fixture), projectUri=root.toString();
  try {
    const view=await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    const project=view.projects.find(item => !path.relative(item.root,fixture));
    assert.deepEqual(project.languages,['groovy','java']);
    const files=project.sourceRoots.flatMap(source => source.packages.flatMap(pkg => pkg.files));
    assert.ok(files.some(file => file.name === 'GroovyBadge.groovy' && file.language === 'groovy'));
    assert.ok(files.some(file => file.name === 'JavaEntry.java' && file.language === 'java'));
    const commands=await vscode.commands.getCommands(true);
    for (const id of ['console','resetConsole','evaluateSelection','runScript','runTests']) {
      assert.ok(commands.includes('rocketbrain.groovy.'+id));
    }
    const groovy=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixture,scripts.source)));
    assert.equal(groovy.languageId,'groovy');
    await vscode.window.showTextDocument(groovy,{preview:false});
    await assert.rejects(service.runTests({projectUri:project.uri}),/before executing Gradle/);
    const test=await vscode.commands.executeCommand('rocketbrain.groovy.runTests');
    assert.equal(test?.state,'succeeded');
    const report=await fs.readFile(path.join(fixture,scripts.tests),'utf8');
    assert.match(report,/tests="3".*skipped="0".*failures="0".*errors="0"/);

    const evaluate=code => service.evaluate({code,workingDirectory:fixture});
    assert.equal((await evaluate("seed = 'rocket'; seed")).value,'rocket');
    const dynamic=await evaluate("x = [name: seed, counts: [1, 2, 3]]; x.name.toUpperCase() + ':' + x.counts.sum()");
    assert.equal(dynamic.value,'ROCKET:6');
    await service.reset();
    assert.match((await evaluate('seed')).error,/MissingPropertyException/);
    await service.reset();

    const script=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixture,scripts.script)));
    await vscode.window.showTextDocument(script,{preview:false});
    const executed=await vscode.commands.executeCommand('rocketbrain.groovy.runScript');
    assert.match(executed.stdout,/score=20/);
    assert.equal(executed.value,'20');
    const bad=path.join(fixture,'scripts','bad.groovy');
    await fs.writeFile(bad,'def one = 1\nint score = )\n',{flag:'wx'});
    const broken=await vscode.workspace.openTextDocument(vscode.Uri.file(bad));
    const error=await service.runScript({document:broken});
    assert.equal(error.state,'error');
    assert.equal(error.line,2);
    const diagnostic=await until(() => vscode.languages.getDiagnostics(broken.uri)
      .find(item => item.source === 'Groovy' && item.range.start.line === 1),10000);
    assert.match(diagnostic.message,/Unexpected input/);
    const jdbc=await jdbcReadback();
    checks.push('Rocketbrain browsed actual Java/Groovy sources, ran three Spock cases, preserved and reset console state, executed a saved script and source-mapped its syntax error.');
    return {languages:project.languages,spockCases:3,consoleValue:dynamic.value,consoleReset:true,
      scriptResult:executed.value,diagnosticLine:error.line,springWorkspace:true,jdbc};
  } finally {
    await service.reset();
    for (const editor of vscode.window.visibleTextEditors.filter(value => value.document.uri.scheme === 'file' &&
      value.document.uri.fsPath.startsWith(fixture+path.sep))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(() => {});
    const verified=await fs.realpath(fixture);
    if (path.dirname(verified) !== workspace || !path.basename(verified).startsWith('rb-groovy-fixture-')) {
      throw Error('Groovy fixture ownership changed before cleanup.');
    }
    await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports = { runGroovySpockChecks };
