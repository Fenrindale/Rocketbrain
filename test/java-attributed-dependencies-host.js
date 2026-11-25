'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {cyclicMaven}=require('./helpers/java-attributed-dependency-fixture');

const layer=(report,name)=>report.layers.find(item=>item.name===name);

async function runJavaAttributedDependencyChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.equal(workspace,await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE));
  assert.ok(workspace.split(path.sep).includes('test-output'));
  await importedSpring(api,workspace);
  const root=await fs.mkdtemp(path.join(workspace,'rb-graph-')), marker=path.join(root,'.owner'),token=randomUUID();
  await fs.writeFile(marker,token,{flag:'wx'});
  const scope=vscode.Uri.file(root), service=api.javaNavigation, previewDocs=new Set();
  const analyze=()=>service.analyzeDependencies({attributeSources:true,scopeUri:scope});
  async function reveal(report,link) {
    const editor=await service.revealDependency(report,link);
    previewDocs.add(editor.document.uri.toString());
    return editor;
  }
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.dependencyGraph'));
    const fixture=await cyclicMaven(root), initial=await analyze();
    assert.equal(initial.attribution.state,'attributed',JSON.stringify(initial.issues));
    assert.equal(initial.attribution.buildExecuted,false);
    const declared=layer(initial,'Maven reactor modules'), modules=layer(initial,'Javac project references');
    assert.equal(declared.cycles.length,1);
    assert.equal(modules.cycles.length,1);
    assert.equal(modules.cycles[0].witness.length,2);
    assert.equal(layer(initial,'Javac package references').cycles.length,1);
    const sourceId=modules.nodes.find(node=>node.label==='left').id;
    const edge=modules.edges.find(item=>item.from===sourceId),use=edge.evidence.find(item=>item.kind==='method call');
    assert.equal(use.symbol,'rb.right.Right#pick(int)');
    const call=await reveal(initial,use);
    assert.equal(call.document.getText(call.selection),'rb.right.Right.pick');
    assert.equal(path.relative(call.document.uri.fsPath,fixture.left.path),'');
    const target=await reveal(initial,use.target);
    assert.equal(path.relative(target.document.uri.fsPath,fixture.right.path),'');
    assert.equal(target.selection.start.line,1);
    const declaration=await reveal(initial,edge.buildDeclarations[0]);
    assert.match(declaration.document.getText(declaration.selection),/<artifactId>right<\/artifactId>/u);
    await assert.rejects(service.revealDependency({...initial},use),/current scoped Java dependency report/u);

    await fs.writeFile(fixture.right.path,fixture.right.text.replace('rb.left.Left.class','String.class'));
    await assert.rejects(service.revealDependency(initial,use),/changed\. Inspect dependencies again/u);
    const updated=await analyze();
    assert.equal(updated.attribution.state,'attributed',JSON.stringify(updated.issues));
    assert.equal(layer(updated,'Javac project references').cycles.length,0);
    assert.equal(layer(updated,'Maven reactor modules').cycles.length,1);
    const jdbc=await jdbcReadback();assert.ok(jdbc);
    checks.push('Java Dependencies inspected exact source and declared Maven cycles separately, opened a bound overload, target type and POM witness, and recomputed the source graph after a saved edit.');
    return {nativeCommand:true,sourceCycle:true,declaredCycle:true,cycleRemovedFromSourceOnly:true,overload:use.symbol,
      preciseSource:true,targetNavigation:true,buildNavigation:true,staleRefused:true,jdbc};
  } finally {
    const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>previewDocs.has(tab.input?.uri?.toString()));
    if(tabs.length)await vscode.window.tabGroups.close(tabs);
    assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),workspace);
    assert.equal(await fs.readFile(marker,'utf8'),token);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={runJavaAttributedDependencyChecks};
