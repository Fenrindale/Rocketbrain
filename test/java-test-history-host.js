'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {historyTestSources}=require('./helpers/java-test-history-fixture');

async function runJavaTestHistoryChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const service=api.javaTesting,tail=randomBytes(5).toString('hex');
  const names={junit:'RbHistoryJupiter'+tail,testng:'RbHistoryTestNg'+tail};
  const config=vscode.workspace.getConfiguration('rocketbrain.java.testing'),key='saveHistory',target=vscode.ConfigurationTarget.Workspace;
  const previous=config.inspect(key)?.workspaceValue,created=[];
  let diff;
  try {
    await config.update(key,true,target);
    for(const [name,content] of Object.entries(historyTestSources('fixture.boot',names))){
      const file=path.join(workspace,'src/test/java/fixture/boot',name);
      await fs.writeFile(file,content,{flag:'wx'});
      created.push(file);
      await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    }
    const runtime=await vscode.commands.executeCommand('rocketbrain.java.testing.install');
    assert.equal(runtime.testngVersion,'7.11.0');
    const commands=await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.java.testing.history')&&commands.includes('rocketbrain.java.testing.clearHistory'));
    const tree=await service.discover();
    const includeIds=Object.entries(names).map(([framework,name])=>{
      const item=tree.tests.find(row=>row.framework===framework&&row.className==='fixture.boot.'+name&&!row.methodName&&row.kind==='container');
      assert.ok(item,`Find ${framework} history fixture in the actual Spring test classpath.`);
      return item.nativeId;
    });
    const failed=await service.run({includeIds,jvmArgs:['-Drb.history.fail=true'],build:false});
    const saved=service.history.list().find(record=>record.id===failed.historyId);
    assert.ok(saved&&!saved.sourceChanged);
    assert.deepEqual(saved.projects.map(item=>[item.framework,item.passed,item.failed]).sort(),[['junit',1,1],['testng',1,3]]);
    const typedIndex=saved.failures.findIndex(item=>item.framework==='testng'&&item.comparison?.kind==='opentest4j');
    const typed=saved.failures[typedIndex];
    assert.ok(typed.rerun&&typed.selector);
    assert.deepEqual(typed.comparison,{kind:'opentest4j',expected:'44',actual:'52',expectedType:'java.lang.Integer',actualType:'java.lang.Long'});
    assert.ok(saved.failures.some(item=>item.framework==='testng'&&item.comparison?.kind==='testng-text'));
    assert.ok(saved.failures.some(item=>item.label.startsWith('ambiguous')&&item.comparison===null));
    diff=await service.history.openDiff(saved.id,typedIndex);
    const expected=await vscode.workspace.openTextDocument(diff.expected);
    const actual=await vscode.workspace.openTextDocument(diff.actual);
    assert.equal(expected.getText(),'44');
    assert.equal(actual.getText(),'52');
    const refreshed=await service.discover({build:false});
    assert.ok(!refreshed.tests.some(row=>row.id===typed.selector));
    const rerun=await service.history.replay(saved.id,typedIndex,{build:false});
    assert.equal(rerun.projects.length,1);
    assert.equal(rerun.projects[0].framework,'testng');
    assert.equal(rerun.projects[0].summary.testsFound,1);
    assert.equal(rerun.projects[0].summary.testsSucceeded,1);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Use the owned Spring JDBC fixture.');
    checks.push('The installed extension stored Jupiter and TestNG outcomes, reopened structured expected/actual text in VS Code diff, and reran the exact saved TestNG provider invocation after fresh discovery.');
    return {springWorkspace:true,jdbc,savedRun:true,frameworks:['junit','testng'],storedFailures:saved.failures.length,
      comparisonTypes:[typed.comparison.expectedType,typed.comparison.actualType],nativeDiff:true,replayedProviderCase:true,
      rerunFound:rerun.projects[0].summary.testsFound};
  }finally{
    if(diff&&vscode.window.activeTextEditor?.document.uri.toString()===diff.actual.toString()){
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for(const file of created)await fs.rm(file,{force:true});
    await config.update(key,previous,target);
  }
}

module.exports={runJavaTestHistoryChecks};
