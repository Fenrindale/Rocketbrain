'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {createReviewClient,patchTargetLines,reviewProfile}=require('../src/vcs/code-review');
const {reviewFixture,initial,patch}=require('./helpers/code-review-fixture');

for(const provider of ['github','gitlab'])test(provider+' review maps authenticated requests, patches, notes and checked commit state',async()=>{
  const fixture=await reviewFixture(provider), client=createReviewClient(fixture.profile);
  try {
    const result=await client.list();
    assert.equal(result.more,true);
    assert.equal(result.items[0].head,initial);
    assert.equal((await client.list({page:2})).more,false);
    const review=await client.read(7,{expectedHead:initial});
    assert.deepEqual(review.linkedIssueNumbers,[41,16]);
    assert.deepEqual(patchTargetLines(review.files[0].patch),[{line:2,patchLine:1},{line:3,patchLine:3},{line:4,patchLine:4}]);
    assert.equal(review.files[1].limited,true);
    assert.equal(review.comments[0].file,'src/main/A.java');
    assert.equal(review.comments[0].line,3);
    assert.equal(review.pipelines[0].status,'success');
    assert.equal(review.coverage.limitedPatches,1);
    assert.ok(fixture.records.every(item=>item.method==='GET'));
    fixture.hideChecks();
    assert.equal((await client.read(7)).pipelines,null);
  } finally {await fixture.close();}
});

test('review refuses stale revisions and keeps selected repository and credential scope explicit', async()=>{
  assert.throws(()=>reviewProfile({provider:'github',repository:'../example'}),/owner and project/);
  assert.throws(()=>reviewProfile({provider:'gitlab',repository:'group/project',endpoint:'https://user@example.org/api'}),/without credentials/);
  assert.throws(()=>reviewProfile({provider:'gitlab',repository:'group/project',endpoint:'http://example.org/api'}),/Use HTTPS/);
  const fixture=await reviewFixture('github');
  try {
    await assert.rejects(createReviewClient({...fixture.profile,token:'invalid'}).list(),/HTTP 401/);
    fixture.mutateDuringRead();
    await assert.rejects(createReviewClient(fixture.profile).read(7,{expectedHead:initial}),/changed while loading/);
    assert.equal(patchTargetLines(patch).some(item=>item.patchLine===2),false);
  } finally {await fixture.close();}
});
