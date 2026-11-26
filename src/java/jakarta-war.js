'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SaxesParser } = require('saxes');
const { fail,local,buildFingerprint,LIMITS } = require('./workbench-model');

const MAX_WAR_BYTES=256*1024*1024;
const contextPattern=/^[a-z][a-z0-9-]{0,47}$/;
const artifactName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:war|ear)$/;

function mavenArchiveProject(project,packaging) {
  const label=packaging.toUpperCase();
  if (project?.tool!=='maven') throw fail('Choose an imported Maven '+label+' module.');
  const file=path.join(project.root,'pom.xml'), stat=fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>LIMITS.fileBytes) throw fail('Use a bounded regular Maven POM.');
  const source=fs.readFileSync(file,'utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw fail('POM entity and DTD declarations are unsupported.');
  const stack=[], model={};
  const parser=new SaxesParser({xmlns:true});
  parser.on('opentag',tag => {stack.push(tag.local);});
  parser.on('text',value => {
    if (stack.length===2 && stack[0]==='project' && ['packaging','artifactId'].includes(stack[1])) {
      model[stack[1]]=(model[stack[1]]||'')+value;
    }
  });
  parser.on('closetag',() => {stack.pop();});
  parser.write(source).close();
  if (model.packaging?.trim()!==packaging) throw fail('The Maven module must explicitly declare '+label+' packaging.');
  const context=model.artifactId?.trim();
  return {context:contextPattern.test(context || '') ? context : 'app',buildFingerprint:buildFingerprint(project.root)};
}

function verifyArchive(file,packaging) {
  const stat=fs.lstatSync(file), resolved=fs.realpathSync(file);
  if (path.relative(file,resolved) || !stat.isFile() || stat.isSymbolicLink() || stat.size<4 || stat.size>MAX_WAR_BYTES) {
    throw fail('Use a regular local '+packaging.toUpperCase()+' artifact no larger than 256 MiB.');
  }
  return {name:path.basename(resolved),uri:pathToFileURL(resolved).href,file:resolved,size:stat.size};
}

function listArchives(project,packaging) {
  mavenArchiveProject(project,packaging);
  const label=packaging.toUpperCase();
  const target=path.join(project.root,'target');
  if (!fs.existsSync(target)) return [];
  const stat=fs.lstatSync(target);
  if (path.relative(target,fs.realpathSync(target)) || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw fail('The Maven target folder must be a physical module directory.');
  }
  const artifacts=[];
  let scanned=0;
  const folder=fs.opendirSync(target);
  try {
    for (let entry; (entry=folder.readSync())!==null;) {
      if (++scanned>10000 || artifacts.length>=100) throw fail('The Maven target folder exceeds the '+label+' artifact discovery limit.');
      if (entry.isFile() && !entry.isSymbolicLink() && artifactName.test(entry.name)&&entry.name.endsWith('.'+packaging)) {
        artifacts.push(verifyArchive(path.join(target,entry.name),packaging));
      }
    }
  } finally { folder.closeSync(); }
  return artifacts.sort((a,b) => a.name.localeCompare(b.name));
}

function resolveArchive(project,uri,packaging) {
  const wanted=local(uri);
  const artifact=listArchives(project,packaging).find(item => !path.relative(item.file,wanted));
  if (!artifact) throw fail('Choose a built '+packaging.toUpperCase()+' artifact directly under this Maven module’s target folder.');
  return artifact;
}

const mavenWarProject=project=>mavenArchiveProject(project,'war');
const mavenEarProject=project=>mavenArchiveProject(project,'ear');
const listWarArtifacts=project=>listArchives(project,'war');
const listEarArtifacts=project=>listArchives(project,'ear');
const resolveWarArtifact=(project,uri)=>resolveArchive(project,uri,'war');
const resolveEarArtifact=(project,uri)=>resolveArchive(project,uri,'ear');
module.exports = { mavenWarProject,listWarArtifacts,resolveWarArtifact,mavenEarProject,listEarArtifacts,resolveEarArtifact,
  contextPattern,artifactName,MAX_WAR_BYTES };
