'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const base = path.resolve(__dirname,'../fixtures/java/processors');
const sourceRoot = 'src/main/java/processors/fixture';
const NAMES = Object.freeze(['Profile','ProfileDto','ProfileMapper','ProcessorProbe']);

async function copyProcessorProject(root,tool) {
  if (!['maven','gradle'].includes(tool)) throw Error('Choose an owned Maven or Gradle processor fixture.');
  await fs.mkdir(root,{recursive:true});
  await fs.cp(path.join(base,'src'),path.join(root,'src'),{recursive:true});
  for (const name of tool === 'maven' ? ['pom.xml'] : ['build.gradle','settings.gradle']) {
    await fs.copyFile(path.join(base,name),path.join(root,name));
  }
  return root;
}

function processorSource(root,name) {
  if (!NAMES.includes(name)) throw Error('Choose an owned annotation processor source.');
  return path.join(root,sourceRoot,name+'.java');
}

function renamedProcessorSources(sources) {
  return {
    Profile:sources.Profile.replace('String label','String alias'),
    ProfileMapper:sources.ProfileMapper.replace('source = "label"','source = "alias"'),
    ProcessorProbe:sources.ProcessorProbe.replace('getLabel()','getAlias()')
  };
}

module.exports = { copyProcessorProject,processorSource,renamedProcessorSources };
