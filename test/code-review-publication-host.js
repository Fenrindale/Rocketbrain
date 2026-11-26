'use strict';

const assert=require('node:assert/strict');
const {createReviewClient}=require('../src/vcs/code-review');
const {reviewFixture,initial,base,start}=require('./helpers/code-review-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');

const path='src/main/B.java', body='Owned anchored note';
const fromFixture=provider=>reviewFixture(provider,{publication:true});

function assertPayload(provider,fixture,body){
  assert.equal(fixture.published.length,1);
  const expected=provider==='github'?{body,commit_id:initial,path,line:3,side:'RIGHT'}:
    {body,position:{position_type:'text',base_sha:base,start_sha:start,head_sha:initial,
      old_path:'src/old/B.java',new_path:path,new_line:3}};
  assert.deepEqual(fixture.published[0].input,expected);
}

async function runCodeReviewPublicationChecks(api,vscode,checks){
  const commands=await vscode.commands.getCommands(true);
  for(const name of ['page','publishDraft'])assert.ok(commands.includes('rocketbrain.review.'+name));
  const folder=vscode.workspace.workspaceFolders[0];
  const setting=vscode.workspace.getConfiguration('rocketbrain.codeReview',folder.uri);
  const target=vscode.ConfigurationTarget.WorkspaceFolder;
  const keys=['provider','repository','endpoint'];
  const original=keys.map(key=>setting.inspect(key)?.workspaceFolderValue);
  const providers=[];
  for(const provider of ['github','gitlab']){
    const fixture=await fromFixture(provider);
    try{
      for(const key of keys)await setting.update(key,fixture.profile[key],target);
      const review=api.codeReview;
      const scope=await review.storeToken({token:fixture.profile.token,approved:true});
      const first=await review.read(fixture.profile,7,{expectedHead:initial});
      const uri=await review.publish(scope,first);
      const diffPage=await review.changePage(uri,'files',1);
      const discussionPage=await review.changePage(diffPage,'comments',1);
      const report=await vscode.workspace.openTextDocument(discussionPage);
      assert.match(report.getText(),/Changed files · Page 2/);
      assert.match(report.getText(),/Additional discussion page/);
      const patch=await review.openPatch(discussionPage,path);
      const draft=await review.draft(patch,3,body);
      assert.equal(draft.filePage,2);
      const ready=await review.reviewPublication(discussionPage,draft.id);
      assert.equal(ready.path,path);
      assert.equal(ready.line,3);
      assert.equal(ready.head,initial);
      await assert.rejects(review.publishDraft(ready.publicationId),/Explicitly approve/);
      assert.equal(fixture.published.length,0);
      const posted=await review.publishDraft(ready.publicationId,{approved:true});
      assert.equal(posted.state,'posted');
      assertPayload(provider,fixture,body);
      await assert.rejects(review.publishDraft(ready.publicationId,{approved:true}),/fresh review draft/);
      const fresh=await review.read(fixture.profile,7,{commentPage:2,expectedHead:initial});
      assert.ok(fresh.comments.some(item=>item.body===body));
      await assert.rejects(review.reviewPublication(discussionPage,draft.id),/Choose a local draft/);

      const retry=await review.draft(patch,3,'Unconfirmed owned note');
      const lost=await review.reviewPublication(discussionPage,retry.id);
      fixture.loseNextReply();
      await assert.rejects(review.publishDraft(lost.publicationId,{approved:true}),
        {code:'ROCKETBRAIN_REVIEW_PUBLICATION_UNKNOWN'});
      await assert.rejects(review.reviewPublication(discussionPage,retry.id),/previous publication attempt/);
      assert.equal(fixture.published.length,2);
      providers.push(provider);
    }finally{
      try{await api.codeReview.storeToken({token:'',approved:true});}
      finally{
        for(const [index,key] of keys.entries())await setting.update(key,original[index],target);
        await fixture.close();
      }
    }
  }
  const jdbc=await jdbcReadback();
  checks.push('The installed review workbench navigated changed files and discussions, approved exact anchored comments, and kept unconfirmed deliveries from replaying.');
  return {providers,nativePagination:true,exactPostedLine:true,explicitApproval:true,unknownNotReplayed:true,jdbc};
}

module.exports={runCodeReviewPublicationChecks};
if(require.main===module)(async()=>{
  const providers=[];
  for(const provider of ['github','gitlab']){
    const fixture=await fromFixture(provider);
    try{
      const client=createReviewClient(fixture.profile);
      const pages=await client.read(7,{expectedHead:initial,filePage:2,commentPage:2});
      assert.equal(pages.files[0].name,path);
      assert.equal(pages.comments[0].body,'Additional discussion page');
      const ready=await client.preparePublication({review:7,head:initial,path,line:3,body,filePage:2});
      await assert.rejects(client.submitPublication(ready.publicationId),/Explicitly approve/);
      const result=await client.submitPublication(ready.publicationId,{approved:true});
      assert.equal(result.state,'posted');
      assertPayload(provider,fixture,body);
      const retry=await client.preparePublication({review:7,head:initial,path,line:3,body:'Second fixture comment',filePage:2});
      fixture.loseNextReply();
      await assert.rejects(client.submitPublication(retry.publicationId,{approved:true}),
        {code:'ROCKETBRAIN_REVIEW_PUBLICATION_UNKNOWN'});
      await assert.rejects(client.submitPublication(retry.publicationId,{approved:true}),/fresh review draft/);
      assert.equal(fixture.published.length,2);
      providers.push(provider);
    }finally{await fixture.close();}
  }
  console.log(JSON.stringify({engine:process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,providers,
    exactLine:true,isolatedApiFixtures:true,unknownNotReplayed:true,jdbc:await jdbcReadback()}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
