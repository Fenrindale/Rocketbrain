'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {requestAt,resolveRequest}=require('../src/http/client');
const {readWorkspaceBodyFile}=require('../src/http/body-file');

const input='# @body-file "nested/payload.bin"\nPOST https://example.test/upload';

test('file requests require an explicit binary loader and keep exact body data and content type',async()=>{
  const parsed=requestAt(input,0);
  assert.equal(parsed.bodyFile,'nested/payload.bin');
  await assert.rejects(resolveRequest(parsed,{},()=>{}),/trusted local workspace/);
  const content=Buffer.from([0,255,13,10,128,1]);
  const options={readBodyFile:async(file,limit)=>{
    assert.equal(file,'nested/payload.bin');
    assert.ok(limit<512*1024);
    return content;
  }};
  const first=await resolveRequest(parsed,{},()=>{},options);
  assert.deepEqual(first.body,content);
  assert.equal(first.headers['Content-Type'],'application/octet-stream');
  const second=await resolveRequest(requestAt(input+'\nContent-Type: application/zip',0),{},()=>{},options);
  assert.equal(second.headers['Content-Type'],'application/zip');
  await assert.rejects(resolveRequest(parsed,{},()=>{},{readBodyFile:async()=>'lossy string'}),/exact bytes/);
  assert.throws(()=>requestAt(input+'\n\ninline body',0),/empty inline body/);
  assert.throws(()=>requestAt(input.replace('POST','GET'),0),/body-capable HTTP/);
  assert.throws(()=>requestAt('# @body-file "other.bin"\n'+input,0),/one quoted/);
  const next=input+'\n### Other\nGET https://example.test';
  assert.equal(requestAt(next,next.lastIndexOf('GET')).bodyFile,undefined);
});

test('body file reader bounds actual bytes and refuses traversal and symbolic parents',async context=>{
  const temp=await fs.realpath(os.tmpdir());
  const directory=await fs.mkdtemp(path.join(temp,'rb-body-file-test-'));
  context.after(async()=>{
    const checked=await fs.realpath(directory);
    assert.equal(path.relative(directory,checked),'');
    assert.equal(path.dirname(checked),temp);
    assert.match(path.basename(checked),/^rb-body-file-test-/);
    await fs.rm(checked,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  });
  const workspace=path.join(directory,'workspace'),outside=path.join(directory,'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const content=Buffer.from([0,255,128,0]);
  await fs.writeFile(path.join(workspace,'bytes.bin'),content,{flag:'wx'});
  await fs.writeFile(path.join(outside,'private.bin'),content,{flag:'wx'});
  await fs.symlink(outside,path.join(workspace,'alias'),process.platform==='win32'?'junction':'dir');
  assert.deepEqual(await readWorkspaceBodyFile(workspace,'bytes.bin',4),content);
  await assert.rejects(readWorkspaceBodyFile(workspace,'bytes.bin',3),/within 512 KiB/);
  await assert.rejects(readWorkspaceBodyFile(workspace,'../outside/private.bin',10),/workspace-relative/);
  await assert.rejects(readWorkspaceBodyFile(workspace,'/outside/private.bin',10),/workspace-relative/);
  await assert.rejects(readWorkspaceBodyFile(workspace,'alias/private.bin',10),/inside this workspace/);
});
