'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const packages = ['@angular/core','@angular/language-server','@angular/language-service','@angular/compiler-cli','@angular/compiler','typescript'];
const configs = ['tsconfig.app.json','tsconfig.json'];
const localSource = /\.(?:html|ts)$/iu;
const included = /\.(?:ts|html|json|jsonc|css|s[ac]ss|less)$/iu;
const excluded = new Set(['node_modules','.git','.angular','dist','coverage','build','target']);
const version = /^\d+\.\d+\.\d+$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unc = /^(?:\\\\|\/\/)/u;

function inside(root, file) {
  const relative = path.relative(root,file);
  return !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);
}

async function physical(root, candidate, directory = false) {
  if (!path.isAbsolute(candidate) || unc.test(candidate) || !inside(root,candidate)) return;
  const file = await fs.realpath(candidate).catch(()=>null);
  if (!file || !inside(root,file)) return;
  const stat = await fs.stat(file).catch(()=>null);
  if (directory?stat?.isDirectory():stat?.isFile()) return file;
}

async function read(file, limit) {
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const original=await handle.stat({bigint:true});
    if (!original.isFile()||original.size>BigInt(limit)) throw Error('An Angular input exceeds its size limit.');
    const bytes=Buffer.alloc(Number(original.size));
    let offset=0;
    while (offset<bytes.length) {
      const item=await handle.read(bytes,offset,bytes.length-offset,offset);
      if (!item.bytesRead) break;
      offset+=item.bytesRead;
    }
    const current=await fs.lstat(file,{bigint:true}), held=await handle.stat({bigint:true});
    if (offset!==bytes.length||!current.isFile()||path.relative(file,await fs.realpath(file))||
        ['dev','ino','size','ctimeNs','mtimeNs'].some(key=>current[key]!==original[key]||held[key]!==original[key])) {
      throw Error('An Angular input changed during inspection.');
    }
    return bytes;
  } finally { await handle.close(); }
}

async function manifest(file) {
  return JSON.parse((await read(file,128*1024)).toString('utf8').replace(/^\uFEFF/u,''));
}

async function resolveAngularNode(value) {
  const name=process.platform==='win32'?'node.exe':'node';
  const values=value?[value]:(process.env.PATH||'').split(path.delimiter).filter(item=>path.isAbsolute(item)&&!unc.test(item))
    .map(directory=>path.join(directory,name));
  for (const file of values) {
    if (typeof file!=='string'||!path.isAbsolute(file)||unc.test(file)||path.basename(file).toLowerCase()!==name) continue;
    const absolute=await fs.realpath(file).catch(()=>null);
    if (absolute&&!unc.test(absolute)&&(await fs.stat(absolute).catch(()=>null))?.isFile()) return absolute;
  }
  throw Error('Configure a standalone local Node.js executable for Angular analysis.');
}

async function projectRoot(workspace,input) {
  if (!path.isAbsolute(workspace)||unc.test(workspace)||!path.isAbsolute(input)||unc.test(input)) {
    throw Error('Open an Angular file in a local workspace.');
  }
  const boundary=await fs.realpath(workspace), chosen=await fs.realpath(input);
  if (!inside(boundary,chosen)) throw Error('Choose an Angular project inside the current workspace.');
  let root=(await fs.stat(chosen)).isDirectory()?chosen:path.dirname(chosen);
  while (inside(boundary,root)) {
    const file=await physical(root,path.join(root,'package.json'));
    if (file) {
      const config=await manifest(file);
      if (typeof (config.dependencies?.['@angular/core']??config.devDependencies?.['@angular/core'])==='string') return {root,file};
    }
    if (!path.relative(root,boundary)) break;
    root=path.dirname(root);
  }
  throw Error('Choose a local project that declares @angular/core.');
}

