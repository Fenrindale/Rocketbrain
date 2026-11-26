'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const {promisify}=require('node:util');
const {test}=require('node:test');
const {createDockerWorkbench,dockerEnvironment}=require('../src/docker/workbench');
const {until}=require('./helpers/stdio-lsp');

const reference='registry.example.com/team/sample:reviewed';
const first='sha256:'+'1'.repeat(64),second='sha256:'+'2'.repeat(64),digest='sha256:'+'3'.repeat(64);
const invoke=promisify(execFile);
const sha256=body=>'sha256:'+createHash('sha256').update(body).digest('hex');

async function fixture(t){
  const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'rb-image-test-'));
  await fs.writeFile(path.join(directory,'Dockerfile'),'FROM scratch\nCOPY payload.txt /payload.txt\n');
  await fs.writeFile(path.join(directory,'payload.txt'),'owned fixture');
  t.after(async()=>{
    const real=await fs.realpath(directory);
    assert.equal(path.relative(directory,real),'');
    assert.equal(path.relative(parent,path.dirname(real)),'');
    assert.ok(path.basename(real).startsWith('rb-image-test-'));
    await fs.rm(real,{recursive:true,force:true,maxRetries:6,retryDelay:150});
  });
  return directory;
}

test('Docker image reviews bind exact context bytes, daemon and local tag before a build or push',async t=>{
  const directory=await fixture(t),images=new Map(),mutations=[];
  const info={Name:'fixture',Endpoints:{docker:{Host:'unix:///var/run/docker.sock',SkipTLSVerify:false}}};
  let daemon='fixture-daemon-infinite',staged;
  const service=createDockerWorkbench({workspaceRoots:()=>[directory],async run(args){
    if(args[0]==='context')return {stdout:JSON.stringify(info)};
    assert.deepEqual(args.slice(0,2),['--context','fixture']);
    if(args[2]==='info')return {stdout:daemon};
    assert.equal(args[2],'image');
    if(args[3]==='ls'){
      const tag=args.find(value=>value.startsWith('reference=')).slice('reference='.length),separator=tag.lastIndexOf(':');
      return {stdout:images.has(tag)?JSON.stringify({Repository:tag.slice(0,separator),Tag:tag.slice(separator+1),ID:images.get(tag)}):''};
    }
    if(args[3]==='build'){
      const context=args.at(-1);
      staged=context;
      assert.notEqual(context,directory);
      assert.equal(path.basename(context).slice(0,18),'rb-docker-context-');
      assert.equal(args[5],path.join(context,'Dockerfile'));
      assert.equal(args[7],reference);
      assert.equal(await fs.readFile(path.join(context,'payload.txt'),'utf8'),'owned fixture');
      mutations.push('build');images.set(reference,second);
      return {stdout:'',stderr:''};
    }
    assert.deepEqual(args.slice(3),['push',reference]);mutations.push('push');
    return {stdout:'reviewed: digest: '+digest+' size: 400\n',stderr:''};
  }});
  t.after(()=>service.dispose());
  await service.selectContext(await service.inspectContext('fixture'));
  await assert.rejects(service.reviewImageBuild(path.dirname(directory),reference),/inside an opened workspace/);
  await assert.rejects(service.reviewImagePush('sample:dev'),/explicit registry/);
  const old=await service.reviewImageBuild(directory,reference);
  assert.equal(old.files,2);assert.equal(old.before,null);
  await assert.rejects(service.applyImage(old.token),/Approve a current Docker/);
  await fs.writeFile(path.join(directory,'payload.txt'),'drift');
  await assert.rejects(service.applyImage(old.token,{approved:true}),/context changed/);
  await fs.writeFile(path.join(directory,'payload.txt'),'owned fixture');
  const driftedTag=await service.reviewImageBuild(directory,reference);
  images.set(reference,first);
  await assert.rejects(service.applyImage(driftedTag.token,{approved:true}),/tag changed/);
  const build=await service.reviewImageBuild(directory,reference);
  assert.equal(build.before,first);
  assert.equal((await service.applyImage(build.token,{approved:true})).image,second);
  await assert.rejects(fs.stat(staged),{code:'ENOENT'});
  const push=await service.reviewImagePush(reference);
  daemon='different-fixture-daemon';
  await assert.rejects(service.applyImage(push.token,{approved:true}),/daemon changed/);
  daemon='fixture-daemon-infinite';
  const ready=await service.reviewImagePush(reference);
  assert.deepEqual(await service.applyImage(ready.token,{approved:true}),{action:'push',reference,image:second,digest});
  await assert.rejects(service.applyImage(ready.token,{approved:true}),/Approve a current Docker/);
  assert.deepEqual(mutations,['build','push']);
});

