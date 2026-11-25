'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {createWebDavDeployment}=require('../src/http/webdav-deploy');
const {webDavFixture}=require('./helpers/webdav-fixture');

async function setup(action) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rb-webdav-'));
  const server=await webDavFixture(), client=createWebDavDeployment();
  const files=new Map([['change.txt','new source\n'],['create data.bin',Buffer.from([0,1,255])],['ignore.txt','skip'],
    ['unchanged.txt','same'],['weak.txt','new protected']]);
  try {
    for(const [name,data] of files) await fs.writeFile(path.join(root,name),data,{flag:'wx'});
    server.set('change.txt','old remote\n');
    server.set('unchanged.txt','same');
    server.set('weak.txt','old protected',{weak:true});
    const input={root,url:server.url,remoteDirectory:'deploy',user:server.user,password:server.password,
      files:[...files.keys()],exclusions:['ignore.*']};
    await action({root,server,client,input});
  } finally {
    client.dispose();await server.close();
    for(const name of files.keys())await fs.unlink(path.join(root,name));
    await fs.rmdir(root);
  }
}

test('WebDAV uses mapped paths, exact diffs, conditional replacements and binary creation',async()=>setup(async({server,client,input})=>{
  const plan=await client.prepare(input);
  assert.ok(plan.directory.endsWith('/dav/deploy/'));
  assert.deepEqual(plan.files.map(item=>item.state),['replace','create','excluded','unchanged','validator-unavailable']);
  assert.deepEqual(client.compare(plan.id,'change.txt'),{name:'change.txt',state:'replace',remote:'old remote\n',local:'new source\n'});
  assert.match(client.compare(plan.id,'create data.bin').local,/Binary file · 3 bytes/);
  assert.ok(!server.observed.some(item=>item.name==='ignore.txt'));
  await assert.rejects(client.apply(plan.id,['weak.txt']),/valid remote condition/);
  const receipt=await client.apply(plan.id,['change.txt','create data.bin']);
  assert.deepEqual(receipt.files.map(item=>item.state),['uploaded','uploaded']);
  assert.equal(server.files.get('change.txt').bytes.toString(),'new source\n');
  assert.deepEqual(server.files.get('create data.bin').bytes,Buffer.from([0,1,255]));
  assert.equal(server.observed.find(item=>item.name==='create data.bin'&&item.method==='PUT').ifNoneMatch,'*');
  assert.match(server.observed.find(item=>item.name==='change.txt'&&item.method==='PUT').ifMatch,/^"[a-f0-9]{64}"$/);
  await assert.rejects(client.apply(plan.id,['change.txt']),/fresh WebDAV deployment review/);
}));

test('WebDAV detects changed local bytes before upload and reports remote precondition conflicts',async()=>setup(async({root,server,client,input})=>{
  const plan=await client.prepare(input);
  await fs.writeFile(path.join(root,'change.txt'),'changed again');
  await assert.rejects(client.apply(plan.id,['change.txt','create data.bin']),/local file changed/);
  assert.ok(!server.observed.some(item=>item.method==='PUT'));
  const refreshed=await client.prepare(input);
  server.set('change.txt','other operator');
  const receipt=await client.apply(refreshed.id,['change.txt','create data.bin']);
  assert.deepEqual(receipt.files.map(item=>item.state),['conflict','unattempted']);
  assert.equal(receipt.files[0].httpStatus,412);
  assert.equal(server.files.get('change.txt').bytes.toString(),'other operator');
  assert.equal(server.files.has('create data.bin'),false);
}));
