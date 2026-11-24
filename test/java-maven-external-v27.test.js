'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { mavenBuild, moveClientProof } = require('../src/java/move-builds');
const { lockName } = require('../src/java/maven-external-models');

const fixture = path.join(__dirname,'fixtures/refactoring-v27-maven');
const modelFixtures = path.join(__dirname,'fixtures/refactoring-v27-maven-models');
const modules = ['rb27-core','rb27-app','rb27-consumer','rb27-project-parent'];
const company = 'rb27-company-parent', library = 'rb27-library-bom';

function ownedReactor() {
 const base = path.resolve('test-output/v0.27-maven-external-unit');
 fs.mkdirSync(base,{recursive:true});
 const folder = fs.mkdtempSync(path.join(base,'case-'));
 const root = path.join(folder,'reactor'),repository = path.join(folder,'repository');
 const lock = path.join(root,lockName);
 for (const module of ['',...modules]) {
  const target = path.join(root,module);
  fs.mkdirSync(target,{recursive:true});
  fs.copyFileSync(path.join(fixture,module,'pom.xml'),path.join(target,'pom.xml'));
 }
 fs.copyFileSync(path.join(fixture,lockName),lock);
 const {models} = JSON.parse(fs.readFileSync(lock,'utf8'));
 const files = new Map();
 for (const pin of models) {
  const target = path.join(repository,...pin.groupId.split('.'),pin.artifactId,pin.version,pin.artifactId+'-'+pin.version+'.pom');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(modelFixtures,pin.artifactId,'pom.xml'),target);
  files.set(pin.artifactId,target);
 }
 return {root,repository,lock,files,models};
}

test('Maven checks the exact external parent and nested BOMs and retains compiler visibility', () => {
 const {root,repository,lock,models} = ownedReactor();
 const build = mavenBuild(root,{repository});
 assert.equal(build.files.length,6);
 assert.ok(build.files.includes(lock));
 assert.ok(build.files.every(file=>!file.startsWith(repository+path.sep)));
 const expected = models.map(pin=>({coordinate:[pin.groupId,pin.artifactId,pin.version].join(':'),sha256:pin.sha256}));
 assert.deepEqual(build.externalModels.pins.toSorted((a,b)=>a.coordinate.localeCompare(b.coordinate)),expected.toSorted((a,b)=>a.coordinate.localeCompare(b.coordinate)));
 assert.equal(build.modelContracts.find(model=>model.module==='rb27-app').bomImportDepth,2);
 assert.deepEqual(build.scenarios.map(s=>s.edgeKinds.get('rb27-consumer').get('rb27-app')),['compile','runtime','compile','compile']);
 assert.doesNotThrow(()=>moveClientProof(build,'rb27-app','rb27-core'));
 assert.doesNotThrow(()=>build.externalModels.validate());
});

test('Maven rejects missing or modified cache files and changed workspace pins', () => {
 const {root,repository,lock,files} = ownedReactor();
 const plan = mavenBuild(root,{repository});
 const target = files.get(library),original = fs.readFileSync(target);
 fs.appendFileSync(target,'<!-- modified cache contents -->\n');
 assert.throws(()=>plan.externalModels.validate(),/SHA-256 mismatch/);
 assert.throws(()=>mavenBuild(root,{repository}),/SHA-256 mismatch/);
 fs.unlinkSync(target);
 assert.throws(()=>plan.externalModels.validate(),/missing from the local repository/);
 fs.writeFileSync(target,original);
 fs.appendFileSync(lock,'\n');
 assert.throws(()=>plan.externalModels.validate(),/pins or settings changed/);
});

test('Maven rejects mismatched POM coordinates even with a matching digest and refuses snapshot or override resolution', () => {
 const {root,repository,lock,files,models} = ownedReactor();
 const target = files.get(company);
 const bytes = fs.readFileSync(target,'utf8').replace('<artifactId>'+company+'</artifactId>','<artifactId>other-parent</artifactId>');
 fs.writeFileSync(target,bytes);
 const pin = models.find(item=>item.artifactId===company);
 pin.sha256 = createHash('sha256').update(bytes).digest('hex');
 fs.writeFileSync(lock,JSON.stringify({version:1,models}));
 assert.throws(()=>mavenBuild(root,{repository}),/exactly its pinned coordinates/);
 pin.version = '1.0.0-SNAPSHOT';
 fs.writeFileSync(lock,JSON.stringify({version:1,models}));
 assert.throws(()=>mavenBuild(root,{repository}),/literal release coordinates/);
 const settings = path.join(path.dirname(repository),'settings.xml');
 fs.writeFileSync(settings,'<settings><localRepository>other</localRepository></settings>');
 pin.version = '1.0.0';
 fs.writeFileSync(lock,JSON.stringify({version:1,models}));
 assert.throws(()=>mavenBuild(root,{repository}),/custom Maven localRepository/);
});

test('Maven requires locally available POM origin metadata and rechecks it after preview', () => {
 const {root,repository,files} = ownedReactor();
 const model = files.get(library);
 const tracking = path.join(path.dirname(model),'_remote.repositories');
 const legacy = mavenBuild(root,{repository});
 fs.writeFileSync(tracking,path.basename(model)+'>unavailable-repository=\n');
 assert.throws(()=>mavenBuild(root,{repository}),/remote-origin cached POM/);
 assert.throws(()=>legacy.externalModels.validate(),/remote-origin cached POM/);
 fs.appendFileSync(tracking,path.basename(model)+'>=\n');
 const installed = mavenBuild(root,{repository});
 assert.doesNotThrow(()=>installed.externalModels.validate());
 assert.throws(()=>legacy.externalModels.validate(),/origin metadata changed/);
});
