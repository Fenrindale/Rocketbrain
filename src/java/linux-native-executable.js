'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const {fail,inside}=require('./workbench-model');
const {validateJavaHome}=require('./testing/provision');

const machines={x64:62,arm64:183};
const maxImageBytes=512*1024*1024;
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mode===b.mode&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const samePath=(a,b)=>!path.relative(a,b);

function nativePlatform(framework) {
  if(process.platform!=='linux'||!Object.hasOwn(machines,process.arch))
    throw fail('Run the '+framework+' Native Image workbench in a Linux x64 or arm64 extension host.');
}

function nativeElfHeader(header,architecture) {
  if(!Buffer.isBuffer(header)||header.length<64||!Object.hasOwn(machines,architecture))return false;
  const kind=header.readUInt16LE(16);
  return header.readUInt32BE(0)===0x7f454c46&&header[4]===2&&header[5]===1&&header[6]===1&&
    (kind===2||kind===3)&&header.readUInt16LE(18)===machines[architecture]&&header.readUInt32LE(20)===1;
}

async function inspectImage(file,architecture,expected,framework,changed) {
  const initial=await fs.lstat(file,{bigint:true});
  if(!initial.isFile()||initial.isSymbolicLink()||!(initial.mode&0o111n)||initial.size<64n||
      initial.size>BigInt(maxImageBytes)||!samePath(await fs.realpath(file),file))throw changed();
  if(expected&&!sameFile(initial,expected.stat))throw changed();
  const handle=await fs.open(file,'r');
  try {
    const header=Buffer.alloc(64), read=await handle.read(header,0,header.length,0);
    if(read.bytesRead!==header.length||!nativeElfHeader(header,architecture)||!sameFile(initial,await handle.stat({bigint:true})))
      throw fail(framework+' did not produce an executable Linux ELF for this host architecture.');
    const hash=createHash('sha256');
    for await(const chunk of handle.createReadStream({start:0,autoClose:false}))hash.update(chunk);
    const sha256=hash.digest('hex');
    if(!sameFile(initial,await handle.stat({bigint:true}))||!sameFile(initial,await fs.lstat(file,{bigint:true}))||
       expected&&expected.sha256!==sha256)throw changed();
    return {stat:initial,sha256,size:Number(initial.size)};
  }finally{await handle.close();}
}

async function toolchain(home) {
  const validated=validateJavaHome(home), nativeImage=path.join(validated.javaHome,'bin','native-image');
  const actual=await fs.realpath(nativeImage).catch(()=>undefined);
  if(!actual||!inside(validated.javaHome,actual)||!/graalvm/iu.test(validated.release)||
      !((await fs.stat(actual)).mode&0o111))throw fail('Configure a physical GraalVM JDK 25 or newer with Native Image.');
  return {...validated,nativeImage:actual};
}

async function directory(folder,framework) {
  const stat=await fs.lstat(folder,{bigint:true});
  if(stat.isSymbolicLink()||!stat.isDirectory()||!samePath(await fs.realpath(folder),folder))
    throw fail('Use a physical '+framework+' native output directory inside the selected module.');
  return stat;
}

function ownProcess(program,args,{cwd,env,signal,log=()=>{}},framework) {
  const child=spawn(program,args,{cwd,env,detached:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let result,requested,tail='';
  const done=new Promise(resolve=>{
    child.once('error',error=>{result={error};resolve(result);});
    child.once('close',(code,childSignal)=>{result??={code,signal:childSignal};resolve(result);});
  });
  for(const stream of [child.stdout,child.stderr]){
    const decoder=new StringDecoder('utf8');
    stream.on('data',bytes=>{
      const text=decoder.write(bytes);
      tail=(tail+text).slice(-12000);
      try{log(text);}catch{}
    });
  }
  function stop(){
    if(requested)return requested;
    requested=(async()=>{
      if(!result&&child.pid&&child.exitCode===null&&child.signalCode===null){
        try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
        if(!await completedWithin(3000)&&child.exitCode===null&&child.signalCode===null){
          try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        }
      }
      if(!await completedWithin(8000))throw fail('The owned '+framework+' native process did not exit.');
    })();
    return requested;
  }
  async function completedWithin(ms){
    let timer;
    try{return await Promise.race([done.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}
    finally{clearTimeout(timer);}
  }
  const abort=()=>{void stop().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  void done.then(()=>signal?.removeEventListener('abort',abort));
  if(signal?.aborted)abort();
  return {child,done,stop,completedWithin,get ended(){return !!result;},get tail(){return tail;}};
}

module.exports={nativePlatform,nativeElfHeader,inspectImage,toolchain,directory,ownProcess};
