'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {createReviewClient}=require('../src/vcs/code-review');
const {reviewFixture,initial,base,start}=require('./helpers/code-review-fixture');

const draft={review:7,head:initial,base,path:'src/main/B.java',line:3,filePage:2,body:'Exact reviewed note'};

for(const provider of ['github','gitlab']) test(provider+' pages and publishes the approved exact pinned patch line',async()=>{
  const fixture=await reviewFixture(provider,{publication:true});
  const client=createReviewClient(fixture.profile);
  try {
    const first=await client.read(7,{expectedHead:initial});
    assert.equal(first.coverage.moreFiles,true);
    assert.equal(first.coverage.moreComments,true);
    const second=await client.read(7,{filePage:2,commentPage:2,expectedHead:initial});
    assert.equal(second.files[0].name,draft.path);
    assert.equal(second.comments[0].body,'Additional discussion page');
    assert.ok(fixture.records.every(row=>!row.path.includes('never-follow')));
    const review=await client.preparePublication(draft);
    assert.equal(review.head,initial);
    assert.equal(review.line,3);
    await assert.rejects(client.submitPublication(review.publicationId),/approve/);
    assert.equal(fixture.published.length,0);
    const result=await client.submitPublication(review.publicationId,{approved:true});
    assert.equal(result.state,'posted');
    if(provider==='github') assert.deepEqual(fixture.published[0].input,{body:draft.body,
      commit_id:initial,path:draft.path,line:3,side:'RIGHT'});
    else assert.deepEqual(fixture.published[0].input,{body:draft.body,position:{position_type:'text',
      base_sha:base,start_sha:start,head_sha:initial,old_path:'src/old/B.java',new_path:draft.path,new_line:3}});
    await assert.rejects(client.submitPublication(review.publicationId,{approved:true}),/fresh review draft/);
    assert.equal(fixture.published.length,1);
    const context=await client.preparePublication({...draft,line:4});
    assert.equal(context.oldLine,4);
    assert.ok((await client.read(7,{commentPage:2})).comments.some(item=>item.body===draft.body));
  } finally { await fixture.close(); }
});

test('a changed or unavailable patch never posts the approved body',async()=>{
  const fixture=await reviewFixture('github',{publication:true});
  const client=createReviewClient(fixture.profile);
  try {
    await assert.rejects(client.preparePublication({...draft,patchSha:'0'.repeat(64)}),/patch line changed/);
    await assert.rejects(client.preparePublication({...draft,path:'payload.bin',filePage:1}),/patch is no longer available/);
    const review=await client.preparePublication(draft);
    fixture.mutateDuringRead();
    await assert.rejects(client.submitPublication(review.publicationId,{approved:true}),/review changed while loading/i);
    assert.equal(fixture.published.length,0);
  } finally { await fixture.close(); }
});

test('a lost server acknowledgement stays uncertain and is never silently replayed',async()=>{
  const fixture=await reviewFixture('gitlab',{publication:true});
  const client=createReviewClient(fixture.profile);
  try {
    const review=await client.preparePublication(draft);
    fixture.loseNextReply();
    await assert.rejects(client.submitPublication(review.publicationId,{approved:true}),
      {code:'ROCKETBRAIN_REVIEW_PUBLICATION_UNKNOWN'});
    await assert.rejects(client.submitPublication(review.publicationId,{approved:true}),/fresh review draft/);
    assert.equal(fixture.published.length,1);
    assert.ok((await client.read(7,{commentPage:2})).comments.some(item=>item.body===draft.body));
  } finally { await fixture.close(); }
});
