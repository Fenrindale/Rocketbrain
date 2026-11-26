'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const fileLimit = 2400;
const sizeLimit = 64 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function within(root, file) {
  const relative = path.relative(root,file);
  return !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);
}

async function localContext(directory, workspaceRoots) {
  if (!path.isAbsolute(directory || '') || !Array.isArray(workspaceRoots)) throw Error('Choose a local Docker build context in a trusted workspace.');
  const resolved = await fs.realpath(directory);
  if (path.relative(resolved,directory) || !(await fs.lstat(resolved)).isDirectory() ||
      !(await Promise.all(workspaceRoots.filter(root=>path.isAbsolute(root)).map(root=>fs.realpath(root))))
        .some(root=>within(root,resolved))) {
    throw Error('Choose a physical build directory inside an opened workspace folder.');
  }
  return resolved;
}

async function captureBuildContext(directory,{signal,copyTo}={}) {
  const entries = [];
  let totalBytes = 0;
  const identity = await fs.lstat(directory,{bigint:true});
  if (!identity.isDirectory() || path.relative(directory,await fs.realpath(directory))) throw Error('The Docker build directory changed.');

  async function readDirectory(current, depth) {
    if (depth>24) throw Error('The Docker build context is nested more than 24 levels.');
    const children = (await fs.readdir(current)).sort();
    for (const name of children) {
      if (signal?.aborted) throw Error('Docker build review was cancelled.');
      if (entries.length>=fileLimit) throw Error('The Docker build context exceeds 2400 entries.');
      if (/[\\\x00-\x1f\x7f]/u.test(name)) throw Error('The Docker build context contains an unsupported filename.');
      const file = path.join(current,name), relative = path.relative(directory,file);
      const before = await fs.lstat(file,{bigint:true});
      if (before.isSymbolicLink() || path.relative(file,await fs.realpath(file))) throw Error('Use a Docker build tree without links to other paths.');
      const mode = Number(before.mode & 0o777n);
      const target = copyTo && path.join(copyTo,relative);
      const portableName = relative.split(path.sep).join('/');
      if (before.isDirectory()) {
        entries.push({name:portableName,mode,directory:true});
        if (target) await fs.mkdir(target);
        await readDirectory(file,depth+1);
        if (target) await fs.chmod(target,mode);
        continue;
      }
      if (!before.isFile()) throw Error('Use only regular files and directories in the Docker build context.');
      if (before.size>BigInt(sizeLimit-totalBytes)) throw Error('The Docker build context exceeds 64 MiB.');
      const handle = await fs.open(file,'r');
      let data;
      try {
        const opened = await handle.stat({bigint:true});
        if (!opened.isFile() || before.dev!==opened.dev || before.ino!==opened.ino || before.size!==opened.size) {
          throw Error('A Docker context file changed before it could be read.');
        }
        data = Buffer.alloc(Number(before.size));
        let offset=0;
        while(offset<data.length){
          const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);
          if(!bytesRead)throw Error('A Docker context file was truncated while it was being read.');
          offset+=bytesRead;
        }
      } finally { await handle.close(); }
      const after = await fs.lstat(file,{bigint:true});
      if (data.length>sizeLimit-totalBytes || before.dev!==after.dev || before.ino!==after.ino ||
          before.mtimeNs!==after.mtimeNs || before.size!==BigInt(data.length) || before.mode!==after.mode ||
          path.relative(file,await fs.realpath(file))) throw Error('A Docker context file changed while it was being read.');
      totalBytes+=data.length;
      entries.push({name:portableName,mode,bytes:data.length,sha256:sha256(data)});
      if (target) {
        await fs.writeFile(target,data,{flag:'wx',mode});
        await fs.chmod(target,mode);
      }
    }
  }

  await readDirectory(directory,0);
  const again = await fs.lstat(directory,{bigint:true});
  if (identity.dev!==again.dev || identity.ino!==again.ino || path.relative(directory,await fs.realpath(directory))) {
    throw Error('The Docker build directory changed.');
  }
  if (!entries.some(entry=>entry.name==='Dockerfile'&&!entry.directory)) throw Error('Choose a build directory with a Dockerfile at its root.');
  return {fingerprint:sha256(JSON.stringify(entries)),files:entries.filter(entry=>!entry.directory).length,bytes:totalBytes};
}

async function stageBuildContext(directory, fingerprint, signal, run) {
  const parent = await fs.realpath(os.tmpdir());
  const stage = await fs.mkdtemp(path.join(parent,'rb-docker-context-'));
  const identity = await fs.lstat(stage,{bigint:true});
  try {
    const actual = await captureBuildContext(directory,{signal,copyTo:stage});
    if (actual.fingerprint!==fingerprint) throw Error('The Docker build context changed. Review its files again.');
    return await run(stage);
  } finally {
    const real = await fs.realpath(stage), current = await fs.lstat(real,{bigint:true});
    if (path.relative(stage,real) || path.relative(parent,path.dirname(real)) || !path.basename(real).startsWith('rb-docker-context-') ||
        current.dev!==identity.dev || current.ino!==identity.ino) throw Error('The staged Docker context changed ownership.');
    async function makeWritable(folder) {
      await fs.chmod(folder,0o700);
      for (const member of await fs.readdir(folder,{withFileTypes:true})) {
        const file=path.join(folder,member.name);
        if (member.isDirectory() && !path.relative(file,await fs.realpath(file))) await makeWritable(file);
      }
    }
    await makeWritable(real);
    await fs.rm(real,{recursive:true,force:true,maxRetries:6,retryDelay:150});
  }
}

module.exports = {localContext,captureBuildContext,stageBuildContext};
