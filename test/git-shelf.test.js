'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {test}=require('node:test');
const {shelfController}=require('../src/vcs/shelf');
const {parsePatch,uniqueContext}=require('../src/vcs/shelf-patch');
const {createShelfFixture,git,springJdbcClasspath,runShelfSpring}=require('./helpers/git-shelf-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,cp=process.env.ROCKETBRAIN_GIT_SHELF_CLASSPATH;
const sql=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_GIT_SHELF_'+engine.toUpperCase()+'_CONFIG']]);
const json=file=>fs.readFile(file,'utf8').then(JSON.parse);

async function owned(t) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-git-shelf-')),token=randomUUID();
  const marker=path.join(root,'.owner');await fs.writeFile(marker,token,{flag:'wx'});
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);
    assert.equal(await fs.readFile(marker,'utf8'),token);
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  });
  return root;
}

function state() {
  const values=new Map();
  return {get(key,fallback){return values.get(key)??fallback;},async update(key,value){values.set(key,structuredClone(value));}};
}

const controller=(fixture,storage=state(),checkFile=()=>{})=>shelfController(storage,{
  async verify(repo){
    const fresh=await fixture.identity(repo.root);
    assert.equal(fresh.key,repo.key);assert.equal(fresh.group,repo.group);
    return fresh;
  },
  checkFile
});

test('Git Shelf strictly validates patch paths, bodies and unique context',()=>{
  const plain='diff --git a/a.txt b/a.txt\nindex '+'1'.repeat(40)+'..'+'2'.repeat(40)+' 100644\n'+
    '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  assert.equal(parsePatch(plain,'a.txt').hunks[0].after[0],'new');
  assert.throws(()=>parsePatch(plain,'../a.txt'),/Invalid bounded/u);
  assert.throws(()=>parsePatch(plain,'.gitattributes'),/Invalid bounded/u);
  assert.throws(()=>parsePatch(plain+'--- a/extra.txt\n','a.txt'),/hunk counts/u);
  assert.throws(()=>parsePatch(plain.replace('--- a/a.txt','--- a/alternate.txt'),'a.txt'),/tracked text/u);
  assert.equal(uniqueContext('one\r\ntwo\r\n',['one']),true);
  assert.equal(uniqueContext('one\none\n',['one']),false);
});

test('real Git shelves selected unstaged hunks and restores across linked branches while preserving staged bytes',{
  timeout:180000
},async t=>{
  const fixture=await createShelfFixture(await owned(t),{crlf:true}),storage=state(),service=controller(fixture,storage);
  const source=await fixture.identity(fixture.origin),target=await fixture.identity(fixture.target),conflict=await fixture.identity(fixture.conflict);
  const index=await fixture.indexBytes(fixture.origin),targetIndex=await fixture.indexBytes(fixture.target);
  const read=(root,name)=>fs.readFile(fixture.filename(root,name),'utf8');
  const review=await service.inspect(source);
  assert.equal(review.hunks.length,3,JSON.stringify(review));
  assert.equal(review.branch,'main');
  assert.throws(()=>service.select({...review},[review.hunks[0].id]),/current Git worktree review/u);
  const chosen=review.hunks.filter(h=>h.newLine<15);
  assert.equal(chosen.length,2);
  const preview=service.select(review,chosen.map(h=>h.id));
  assert.match(preview.patch,/selected line 8/u);
  assert.match(preview.patch,/selected second line 8/u);
  assert.doesNotMatch(preview.patch,/unfinished line 34/u);
  const record=await service.shelve(preview,'Move two selected hunks');
  assert.equal(record.state,'shelved');
  assert.deepEqual(await fixture.indexBytes(fixture.origin),index);
  assert.equal(await read(fixture.origin),fixture.eol(fixture.indexText.replace(...fixture.untouched)));
  assert.equal(await read(fixture.origin,fixture.other),fixture.eol(fixture.otherSource));
  assert.equal(await read(fixture.origin,'untracked.txt'),'owned scratch\n');
  assert.equal((await git(fixture.origin,'stash','list')).trim(),'');

  const reopened=controller(fixture,storage),stored=(await reopened.list(target)).find(entry=>entry.id===record.id);
  assert.equal(stored.branch,'main');
  assert.equal(stored.count,2);
  assert.equal(await reopened.preview(target,record.id),preview.patch);
  const restore=await reopened.previewRestore(target,record.id);
  assert.equal(restore.status,'ready');assert.equal(restore.branch,'release');
  const [first,second]=await Promise.allSettled([reopened.restore(restore),reopened.restore(restore)]);
  assert.equal(first.value.status,'applied');
  assert.equal(second.status,'rejected');
  assert.equal(await read(fixture.target),fixture.eol(fixture.text.replace(...fixture.unrelated).replace(...fixture.selected)));
  assert.equal(await read(fixture.target,fixture.other),fixture.eol(fixture.otherSource.replace(...fixture.otherEdit)));
  assert.deepEqual(await fixture.indexBytes(fixture.target),targetIndex);
  const duplicate=await reopened.previewRestore(target,record.id);
  assert.equal(duplicate.status,'already-applied');
  assert.equal((await reopened.restore(duplicate)).status,'already-applied');
  assert.equal((await reopened.list(target)).length,1);

  const before=await read(fixture.conflict),other=await read(fixture.conflict,fixture.other);
  const blocked=await reopened.previewRestore(conflict,record.id);
  assert.equal(blocked.status,'conflict');
  assert.equal((await reopened.restore(blocked)).status,'conflict');
  assert.equal(await read(fixture.conflict),before);
  assert.equal(await read(fixture.conflict,fixture.other),other);
  await assert.rejects(fs.access(fixture.filename(fixture.conflict,fixture.name+'.rej')),error=>error.code==='ENOENT');
  await fs.writeFile(fixture.filename(fixture.conflict),fixture.eol(fixture.text));
  const retry=await reopened.previewRestore(conflict,record.id);
  assert.equal(retry.status,'ready');
  assert.equal((await reopened.restore(retry)).status,'applied');
});