async function inspectAngularProject(workspace,input,nodePath) {
  const {root,file}=await projectRoot(workspace,input);
  if (root.includes(',')) throw Error('The Angular server requires a project path without commas.');
  const dependencies=await physical(root,path.join(root,'node_modules'),true);
  if (!dependencies) throw Error('Install the Angular project dependencies before starting analysis.');
  let config;
  for (const name of configs) {
    config=await physical(root,path.join(root,name));
    if (config) break;
  }
  if (!config) throw Error('Choose an Angular project with a local TypeScript configuration.');
  const tools={};
  for (const name of packages) {
    const resolved=await physical(dependencies,path.join(dependencies,name,'package.json'));
    if (!resolved) throw Error('Install '+name+' in the selected Angular project.');
    const info=await manifest(resolved);
    if (info.name!==name||!version.test(info.version)) throw Error('The installed Angular tool manifest is invalid.');
    tools[name]={info,manifest:resolved,root:path.dirname(resolved)};
  }
  const built=tools['@angular/core'].info.version;
  const server=tools['@angular/language-server'], language=tools['@angular/language-service'];
  const typescript=tools.typescript;
  if (!built.startsWith('22.')||packages.slice(0,-1).some(name=>tools[name].info.version!==built)||
      server.info.dependencies?.typescript!==typescript.info.version||!typescript.info.version.startsWith('6.')) {
    throw Error('Use matching Angular 22 packages and the TypeScript 6 version declared by the installed language server.');
  }
  const compiled=tools['@angular/compiler-cli'];
  const entries=await Promise.all([
    physical(server.root,path.join(server.root,'index.js')),
    physical(language.root,path.join(language.root,'index.js')),
    physical(language.root,path.join(language.root,'factory_bundle.js')),
    physical(typescript.root,path.join(typescript.root,'lib/typescript.js')),
    physical(typescript.root,path.join(typescript.root,'lib/tsserverlibrary.js')),
    physical(compiled.root,path.join(compiled.root,'bundles/index.js'))
  ]);
  if (entries.some(entry=>!entry)) throw Error('The installed Angular analysis toolchain is incomplete.');
  const node=await resolveAngularNode(nodePath);
  const nodeStat=await fs.stat(node,{bigint:true});
  const bindings=await Promise.all([file,config,...Object.values(tools).map(item=>item.manifest),...entries]
    .map(async item=>[item,digest(await read(item,32*1024*1024))]));
  const fingerprint=digest(JSON.stringify([root,dependencies,node,String(nodeStat.mtimeNs),String(nodeStat.ino),bindings]));
  return {root,config,dependencies,node,fingerprint,server:entries[0],checker:entries[5],typescript:entries[3],
    version:built,typescriptVersion:typescript.info.version};
}

async function angularSource(root,file) {
  if (typeof file!=='string'||!localSource.test(file)) return;
  const actual=await physical(root,file);
  if (!actual||path.relative(actual,file)||path.relative(root,actual).split(path.sep).some(part=>excluded.has(part))) return;
  return actual;
}

async function captureAngularProject(root) {
  const files=[];
  let visited=0, total=0;
  async function walk(directory, depth) {
    if (depth>24) throw Error('Angular source paths are nested too deeply.');
    const names=(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for (const entry of names) {
      if (++visited>5000) throw Error('The Angular project exceeds 5,000 inspected files and directories.');
      if (excluded.has(entry.name)||entry.name.startsWith('.')) continue;
      const file=path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw Error('Use direct physical Angular project sources and configurations.');
      if (entry.isDirectory()) { await walk(file,depth+1); continue; }
      if (!entry.isFile()||!included.test(entry.name)) continue;
      if (files.length>=450) throw Error('The Angular compiler check accepts up to 450 source files.');
      if (path.relative(await physical(root,file)||root,file)) throw Error('An Angular project source path changed.');
      const bytes=await read(file,512*1024);
      if ((total+=bytes.length)>8*1024*1024) throw Error('The Angular compiler check accepts up to 8 MiB of source files.');
      files.push({file,relative:path.relative(root,file),bytes,sha256:digest(bytes)});
    }
  }
  await walk(root,0);
  const fingerprint=digest(JSON.stringify(files.map(row=>[row.relative,row.sha256])));
  return {files,fingerprint};
}

function angularEnvironment() {
  const keys=new Set(['path','systemroot','windir','comspec','temp','tmp','tmpdir','lang','lc_all']);
  return Object.fromEntries(Object.entries(process.env).filter(([name])=>keys.has(name.toLowerCase())));
}

module.exports = {inspectAngularProject, angularSource, captureAngularProject, angularEnvironment, inside};
