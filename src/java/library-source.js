'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const yauzl=require('yauzl');
const {crc32}=require('./signature-compiler');

const FILE_LIMIT=128*1024*1024,SOURCE_LIMIT=1024*1024,ENTRY_LIMIT=20000;
const DEFAULT_SOURCE_NAMES=/^(?:[$\p{ID_Start}][$\p{ID_Continue}]*\.)*[$\p{ID_Start}][$\p{ID_Continue}]*$/u;
const normalized=text=>text.replace(/^\ufeff/,'').replace(/\r\n/g,'\n');
const sameFile=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.isAbsolute(a)&&path.isAbsolute(b)&&path.relative(a,b)==='';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function libraryClass(uri) {
  let target;
  try {target=new URL(uri);}catch {throw Error('Open a JDT library class from Java definition navigation.');}
  let segments;
  try {segments=target.pathname.slice(1).split('/').map(part=>decodeURIComponent(part));}
  catch {throw Error('The selected Java library class has an invalid name.');}
  const [jar,packageName,file]=segments;
  const name=/^(.+)\.(?:class|java)$/.exec(file||'')?.[1];
  if(target.protocol!=='jdt:'||target.host!=='contents'||!target.search||target.hash||uri.length>8192||segments.length!==3||
      !jar?.toLowerCase().endsWith('.jar')||/[/\\\u0000-\u001f]/u.test(jar)||packageName&&!DEFAULT_SOURCE_NAMES.test(packageName)||
      !name||name.includes('.')||!DEFAULT_SOURCE_NAMES.test(name)) {
    throw Error('Choose a Java class from a JAR resolved by JDT.');
  }
  const prefix=packageName?packageName.replaceAll('.','/')+'/':'';
  const entries=[prefix+name+'.java'];
  if(name.includes('$')&&!name.startsWith('$'))entries.push(prefix+name.split('$')[0]+'.java');
  return {uri,jar,entries};
}

async function archiveFile(file) {
  if(typeof file!=='string'||!path.isAbsolute(file)||/^[\\/]{2}/.test(file)||!(/\.(?:jar|zip)$/i.test(file))) {
    throw Error('Choose a local JAR or ZIP archive.');
  }
  const stats=await fs.lstat(file,{bigint:true}),real=await fs.realpath(file);
  if(!stats.isFile()||stats.isSymbolicLink()||stats.size>FILE_LIMIT||stats.size<22||!sameFile(file,real)) {
    throw Error('Use a regular local JAR or ZIP archive of at most 128 MiB without path links.');
  }
  return {file:real,identity:[stats.dev,stats.ino,stats.size,stats.mtimeNs,stats.ctimeNs].join('/')};
}

function readSelectedSource(file,entries) {
  return new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{
    if(error)return reject(Error('The selected source archive is not a readable JAR or ZIP.',{cause:error}));
    let done=false,selected,count=0;
    const names=new Set();
    const finish=(error,result)=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      zip.close();
      if(error)reject(error);else resolve(result);
    };
    const timer=setTimeout(()=>finish(Error('Reading the selected source archive timed out.')),15000);
    zip.on('error',finish);
    zip.on('end',()=>selected?finish(null,selected):finish(Error('The archive lacks the Java source entry for the selected class.')));
    zip.on('entry',entry=>{
      const name=entry.fileName;
      if(++count>ENTRY_LIMIT||name.length>4096||name.split('/').some(part=>part==='..'||part==='.')||names.has(name)||
          ((entry.externalFileAttributes>>>16)&0xf000)===0xa000) {
        return finish(Error('The source archive contains linked, unsafe, duplicate or excessive ZIP entries.'));
      }
      names.add(name);
      if(!entries.includes(name))return zip.readEntry();
      if(selected||entry.uncompressedSize>SOURCE_LIMIT||entry.generalPurposeBitFlag&1) {
        return finish(Error('The archive contains ambiguous, encrypted or oversized Java source for the selected class.'));
      }
      zip.openReadStream(entry,(failure,stream)=>{
        if(failure)return finish(failure);
        const chunks=[];
        let length=0;
        stream.on('error',finish);
        stream.on('data',chunk=>{
          length+=chunk.length;
          if(length>SOURCE_LIMIT){stream.destroy();finish(Error('The Java source exceeded its byte limit.'));}
          else chunks.push(chunk);
        });
        stream.on('end',()=>{
          if(done)return;
          try {
            const bytes=Buffer.concat(chunks);
            if(bytes.length!==entry.uncompressedSize||crc32(bytes)!==entry.crc32)throw Error('The Java source archive checksum does not match.');
            const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
            if(!text.trim()||text.includes('\0'))throw Error('The selected Java source entry must be nonempty UTF-8 text.');
            selected={entry:name,text,sha256:digest(bytes)};
            zip.readEntry();
          }catch(error){finish(error);}
        });
      });
    });
    zip.readEntry();
  }));
}

async function inspectSourceArchive(file,entries) {
  const saved=await archiveFile(file);
  const source=await readSelectedSource(saved.file,entries);
  if((await archiveFile(saved.file)).identity!==saved.identity)throw Error('The source archive changed during review.');
  return {...saved,...source};
}

function attachment(response) {
  if(response?.errorMessage)throw Error(response.errorMessage);
  const record=response?.attributes;
  if(!record||typeof record.jarPath!=='string'||!path.isAbsolute(record.jarPath)||!/\.jar$/i.test(record.jarPath)) {
    throw Error('This Java library does not expose an editable JAR source attachment.');
  }
  return {binary:record.jarPath,source:record.sourceAttachmentPath||null,encoding:record.sourceAttachmentEncoding||null};
}

const contentMode=text=>/^\/\/ Source code is decompiled from a \.class file .*FernFlower/m.test(text.slice(0,512))?'decompiled':'source';

module.exports={libraryClass,archiveFile,inspectSourceArchive,attachment,contentMode,normalized,sameFile};
