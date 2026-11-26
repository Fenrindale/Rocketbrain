'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inside, runWorker, selectNode } = require('./vue-tools');
const { reactWorker } = require('./react-worker');

const maxSourceBytes=256*1024;
const nodeSetting='rocketbrain.react.nodePath';

async function localFile(root,file) {
  const physical=await fs.realpath(file).catch(()=>undefined);
  if (physical && inside(root,physical) && (await fs.stat(physical)).isFile()) return physical;
}

async function readManifest(file) {
  if ((await fs.stat(file)).size>maxSourceBytes) throw Error('React project metadata exceeds its inspection limit.');
  return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
}

async function inspectReactProject(workspace,file) {
  const boundary=await fs.realpath(workspace);
  const source=await localFile(boundary,file);
  if (!source?.endsWith('.tsx')) return;
  for (let root=path.dirname(source);inside(boundary,root);root=path.dirname(root)) {
    const manifest=await localFile(root,path.join(root,'package.json'));
    if (manifest) {
      const project=await readManifest(manifest);
      if (typeof(project.dependencies?.react ?? project.devDependencies?.react)==='string') {
        const compilerManifest=await localFile(root,path.join(root,'node_modules/typescript/package.json'));
        if (!compilerManifest) return;
        const compiler=await readManifest(compilerManifest);
        if (compiler.name!=='typescript') return;
        const entry=await localFile(root,path.join(path.dirname(compilerManifest),'lib/typescript.js'));
        const appConfig=await localFile(root,path.join(root,'tsconfig.app.json'));
        const config=appConfig ?? await localFile(root,path.join(root,'tsconfig.json'));
        if (entry && config) return {root,source,config,entry};
        return;
      }
    }
    if (!path.relative(root,boundary)) return;
  }
}

async function inspectReactProps({workspace,file,source,offset,action,nodePath,signal}) {
  if (!['complete','definition','references','check'].includes(action) ||
      typeof source!=='string' || Buffer.byteLength(source)>maxSourceBytes ||
      !Number.isSafeInteger(offset) || offset<0 || offset>source.length) return;
  const project=await inspectReactProject(workspace,file);
  if (!project) return;
  const node=await selectNode(nodePath,nodeSetting);
  const worker=await runWorker(project,node,{source,offset,action,file:project.source,entry:project.entry,config:project.config},
    signal,{worker:reactWorker,label:'React',timeoutMs:8500});
  await worker.closed;
  if (!worker.ready) return;
  const verified=[];
  for (const location of worker.ready.locations||[]) {
    const physical=await localFile(project.root,location.file);
    if (physical && /\.[cm]?tsx?$/u.test(physical) &&
        !path.relative(location.file,physical) && !physical.split(path.sep).includes('node_modules')) {
      verified.push({...location,file:physical});
    }
  }
  return {...worker.ready,locations:verified};
}

module.exports={inspectReactProps};
