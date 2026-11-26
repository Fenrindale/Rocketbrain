'use strict';

const {crc32}=require('node:zlib');
const yauzl=require('yauzl');
const {fail}=require('./workbench-model');

const archiveOptions={lazyEntries:true,autoClose:true,strictFileNames:true,validateEntrySizes:true};
const limit=512*1024*1024;

function visitArchive(source,invalid,visit) {
  return new Promise((resolve,reject)=>{
    const open=Buffer.isBuffer(source)?yauzl.fromBuffer:yauzl.open;
    open(source,archiveOptions,(error,zip)=>{
      if(error) return reject(invalid());
      const names=new Map();
      let expanded=0, settled=false;
      function refuse(reason) {
        if(settled) return;
        settled=true;
        zip.close();
        reject(reason?.code==='ROCKETBRAIN_JAVA_WORKBENCH'?reason:invalid());
      }
      zip.on('error',refuse);
      zip.on('entry',entry=>{
        const name=entry.fileName, key=name.replace(/\/$/u,'').toLowerCase();
        const mode=(entry.externalFileAttributes>>>16)&0xf000, directory=name.endsWith('/');
        expanded+=entry.uncompressedSize;
        if(!key||name.length>512||key.split('/').some(part=>!part||part==='.')||
            names.has(key)||names.size>=50000||expanded>limit||entry.uncompressedSize>limit/4||
            entry.generalPurposeBitFlag&1||![0,8].includes(entry.compressionMethod)||
            ![0,0x4000,0x8000].includes(mode)||mode===0x4000&&!directory||mode===0x8000&&directory||
            directory&&(entry.uncompressedSize!==0||entry.crc32!==0)){
          refuse();
          return;
        }
        names.set(key,directory);
        const read=maximum=>readEntry(zip,entry,maximum,invalid);
        Promise.resolve().then(()=>visit({name,key,directory,size:entry.uncompressedSize},read))
          .then(()=>{if(!settled) zip.readEntry();},refuse);
      });
      zip.on('end',()=>{
        if(settled) return;
        if(!names.size){refuse();return;}
        for(const name of names.keys()){
          for(let index=name.indexOf('/');index>=0;index=name.indexOf('/',index+1)){
            if(names.get(name.slice(0,index))===false){refuse();return;}
          }
        }
        settled=true;
        resolve();
      });
      zip.readEntry();
    });
  });
}

function readEntry(zip,entry,maximum,invalid) {
  if(entry.uncompressedSize>maximum) return Promise.reject(invalid());
  return new Promise((resolve,reject)=>{
    zip.openReadStream(entry,(error,stream)=>{
      if(error) return reject(invalid());
      const chunks=[];
      let size=0, crc=0;
      stream.on('error',()=>reject(invalid()));
      stream.on('data',chunk=>{
        size+=chunk.length;
        if(size>maximum||size>entry.uncompressedSize){
          stream.destroy(invalid());
          return;
        }
        chunks.push(chunk);
        crc=crc32(chunk,crc);
      });
      stream.on('end',()=>{
        if(size!==entry.uncompressedSize||crc!==entry.crc32) reject(invalid());
        else resolve(Buffer.concat(chunks,size));
      });
    });
  });
}

function inspectWar(source,{strictVendor=false,manifest}={}) {
  const invalid=()=>fail('Use a regular WAR without unsafe ZIP entries or a WildFly context override.');
  return visitArchive(source,invalid,({key},read)=>{
    if(key==='web-inf/jboss-web.xml'||strictVendor&&/^(?:web|meta)-inf\/jboss-[^/]+\.xml$/u.test(key)) throw invalid();
    if(manifest&&key==='meta-inf/manifest.mf') return manifest(read);
  });
}

module.exports={visitArchive,inspectWar};
