'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {fail}=require('./workbench-model');
const starter=require('./quarkus-starter-source.json');

async function createQuarkusProject({parent,name,workspaceTrusted,allowProjectWrites} = {}) {
  if (workspaceTrusted!==true || allowProjectWrites!==true) throw fail('Choose a new Quarkus project in a trusted workspace.');
  if (!path.isAbsolute(parent || '') || typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw fail('Use a local directory and an artifact name with lowercase letters, numbers and hyphens.');
  }
  const physical=await fs.realpath(parent), stat=await fs.lstat(parent);
  if (path.relative(parent,physical) || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw fail('Choose a physical project parent directory.');
  }
  const root=path.join(physical,name);
  await fs.mkdir(root); // No existing destination is overwritten, even if it is empty.
  for (const [relative,source] of Object.entries(starter)) {
    const file=path.join(root,relative.replace('quarkusfixture','demo/quarkus'));
    const text=source.replaceAll('quarkusfixture','demo.quarkus').replaceAll('rocketbrain-quarkus-fixture',name);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,text,{flag:'wx'});
  }
  return {root,pom:path.join(root,'pom.xml'),files:Object.keys(starter).length};
}

module.exports = { createQuarkusProject };
