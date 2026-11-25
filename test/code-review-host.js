'use strict';

const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {reviewFixture,initial,patch}=require('./helpers/code-review-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');

async function runCodeReviewChecks(api,vscode,checks) {
  const commands=await vscode.commands.getCommands(true);
  for(const name of ['open','patch','draft','discardDraft','token'])assert.ok(commands.includes('rocketbrain.review.'+name));
  const modes=[];
  for(const provider of ['github','gitlab']) {
    const fixture=await reviewFixture(provider);
    try {
      const review=await api.codeReview.read(fixture.profile,7,{expectedHead:initial});
      const uri=await api.codeReview.publish(randomUUID(),review);
      const report=await vscode.workspace.openTextDocument(uri);
      assert.match(report.getText(),/Fix a generated method/);
      assert.match(report.getText(),/Existing line comment/);
      assert.match(report.getText(),/#41/);
      assert.match(report.getText(),/Checks and pipelines/);
      const changed=await api.codeReview.openPatch(uri,'src/main/A.java');
      assert.equal((await vscode.workspace.openTextDocument(changed)).getText(),patch);
      assert.throws(()=>api.codeReview.draft(changed,2,'removed line'),/new side of the patch/);
      const draft=await api.codeReview.draft(changed,3,'Owned local draft');
      assert.equal(draft.line,3);
      assert.equal(draft.head,initial);
      assert.ok(fixture.records.every(item=>item.method==='GET'));
      modes.push(provider);
    } finally {await fixture.close();}
  }
  const jdbc=await jdbcReadback();
  checks.push('The installed review workbench read GitHub- and GitLab-shaped endpoints, opened exact patches, and stored an anchored draft without uploading it.');
  return {providers:modes,exactPatch:true,draftAnchored:true,readOnlyRemote:true,linkedIssueAndChecks:true,jdbc};
}

module.exports={runCodeReviewChecks};