test('shelf retains a saved recovery copy if the workspace changes after persistence and refuses stale and dirty reviews',{
  timeout:120000
},async t=>{
  const fixture=await createShelfFixture(await owned(t)),repo=await fixture.identity(fixture.origin);
  const storage=state();
  let nowDirty=false;
  const service=controller(fixture,storage,(_repo,name)=>{
    if(nowDirty&&name===fixture.name)throw Error('Save the reviewed path first.');
  });
  const review=await service.inspect(repo),pick=review.hunks.find(h=>h.path===fixture.name&&h.newLine<15);
  const selected=service.select(review,[pick.id]),file=fixture.filename(fixture.origin);
  const before=await fs.readFile(file,'utf8');
  await fs.appendFile(file,'changed after preview\n');
  await assert.rejects(service.shelve(selected,'stale'),/changed\. Preview again/u);
  assert.deepEqual(await service.list(repo),[]);
  await fs.writeFile(file,before);
  nowDirty=true;
  await assert.rejects(service.shelve(selected,'dirty'),/Save the reviewed path/u);
  nowDirty=false;
  const update=storage.update;
  storage.update=async(key,value)=>{
    await update(key,value);
    await fs.appendFile(file,'changed after shelf persistence\n');
  };
  await assert.rejects(service.shelve(selected,'recovery'),/shelf copy was saved/u);
  assert.equal(await fs.readFile(file,'utf8'),before+'changed after shelf persistence\n');
  const [saved]=await service.list(repo);
  assert.equal(saved.state,'captured');
  assert.match(await service.preview(repo,saved.id),/selected line 8/u);
});

test('a real Spring JDBC Java change restored from a Git shelf runs on both owned database engines',{
  skip:!javaConfig||!cp||!sql.every(([,file])=>file),timeout:170000
},async t=>{
  const fixture=await createShelfFixture(await owned(t),{spring:true}),service=controller(fixture);
  const source=await fixture.identity(fixture.origin),target=await fixture.identity(fixture.target);
  const report=await service.inspect(source), hunk=report.hunks.find(item=>item.path===fixture.name&&item.newLine<15);
  const item=await service.shelve(service.select(report,[hunk.id]),'Spring JDBC factor');
  assert.equal((await service.restore(await service.previewRestore(target,item.id))).status,'applied');
  assert.match(await fs.readFile(fixture.filename(fixture.target),'utf8'),/static int factor\(\) \{ return 2/u);
  const {javaHome}=await json(javaConfig),results=[];
  for(const [engine,file] of sql) {
    const actual=await runShelfSpring({javaHome,file:fixture.filename(fixture.target),className:'fixture.ShelfProbe',
      binaryDirectory:await fs.mkdtemp(path.join(fixture.outer,'classes-')),engine,config:await json(file),
      classpath:await springJdbcClasspath(cp,engine)});
    assert.equal(actual.output,'42');
    results.push({...actual,from:'main',to:'release',restoredHunks:1});
  }
  if(process.env.ROCKETBRAIN_GIT_SHELF_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_GIT_SHELF_RECEIPT,
    JSON.stringify({git:(await git(fixture.origin,'--version')).trim(),springJdbc:'7.0.10',results})+'\n');
});
