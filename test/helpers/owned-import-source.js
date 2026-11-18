'use strict';
// Test fixtures only: finish a known-byte producer before its first source
// review. This never invokes, catches, retries or changes an import operation.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const QUIET_MS=1000,POLL_MS=50,TIMEOUT_MS=5000,MAX_BYTES=1024**3;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const identity=stat=>({size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs),ino:String(stat.ino),dev:String(stat.dev)});
async function writeOwnedImportSource(file,content,{ownedDirectory}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||typeof ownedDirectory!=='string'||!path.isAbsolute(ownedDirectory)||!['string','object'].includes(typeof content)||typeof content==='object'&&!Buffer.isBuffer(content))throw Error('Use a known string/Buffer and an explicitly owned import fixture directory.');
 const folder=path.resolve(ownedDirectory),name=path.basename(folder),temporary=fs.realpathSync(os.tmpdir()),native=path.resolve(__dirname,'../../test-output'),parent=fs.realpathSync(path.dirname(folder)),stat=fs.lstatSync(folder);
 const ownedTemp=path.relative(temporary,parent)===''&&/^rocketbrain-stream-(?:source|db)-[A-Za-z0-9]+$/.test(name),ownedNative=path.relative(native,parent)===''&&/^stream-import-native-[a-f0-9-]{36}$/.test(name);
 if(!ownedTemp&&!ownedNative||!stat.isDirectory()||stat.isSymbolicLink()||path.relative(folder,fs.realpathSync(folder))!==''||path.relative(folder,path.dirname(path.resolve(file)))!==''||!/^[A-Za-z0-9_.-]+\.(?:csv|tsv|xlsx)$/.test(path.basename(file)))throw Error('Only a directly owned generated CSV/TSV/XLSX fixture file may use producer readiness.');
 if(fs.existsSync(file)){const existing=fs.lstatSync(file);if(!existing.isFile()||existing.isSymbolicLink())throw Error('The generated import fixture must be an ordinary file.');}
 const bytes=Buffer.isBuffer(content)?Buffer.from(content):Buffer.from(content,'utf8');if(bytes.length>MAX_BYTES)throw Error('The owned fixture exceeds the import source limit.');const expectedHash=hash(bytes);
 await fs.promises.writeFile(file,bytes);
 const started=process.hrtime.bigint(),elapsed=()=>Number(process.hrtime.bigint()-started)/1e6,initial=await fs.promises.readFile(file);if(hash(initial)!==expectedHash)throw Error('The owned producer bytes changed before metadata readiness.');let previous,quietSince=elapsed(),samples=0,transitions=0;
 while(elapsed()<TIMEOUT_MS){const currentStat=await fs.promises.stat(file,{bigint:true});if(!currentStat.isFile()||currentStat.size!==BigInt(bytes.length))throw Error('The owned import source identity or size changed during producer readiness.');const current=identity(currentStat),at=elapsed();samples++;if(!previous||!same(previous,current)){if(previous)transitions++;quietSince=at;}previous=current;
  if(at-quietSince>=QUIET_MS){const actualHash=hash(await fs.promises.readFile(file)),after=identity(await fs.promises.stat(file,{bigint:true}));if(actualHash!==expectedHash)throw Error('The known owned import source bytes changed during producer readiness.');if(same(current,after))return{file,bytes:bytes.length,sha256:expectedHash,identity:after,quietMs:at-quietSince,elapsedMs:elapsed(),samples,metadataTransitions:transitions,scanInvocations:0};previous=after;quietSince=elapsed();transitions++;}
  await wait(Math.min(POLL_MS,Math.max(1,TIMEOUT_MS-elapsed())));
 }
 throw Error('The owned import producer metadata did not remain unchanged for1second within5seconds.');
}
module.exports={writeOwnedImportSource};