test('real Docker builds the reviewed context and its private registry serves the same image digest',{
  skip:process.env.ROCKETBRAIN_DOCKER_IMAGE_TEST!=='1'&&'Run the owned Docker engine and registry fixture.',timeout:250000
},async t=>{
  const directory=await fixture(t),owner=randomUUID();
  const run=async args=>invoke('docker',args,{env:dockerEnvironment(),timeout:120000,maxBuffer:1024*1024});
  const service=createDockerWorkbench({workspaceRoots:()=>[directory]});
  const selection=await service.inspectContext('default');
  assert.match(selection.endpoint,/^unix:\/\/(?:\/|[a-zA-Z])/u);
  await service.selectContext(selection);
  const docker=args=>run(['--context','default',...args]);
  let registry,tag;
  try {
    const runRegistry=await docker(['run','--detach','--rm','--name','rb-registry-'+owner,
      '--label','rocketbrain.verification='+owner,'--publish','127.0.0.1::5000','registry:3.0.0']);
    registry=runRegistry.stdout.trim();
    assert.match(registry,/^[0-9a-f]{64}$/u);
    const location=(await docker(['port',registry,'5000/tcp'])).stdout.trim();
    assert.match(location,/^127\.0\.0\.1:\d{1,5}$/u);
    const address='http://'+location;
    await until(async()=>{
      const result=await fetch(address+'/v2/',{signal:AbortSignal.timeout(1000),redirect:'error'}).catch(()=>null);
      if(result?.ok){await result.body?.cancel();return true;}
    },20000);
    const repository='rocketbrain/fixture-'+owner;
    tag=location+'/'+repository+':reviewed';
    const build=await service.reviewImageBuild(directory,tag);
    const built=await service.applyImage(build.token,{approved:true});
    assert.match(built.image,/^sha256:[a-f0-9]{64}$/u);
    const pushed=await service.applyImage((await service.reviewImagePush(tag)).token,{approved:true});
    assert.equal(pushed.image,built.image);
    const acceptable=['application/vnd.oci.image.manifest.v1+json','application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json','application/vnd.docker.distribution.manifest.list.v2+json'];
    async function manifest(name){
      const response=await fetch(address+'/v2/'+repository+'/manifests/'+name,{
        headers:{Accept:acceptable.join(', ')},redirect:'error',signal:AbortSignal.timeout(5000)});
      assert.equal(response.ok,true);
      const body=Buffer.from(await response.arrayBuffer()),actual=sha256(body);
      assert.equal(actual,response.headers.get('docker-content-digest'));
      return {manifest:JSON.parse(body),actual};
    }
    const remote=await manifest('reviewed');
    assert.equal(remote.actual,pushed.digest);
    const concrete=remote.manifest.config ? remote.manifest : (await manifest(remote.manifest.manifests.find(item=>
      item.platform?.os==='linux'&&item.platform?.architecture!=='unknown').digest)).manifest;
    assert.equal(concrete.config.digest,built.image);
    const receipt=process.env.ROCKETBRAIN_DOCKER_IMAGE_RECEIPT;
    if(receipt)await fs.writeFile(receipt,JSON.stringify({sourceCommit:process.env.GITHUB_SHA,digest:pushed.digest,
      engine:(await docker(['version','--format','{{.Server.Version}}'])).stdout.trim(),contextFingerprint:built.fingerprint,
      loopbackRegistry:true,manifestBytesMatch:true,imageConfigMatches:true,reviewedBuild:true,reviewedPush:true},null,2)+'\n',{flag:'wx'});
  } finally {
    service.dispose();
    if(tag)await docker(['image','rm',tag]).catch(()=>{});
    if(registry){
      const label=(await docker(['container','inspect','--format','{{index .Config.Labels "rocketbrain.verification"}}',registry])).stdout.trim();
      assert.equal(label,owner);
      await docker(['container','stop',registry]);
    }
  }
});
