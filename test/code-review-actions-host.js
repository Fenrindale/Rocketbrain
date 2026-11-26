'use strict';

const assert=require('node:assert/strict');
const {createReviewClient}=require('../src/vcs/code-review');
const {reviewFixture,initial,noteId,thread}=require('./helpers/code-review-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');

const replyBody='Owned discussion reply', editBody='Reviewed note revision', reviewBody='Reviewed owned change';

async function exercise(provider,fixture,flow) {
  const github=provider==='github';
  const reply=await flow.prepare('reply',replyBody,noteId);
  await assert.rejects(flow.send(reply.actionId,false),/Explicitly approve/);
  assert.equal(fixture.actions.length,0);
  assert.equal((await flow.send(reply.actionId,true)).action,'reply');
  await assert.rejects(flow.send(reply.actionId,true),/fresh review action/);

  const stale=await flow.prepare('edit',editBody,noteId);
  fixture.changeNote('Updated in another client');
  await assert.rejects(flow.send(stale.actionId,true),/discussion note changed/);
  assert.equal(fixture.actions.length,1);
  await flow.refresh();
  const edit=await flow.prepare('edit',editBody,noteId);
  assert.equal(edit.note.body,'Updated in another client');
  assert.equal((await flow.send(edit.actionId,true)).action,'edit');
  await flow.refresh();

  const approval=await flow.prepare('approve');
  assert.equal(approval.head,initial);
  assert.equal((await flow.send(approval.actionId,true)).action,'approve');
  const review=await flow.prepare(github?'request-changes':'comment',reviewBody);
  assert.equal((await flow.send(review.actionId,true)).action,review.action);
  const [posted,updated,decision,comment]=fixture.actions;
  assert.match(posted.path,new RegExp(github?`/7/comments/${noteId}/replies$`:`/7/discussions/${thread}/notes$`));
  assert.deepEqual(posted.input,{body:replyBody});
  assert.match(updated.path,new RegExp(github?`/pulls/comments/${noteId}$`:`/7/discussions/${thread}/notes/${noteId}$`));
  assert.equal(updated.method,github?'PATCH':'PUT');
  assert.deepEqual(updated.input,{body:editBody});
  assert.deepEqual(decision.input,github?{commit_id:initial,event:'APPROVE'}:{sha:initial});
  assert.deepEqual(comment.input,github?{commit_id:initial,event:'REQUEST_CHANGES',body:reviewBody}:{body:reviewBody});

  const uncertain=await flow.prepare('reply','Owned reply with interrupted acknowledgement',noteId);
  fixture.loseNextReply();
  await assert.rejects(flow.send(uncertain.actionId,true),{code:'ROCKETBRAIN_REVIEW_PUBLICATION_UNKNOWN'});
  await assert.rejects(flow.send(uncertain.actionId,true),/fresh review action/);
  assert.equal(fixture.actions.length,5);
  const current=await flow.refresh();
  assert.ok(current.includes(editBody)&&current.includes(replyBody)&&current.includes('interrupted acknowledgement'));

  const headDrift=await flow.prepare('approve');
  fixture.mutateDuringRead();
  await assert.rejects(flow.send(headDrift.actionId,true),/review changed while loading/i);
  assert.equal(fixture.actions.length,5);
}

async function sourceProof() {
  const providers=[];
  for(const provider of ['github','gitlab']) {
    const fixture=await reviewFixture(provider,{reviewActions:true});
    const client=createReviewClient(fixture.profile);
    let view=await client.read(7);
    try {
      await exercise(provider,fixture,{
        prepare(action,body,id) {
          return client.prepareAction({action,body,review:7,head:view.head,base:view.base,start:view.start,
            note:view.comments.find(item=>item.id===id&&id!==undefined)});
        },
        send(id,approved) { return client.submitAction(id,{approved}); },
        async refresh() { view=await client.read(7); return view.comments.map(item=>item.body).join('\n'); }
      });
      providers.push(provider);
    } finally { await fixture.close(); }
  }
  return {providers,explicitApproval:true,boundCommit:true,exactDiscussion:true,editedNoteReadback:true,
    noteAndHeadDriftRefused:true,unknownNotReplayed:true,isolatedApiFixtures:true};
}

async function runCodeReviewActionChecks(api,vscode,checks) {
  const commands=await vscode.commands.getCommands(true);
  for(const name of ['action','refresh']) assert.ok(commands.includes('rocketbrain.review.'+name));
  const folder=vscode.workspace.workspaceFolders[0];
  const config=vscode.workspace.getConfiguration('rocketbrain.codeReview',folder.uri);
  const target=vscode.ConfigurationTarget.WorkspaceFolder;
  const keys=['provider','repository','endpoint'];
  const originals=keys.map(key=>config.inspect(key)?.workspaceFolderValue);
  const review=api.codeReview, providers=[];
  for(const provider of ['github','gitlab']) {
    const fixture=await reviewFixture(provider,{reviewActions:true});
    try {
      for(const key of keys) await config.update(key,fixture.profile[key],target);
      const scope=await review.storeToken({token:fixture.profile.token,approved:true});
      let uri=await review.publish(scope,await review.read(fixture.profile,7));
      await exercise(provider,fixture,{
        prepare(action,body,noteId) { return review.reviewAction(uri,{action,body,noteId}); },
        send(id,approved) { return review.sendReviewAction(id,{approved}); },
        async refresh() {
          uri=await vscode.commands.executeCommand('rocketbrain.review.refresh');
          return (await vscode.workspace.openTextDocument(uri)).getText();
        }
      });
      providers.push(provider);
    } finally {
      try { await review.storeToken({token:'',approved:true}); }
      finally {
        for(const [i,key] of keys.entries()) await config.update(key,originals[i],target);
        await fixture.close();
      }
    }
  }
  const jdbc=await jdbcReadback();
  checks.push('The installed workbench approved pinned reviews, replied to and edited exact remote notes, and refused changed discussion content or review heads.');
  return {providers,explicitApproval:true,boundCommit:true,exactDiscussion:true,editedNoteReadback:true,
    noteAndHeadDriftRefused:true,unknownNotReplayed:true,isolatedApiFixtures:true,nativeRefresh:true,jdbc};
}

module.exports={runCodeReviewActionChecks,sourceProof};
if(require.main===module) (async()=>{
  console.log(JSON.stringify({...await sourceProof(),engine:process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,jdbc:await jdbcReadback()}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
