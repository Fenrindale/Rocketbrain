'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {selectScope,loadScope}=require('../src/db/sql-resolution-scopes');

test('SQL resolution scope selects an exact file or the most specific workspace folder',()=>{
  const root=path.resolve('fixtures','project');
  const rules=['db/','db/migrations/','db/migrations/custom.sql'].map(source=>({source}));
  assert.equal(selectScope(root,path.join(root,'db','old.sql'),rules),rules[0]);
  assert.equal(selectScope(root,path.join(root,'db','migrations','new.sql'),rules),rules[1]);
  assert.equal(selectScope(root,path.join(root,'db','migrations','custom.sql'),rules),rules[2]);
  assert.equal(selectScope(root,path.join(root,'db-backup','custom.sql'),rules),null);
  assert.equal(selectScope(root,path.resolve('other.sql'),rules),null);
  assert.match(selectScope(root,path.join(root,'db','x.sql'),[rules[0],rules[0]]).error,/More than one/);
});

test('a configured catalog is parsed by dialect, refreshes after a saved edit, and rejects traversal',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rb-resolution-scope-test-'));
  const file=path.join(dir,'base.sql');
  const cache=new Map(),rule={source:'query/',ddl:'base.sql',database:'test_scope',dialect:'mariadb'};
  try{
    fs.writeFileSync(file,'CREATE TABLE observed (id INT);',{flag:'wx'});
    const first=loadScope(dir,rule,cache);
    assert.equal(first.model.dialect,'mariadb');
    assert.equal(first.model.tables[0].columns[0].name,'id');
    assert.equal(loadScope(dir,rule,cache),first);
    assert.equal(loadScope(dir,{...rule,source:'one.sql'},cache).configuredScope,'one.sql');
    fs.writeFileSync(file,'CREATE TABLE observed (other VARCHAR(42));');
    assert.equal(loadScope(dir,rule,cache).model.tables[0].columns[0].name,'other');
    assert.throws(()=>loadScope(dir,{...rule,ddl:'../base.sql'},cache),/workspace-relative/);
  }finally{fs.unlinkSync(file);fs.rmdirSync(dir);}
});
