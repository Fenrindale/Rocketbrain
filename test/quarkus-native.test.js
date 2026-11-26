'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const path=require('node:path');
const {nativeElfHeader,nativeMavenFlags,createQuarkusNative}=require('../src/java/quarkus-native');
const {quarkusMavenProject}=require('../src/java/quarkus-model');

function elf(machine,type=3){
  const header=Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46);
  header.set([2,1,1],4);
  header.writeUInt16LE(type,16);
  header.writeUInt16LE(machine,18);
  header.writeUInt32LE(1,20);
  return header;
}

test('Quarkus image accepts only matching executable 64-bit Linux ELF headers',()=>{
  assert.equal(nativeElfHeader(elf(62),'x64'),true);
  assert.equal(nativeElfHeader(elf(183,2),'arm64'),true);
  assert.equal(nativeElfHeader(elf(183),'x64'),false);
  assert.equal(nativeElfHeader(elf(62,1),'x64'),false);
  assert.equal(nativeElfHeader(Buffer.from('PK\u0003\u0004'),'x64'),false);
  const swapped=elf(62);
  swapped[5]=2;
  assert.equal(nativeElfHeader(swapped,'x64'),false);
});

test('native Maven flags name one fresh binary and pin local image mode',()=>{
  const out=path.resolve('target','rocketbrain-native-A b');
  const flags=nativeMavenFlags(out);
  assert.ok(flags.includes('-Dquarkus.package.output-directory='+out));
  assert.ok(flags.includes('-Dquarkus.native.enabled=true'));
  assert.ok(flags.includes('-Dquarkus.native.container-build=false'));
  assert.ok(flags.includes('-Dquarkus.native.sources-only=false'));
  assert.ok(flags.includes('-Dquarkus.native.bundle.dry-run=false'));
  assert.ok(flags.includes('-Dquarkus.package.jar.enabled=false'));
  const root=path.resolve(__dirname,'fixtures/java/quarkus-native-linux/quarkus');
  assert.equal(quarkusMavenProject({root,tool:'maven'}).version,'3.40.1.2');
});

test('native controller refuses execution on a host without the supported Linux runtime',{
  skip:process.platform==='linux'&&['x64','arm64'].includes(process.arch)
},async()=>{
  const service=createQuarkusNative();
  try{
    await assert.rejects(service.build({}),/Linux x64 or arm64/u);
    await assert.rejects(service.start({}),/Linux x64 or arm64/u);
    assert.deepEqual(await service.stop(),{state:'stopped'});
  }finally{await service.dispose();}
});
