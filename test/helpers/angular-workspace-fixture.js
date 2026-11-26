'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const template=path.resolve(__dirname,'../fixtures/angular-workbench');
const kind='RocketbrainOwnedAngularFixture-v1';
const files=['package.json','pnpm-lock.yaml','tsconfig.json','src/dashboard.component.ts','src/dashboard.component.html'];

async function stageAngularFixture(parent) {
  const boundary=await fs.realpath(parent);
  const root=await fs.mkdtemp(path.join(boundary,'rb-angular-fixture-'));
  await fs.mkdir(path.join(root,'src'));
  for (const file of files) await fs.copyFile(path.join(template,file),path.join(root,file));
  await fs.writeFile(path.join(root,'owner.json'),JSON.stringify({kind,id:path.basename(root)}),{flag:'wx'});
  return root;
}

async function ownedAngularFixture(candidate) {
  const root=await fs.realpath(candidate);
  const owner=JSON.parse(await fs.readFile(path.join(root,'owner.json'),'utf8'));
  if (owner.kind!==kind||owner.id!==path.basename(root)||!/^rb-angular-fixture-[A-Za-z0-9]{6}$/u.test(owner.id)) {
    throw Error('Use a disposable Angular fixture staged by Rocketbrain.');
  }
  return root;
}

if (require.main===module) stageAngularFixture(process.argv[2]).then(root=>console.log(root))
  .catch(error=>{console.error(error.message);process.exitCode=1;});

module.exports={stageAngularFixture,ownedAngularFixture};
