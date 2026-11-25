'use strict';

const assert=require('node:assert/strict');
const {ownedHeapFixture}=require('./helpers/heap-fixture');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');

async function runJavaHeapDumpChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const fixture=await ownedHeapFixture(api.java.getState().javaHome),service=api.jvmDiagnostics;
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.inspectJvmHeapDump'));
    const saved=await fixture.dump(true);
    assert.match(saved.stdout,/Heap dump file created/);
    const analysis=await service.inspectHeapDump(fixture.output);
    assert.equal(analysis.metrics.fileBytes,saved.bytes);
    assert.ok(analysis.metrics.unreachable>0 && analysis.metrics.excludedNonStrongReferences>0);
    const owners=analysis.classes({query:'HeapFixture$Owner'}).rows;
    const type=owners.find(row=>row.kind==='instance');
    assert.equal(type.instances,1);
    const owner=analysis.objects({type:type.key}).rows[0],proof=analysis.inspect(owner.address);
    const expected=58000+analysis.metrics.idSize*7;
    assert.equal(proof.retainedPayloadBytes,expected);
    assert.equal(proof.retainedObjects,6);
    assert.equal(proof.dominator?.type,'HeapFixture');
    assert.ok(proof.path.some(step=>step.via==='static KEEP'));
    assert.ok(proof.outgoing.rows.some(step=>step.label==='owned'));
    const shared=proof.outgoing.rows.find(step=>step.label==='shared');
    assert.equal(shared.object.retainedPayloadBytes,30000+analysis.metrics.idSize);
    assert.equal(analysis.inspect(shared.object.address).dominator.type,'HeapFixture');
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Use the owned Spring JDBC fixture.');
    checks.push('The installed JVM diagnostics reopened a true HotSpot heap dump, found a GC-root field path, checked inherited and shared reference handling, and computed retained object and payload totals.');
    return {springWorkspace:true,jdbc,capturedBytes:saved.bytes,objects:analysis.metrics.objects,root:proof.root,
      ownerRetainedObjects:proof.retainedObjects,ownerRetainedPayloadBytes:proof.retainedPayloadBytes,
      sharedExcluded:true,inheritedEdge:true,weakEdgesExcluded:true,unresolvedReferences:analysis.metrics.unresolvedReferences};
  }finally{await fixture.close();}
}

module.exports={runJavaHeapDumpChecks};
