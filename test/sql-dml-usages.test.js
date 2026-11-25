'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDmlUsage } = require('../src/db/sql-dml-usages');
const { analyzeProjectDocument, referencesInDocument, targetAtDocument } = require('../src/db/sql-project');
const { liveNavigation, quickInfo } = require('../src/db/sql-live-navigation');

const cols = names => names.map(name => ({ name, type:'int', nullable:false }));
const catalog = { database:'local', coverage:{tables:'loaded',columns:'loaded'},
  tables:[{name:'people',kind:'table',columns:cols(['id','score','peer'])}], views:[] };
const remote = [{schema:'remote',name:'people',kind:'table',columns:cols(['id','score','remote_only'])}];
const opts = { database:'local',sqlMode:[],dialect:'mysql',dmlUsages:true };
const q = String.fromCharCode(96);
const roles = (sql, model) => model.references.filter(ref=>ref.kind==='table' || ref.kind==='column')
  .map(ref=>[sql.slice(ref.start,ref.end),ref.usage]);

test('implicit and quoted INSERT targets preserve column order, source ranges and literal exclusions', () => {
  const source='/* score */ INSERT INTO '+q+'people'+q+' ('+q+'score'+q+',id) VALUES (?, 9),(DEFAULT,10);';
  const model=analyzeDmlUsage(source,catalog,opts);
  assert.equal(model.state,'known');
  assert.deepEqual(roles(source,model),[[q+'people'+q,'write'],[q+'score'+q,'write'],['id','write']]);
  assert.equal(model.references[0].range.start.character,source.indexOf(q+'people'));
  assert.equal(model.executedSql,false);
});

test('UPDATE separates assignments from value and WHERE reads and keeps local alias locations', () => {
  const source='UPDATE people AS p SET p.score = p.score + ?, p.peer = p.id WHERE p.id = ? AND p.score > 0';
  const model=analyzeDmlUsage(source,catalog,opts);
  assert.equal(model.state,'known');
  assert.deepEqual(roles(source,model),[['people','write'],['score','write'],['score','read'],
    ['peer','write'],['id','read'],['id','read'],['score','read']]);
  const alias=liveNavigation(source,source.indexOf('p.score'),catalog,opts);
  assert.equal(source.slice(alias.local.start,alias.local.end),'p');
  const field=liveNavigation(source,source.indexOf('p.score')+3,catalog,opts);
  assert.match(quickInfo(field),/UPDATE write target · table column local.people.score/);
  const read=liveNavigation(source,source.lastIndexOf('p.score')+3,catalog,opts);
  assert.match(quickInfo(read),/UPDATE read reference/);
});

test('DELETE columns are reads, and a same-named remote physical target requires scoped rebinding', () => {
  const sql='DELETE FROM remote.people WHERE remote_only = ? AND id = 7';
  const model=analyzeDmlUsage(sql,catalog,opts);
  assert.deepEqual(model.pending,[{schema:'remote',table:'people'}]);
  assert.deepEqual(model.references,[]);
  assert.deepEqual(liveNavigation(sql,sql.indexOf('remote_only')+4,catalog,opts),{endpoints:model.pending});
  const rebound=analyzeDmlUsage(sql,catalog,opts,remote);
  assert.deepEqual(roles(sql,rebound),[['people','write'],['remote_only','read'],['id','read']]);
  const target=liveNavigation(sql,sql.indexOf('remote_only')+6,catalog,opts,remote);
  assert.deepEqual(target.object,{ schema:'remote',name:'people',kind:'table' });
  assert.equal(target.member.name,'remote_only');
  assert.equal(target.usage,'read');
  assert.deepEqual(analyzeDmlUsage('DELETE FROM people WHERE id=1',catalog,{...opts,dialect:'mariadb'}).target,
    {database:'local',table:'people'});
  assert.equal(analyzeDmlUsage('DELETE FROM people AS p WHERE p.id=1',catalog,{...opts,dialect:'mariadb',serverVersion:'11.4.8-MariaDB'}).state,'unknown');
  assert.equal(analyzeDmlUsage('DELETE FROM people AS p WHERE p.id=1',catalog,{...opts,dialect:'mariadb',serverVersion:'11.6.2-MariaDB'}).state,'known');
});

test('project usages preserve DML roles and statement offsets while the existing rename model stays guarded', () => {
  const text='SELECT score FROM people;\r\nUPDATE people p SET p.score = p.score + 1 WHERE p.id = 1;\r\nDELETE FROM people WHERE score = 0;';
  const request={kind:'column',database:'local',table:'people',column:'score'};
  const report=analyzeProjectDocument(text,catalog,opts);
  assert.equal(report.state,'known');
  const refs=referencesInDocument(report,request,opts);
  assert.deepEqual(refs.map(ref=>[ref.usage||'select',ref.editEligible]),[['select',true],['write',false],['read',false],['read',false]]);
  assert.ok(refs.every(ref=>text.slice(ref.start,ref.end)==='score'));
  for(const ref of refs)assert.deepEqual(targetAtDocument(report,ref.start+2,opts),request);
  assert.equal(analyzeProjectDocument(text,catalog,{...opts,dmlUsages:false}).state,'partial');
  const prior='USE remote; DELETE FROM people WHERE score = 3;';
  assert.deepEqual(referencesInDocument(analyzeProjectDocument(prior,catalog,opts),request,opts),[]);
});

test('joined, dynamic, unsupported, duplicate and unproved mutation forms never emit physical references', () => {
  for(const source of [
    'UPDATE people p JOIN remote.people y SET p.score = y.score',
    'UPDATE people p, remote.people y SET p.score = y.score',
    'UPDATE people p SET y.score = 1',
    'UPDATE people p SET p.score = p.id p.peer',
    'UPDATE people SET score = @score',
    'UPDATE people SET score = (SELECT MAX(score) FROM people)',
    'UPDATE people SET score = 1,score = 2',
    'UPDATE people SET score = p.missing',
    'INSERT INTO people VALUES (1,2,3)',
    'INSERT INTO people(id,score) VALUES (1)',
    'INSERT INTO people(id,id) VALUES (1,2)',
    'INSERT INTO people(id,score) SELECT id,score FROM people',
    'INSERT INTO people(id) VALUES (1) ON DUPLICATE KEY UPDATE score = 2',
    'DELETE p FROM people p JOIN remote.people y ON p.id=y.id',
    'DELETE FROM people USING people JOIN remote.people ON people.id=remote.people.id',
    'DELETE FROM people WHERE score = 1 RETURNING id',
    'DELETE FROM people WHERE (score = 1'
  ]){
    const model=analyzeDmlUsage(source,catalog,opts);
    assert.equal(model.state,'unknown',source);
    assert.deepEqual(model.references,[],source);
  }
});
