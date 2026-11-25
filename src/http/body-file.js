'use strict';

const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');

async function readWorkspaceBodyFile(folder,file,maxBytes) {
  const parts=typeof file==='string'?file.split('/'):[];
  if (!parts.length||!Number.isInteger(maxBytes)||maxBytes<0||maxBytes>512*1024||file.length>512||
      parts.some(part=>!part||part==='.'||part==='..'||/[\\:\u0000-\u001f\u007f]/.test(part))) {
    throw Error('Use a portable workspace-relative @body-file path and a body within the request limit.');
  }
  const root=await fs.realpath(folder);
  const target=path.join(root,...parts);
  const matches=(left,right)=>left.isFile()&&right.isFile()&&left.dev===right.dev&&left.ino===right.ino&&
    left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs;
  let handle;
  try {
    if (path.relative(target,await fs.realpath(target))) throw Error();
    const named=await fs.lstat(target,{bigint:true});
    if (!named.isFile()||named.isSymbolicLink()||named.size>BigInt(maxBytes)) throw Error();
    handle=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const opened=await handle.stat({bigint:true});
    if (!matches(named,opened)) throw Error();
    const buffer=Buffer.alloc(Number(opened.size)+1);
    let total=0;
    while (total<buffer.length) {
      const {bytesRead}=await handle.read(buffer,total,buffer.length-total,total);
      if (!bytesRead) break;
      total+=bytesRead;
    }
    if (total!==Number(opened.size)||!matches(opened,await handle.stat({bigint:true}))||
        path.relative(target,await fs.realpath(target))||!matches(opened,await fs.lstat(target,{bigint:true}))) throw Error();
    return buffer.subarray(0,total);
  } catch {
    throw Error('Use a regular unchanged body file inside this workspace and within 512 KiB including headers.');
  } finally {
    await handle?.close();
  }
}

module.exports={readWorkspaceBodyFile};
