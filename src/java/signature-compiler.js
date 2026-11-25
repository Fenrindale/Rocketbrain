'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),yauzl=require('yauzl');
const helpers=require('./signature-compiler-sources.json');
const {structuralQuery}=require('./structural-search');
const {validIdentifier}=require('./file-templates');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const plugin=/^(?:META-INF\/versions\/[^/]+\/)?META-INF\/services\/com\.sun\.source\.util\.Plugin$/i;
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(buffer){let crc=0xffffffff;for(const n of buffer)crc=crcTable[(crc^n)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
async function visitJar(file,visit){return new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true},(error,zip)=>{if(error)return reject(error);let done=false,seen=0,total=0;const names=new Set(),fail=error=>{if(!done){done=true;zip.close();reject(error);}};zip.on('error',fail);zip.on('entry',entry=>{const name=entry.fileName;if(++seen>100000||entry.uncompressedSize>64*1024*1024||(total+=entry.uncompressedSize)>512*1024*1024)return fail(Error('Compiler JAR exceeds its bounded metadata or uncompressed size limit.'));if(name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').some(part=>part==='..')||names.has(name.toLowerCase())||((entry.externalFileAttributes>>>16)&0xf000)===0xa000)return fail(Error('Compiler JAR contains duplicate, linked or unsafe entry paths.'));names.add(name.toLowerCase());if(plugin.test(name))return fail(Error('Compiler plugin providers are not allowed during signature inspection.'));const read=()=>new Promise((resolveRead,rejectRead)=>zip.openReadStream(entry,(error,stream)=>{if(error)return rejectRead(error);const chunks=[];let size=0;stream.on('error',rejectRead);stream.on('data',b=>{size+=b.length;if(size>entry.uncompressedSize||size>64*1024*1024){stream.destroy();rejectRead(Error('Compiler JAR entry exceeds its bounded size.'));}else chunks.push(b);});stream.on('end',()=>{const buffer=Buffer.concat(chunks);if(buffer.length!==entry.uncompressedSize||crc32(buffer)!==entry.crc32)return rejectRead(Error('Compiler JAR entry CRC or length is invalid.'));resolveRead(buffer);});}));Promise.resolve(visit(entry,read)).then(()=>{if(!done)zip.readEntry();},fail);});zip.on('end',()=>{if(!done){done=true;resolve();}});zip.readEntry();}));}
async function inspectCompilerJar(file,manifestLimit=65536){
 if(!Number.isSafeInteger(manifestLimit)||manifestLimit<65536||manifestLimit>256*1024)throw Error('Invalid compiler JAR manifest limit.');
 let sanitized=false;
 await visitJar(file,async(entry,read)=>{
  if(/^META-INF\/INDEX\.LIST$/i.test(entry.fileName))sanitized=true;
  if(/^META-INF\/MANIFEST\.MF$/i.test(entry.fileName)){
   // Signed archives can have thousands of per-entry digests. The JAR classpath is a main-section attribute.
   if(entry.uncompressedSize>4*1024*1024)throw Error('Compiler JAR manifest exceeds its archive limit.');
   const manifest=(await read()).toString('utf8').replace(/\r\n?/g,'\n');
   const separator=manifest.indexOf('\n\n');
   const main=separator===-1?manifest:manifest.slice(0,separator);
   if(Buffer.byteLength(main)>manifestLimit)throw Error('Compiler JAR manifest exceeds its metadata limit.');
   if(/^Class-Path\s*:\s*\S/mi.test(main.replace(/\n /g,'')))sanitized=true;
  }
 });
 return {sanitized};
}
// Canonical stored ZIPs contain the original class bytes. Only indirect-path
// metadata is removed; project JARs are never rewritten or loaded by the JVM.
async function sanitizeCompilerJar(file,target){const locals=[],central=[];let position=0,count=0;await visitJar(file,async(entry,read)=>{if(/^META-INF\/INDEX\.LIST$/i.test(entry.fileName))return;let data=await read();if(/^META-INF\/MANIFEST\.MF$/i.test(entry.fileName)){const lines=data.toString('utf8').split(/\r?\n/),kept=[];let dropping=false;for(const line of lines){if(line.startsWith(' ')){if(!dropping)kept.push(line);}else{dropping=/^Class-Path\s*:/i.test(line);if(!dropping)kept.push(line);}}data=Buffer.from(kept.join('\r\n'));}const name=Buffer.from(entry.fileName),crc=crc32(data),local=Buffer.alloc(30),directory=Buffer.alloc(46);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(position,42);locals.push(local,name,data);central.push(directory,name);position+=local.length+name.length+data.length;count++;});if(count>65535||position>512*1024*1024)throw Error('Sanitized compiler JAR exceeds the canonical ZIP limit.');const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(position,16);fs.writeFileSync(target,Buffer.concat([...locals,index,end]));}
function snapshotClasspath(javaHome,classpath){
 const files=[],entries=[],directories=[];let size=0,count=0;function capture(file){if(++count>10000)throw Error('Compiler classpath snapshot exceeds its file limit.');const stat=fs.statSync(file);size+=stat.size;if(size>256*1024*1024)throw Error('Compiler classpath snapshot exceeds256MiB.');files.push({file,bytes:stat.size,hash:hash(fs.readFileSync(file))});}
 for(const candidate of [path.join(javaHome,'release'),path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java')])capture(candidate);
 function inventory(file,capturing){let visited=0;const found=[];function walk(dir,depth=0){if(depth>40)throw Error('Compiler classpath directory is too deep.');for(const name of fs.readdirSync(dir).sort()){if(++visited>20000)throw Error('Compiler classpath directory exceeds its entry limit.');const item=path.join(dir,name),s=fs.lstatSync(item),relative=path.relative(file,item).replaceAll('\\','/');if(s.isSymbolicLink())throw Error('Compiler classpath links need an explicit review.');if(plugin.test(relative))throw Error('Compiler plugin providers are not allowed during signature inspection.');if(s.isDirectory())walk(item,depth+1);else if(s.isFile()&&/\.class$/i.test(name)){found.push(relative);if(capturing)capture(item);}}}walk(file);return JSON.stringify(found);}
 for(const input of classpath){if(typeof input!=='string'||/[\r\n\0]/.test(input)||!path.isAbsolute(input))throw Error('Use observed absolute local compiler classpaths.');const file=fs.realpathSync(input),stat=fs.statSync(file);entries.push(file);if(stat.isDirectory())directories.push({file,membership:inventory(file,true)});else if(stat.isFile()&&file.toLowerCase().endsWith('.jar'))capture(file);else throw Error('Compiler classpaths must be local class directories or JARs.');}
 const key=hash(JSON.stringify({files,directories}));return {entries,files,key,validate(){for(const dir of directories)if(inventory(dir.file,false)!==dir.membership)throw Error('Compiler classpath file membership changed after inspection.');for(const saved of files){const stat=fs.statSync(saved.file);if(stat.size!==saved.bytes||hash(fs.readFileSync(saved.file))!==saved.hash)throw Error('A compiler runtime or classpath changed after signature inspection.');}}};
}
async function analyzeJavaSources({javaHome,classpath=[],sources,release=25,storagePath,cancellation,namedModule=false,manifestLimit,inspection}={}){
 if(cancellation?.isCancellationRequested)throw Error('Compiler inspection cancelled.');if(!javaHome||!fs.existsSync(javaHome))throw Error('An independent full JDK25+ is required for inheritance and overload inspection.');javaHome=fs.realpathSync(javaHome);const descriptor=fs.readFileSync(path.join(javaHome,'release'),'utf8');if(/JetBrains|JBR/i.test(descriptor)||Number(/JAVA_VERSION="(\d+)/.exec(descriptor)?.[1])<25||!fs.existsSync(path.join(javaHome,'bin',process.platform==='win32'?'javac.exe':'javac')))throw Error('Use an independent full JDK25+ for compiler inspection.');if(!Number.isInteger(release)||release<8||release>Number(/JAVA_VERSION="(\d+)/.exec(descriptor)?.[1]))throw Error('The observed Java language release is not supported by the compiler runtime.');
 if(!Array.isArray(sources)||!sources.length||sources.length>500||sources.some(s=>typeof s.uri!=='string'||!s.uri.startsWith('file:')||/[\r\n\t]/.test(s.uri)||typeof s.text!=='string'))throw Error('Compiler inspection requires bounded plain Java source units.');
 const query=[];
 if(inspection){
  if(['diagram','check','hierarchy'].includes(inspection.kind))query.push(inspection.kind);
  else if(inspection.kind==='conversion'&&sources.some(item=>item.uri===inspection.uri))query.push('conversion',inspection.uri);
  else if(inspection.kind==='cleanup'&&['plan','verify'].includes(inspection.stage)&&
    sources.some(item=>item.uri===inspection.uri))query.push('cleanup',inspection.uri,inspection.stage);
  else if(inspection.kind==='constant'&&Number.isSafeInteger(inspection.start)&&Number.isSafeInteger(inspection.end)&&inspection.start>=0&&
    inspection.end>inspection.start&&inspection.end-inspection.start<=4096&&sources.some(item=>item.uri===inspection.uri&&inspection.end<=item.text.length)&&
    (inspection.name===undefined||validIdentifier(inspection.name)))query.push('constant',inspection.uri,String(inspection.start),String(inspection.end),inspection.name||'');
  else if(inspection.kind==='extraction'&&['local','field'].includes(inspection.extractionKind)&&Number.isSafeInteger(inspection.offset)&&
    inspection.offset>=0&&validIdentifier(inspection.name)&&sources.some(item=>item.uri===inspection.uri&&inspection.offset+inspection.name.length<=item.text.length)){
    query.push('extraction',inspection.uri,inspection.extractionKind,String(inspection.offset),inspection.name);
  }
  else if(inspection.kind==='methodInline'&&Number.isSafeInteger(inspection.start)&&Number.isSafeInteger(inspection.end)&&inspection.start>=0&&
    inspection.end>=inspection.start&&inspection.end-inspection.start<=32768&&Number.isInteger(inspection.argumentCount)&&
    inspection.argumentCount>=-1&&inspection.argumentCount<=16&&['static','this','new'].includes(inspection.receiverKind??'static')&&
    sources.some(item=>item.uri===inspection.uri&&inspection.end<=item.text.length)){
    query.push('methodInline',inspection.uri,String(inspection.start),String(inspection.end),String(inspection.argumentCount),inspection.receiverKind??'static');
  }
  else if(inspection.kind==='methodExtract'&&Number.isSafeInteger(inspection.start)&&Number.isSafeInteger(inspection.end)&&
    inspection.start>=0&&inspection.end>inspection.start&&inspection.end-inspection.start<=32768&&validIdentifier(inspection.name)&&
    Number.isSafeInteger(inspection.callOffset)&&inspection.callOffset>=-1&&sources.some(item=>item.uri===inspection.uri&&
      inspection.end<=item.text.length&&inspection.callOffset<item.text.length)){
    query.push('methodExtract',inspection.uri,String(inspection.start),String(inspection.end),inspection.name,String(inspection.callOffset));
  }
  else if(['typeImport','staticImport'].includes(inspection.kind)&&typeof inspection.fqn==='string'&&inspection.fqn.length<1024&&
    inspection.fqn.includes('.')&&inspection.fqn.split('.').every(validIdentifier)&&Number.isSafeInteger(inspection.start)&&
    Number.isSafeInteger(inspection.end)&&inspection.start>=0&&inspection.end>inspection.start&&
    sources.some(item=>item.uri===inspection.uri&&inspection.end<=item.text.length)){
    query.push(inspection.kind,inspection.uri,String(inspection.start),String(inspection.end),inspection.fqn);
  }
  else if(inspection.kind==='dataflow'&&Number.isSafeInteger(inspection.offset)&&inspection.offset>=0&&
    sources.some(item=>item.uri===inspection.uri&&inspection.offset<item.text.length))query.push('dataflow',inspection.uri,String(inspection.offset));
  else if(inspection.kind==='typeStructure'&&['inherited','nested'].includes(inspection.group)&&Number.isSafeInteger(inspection.offset)&&
    inspection.offset>=0&&sources.some(item=>item.uri===inspection.uri&&inspection.offset<=item.text.length)){
    query.push('typeStructure',inspection.uri,String(inspection.offset),inspection.group);
  }
  else if(inspection.kind==='structural'&&(inspection.uri===undefined||sources.some(item=>item.uri===inspection.uri))){
    const {mode,pattern,replacement,constraints}=structuralQuery(inspection);
    const encode=text=>Buffer.from(text,'utf8').toString('base64');
    query.push('structural',mode,encode(pattern),replacement===undefined?'':encode(replacement),inspection.uri||'',
      ...constraints.flatMap(({name,type,relation})=>[name,type,relation]));
    if(query.reduce((length,item)=>length+item.length+1,0)>27000)throw Error('Java structural templates exceed their encoded size limit.');
  }
  else throw Error('Use a supported compiler analysis mode and source offset.');
 }
 const descriptors=sources.filter(source=>source.uri.toLowerCase().endsWith('/module-info.java'));
 if(namedModule!==true&&descriptors.length||namedModule===true&&(descriptors.length!==1||!Array.isArray(classpath)||classpath.length||release<9))throw Error('Compiler module inspection requires one reviewed module descriptor and no additional dependencies.');
 if(sources.reduce((n,s)=>n+Buffer.byteLength(s.text),0)>8*1024*1024)throw Error('Compiler source inspection exceeds8MiB.');if(!Array.isArray(classpath)||classpath.length>250)throw Error('Compiler classpath entry limit exceeded.');const snapshot=snapshotClasspath(javaHome,classpath),jarMetadata=new Map();for(const entry of snapshot.entries)if(entry.toLowerCase().endsWith('.jar'))jarMetadata.set(entry,await inspectCompilerJar(entry,manifestLimit));snapshot.validate();
 const preferred=path.resolve(storagePath||os.tmpdir());
 // Allow room for the random directory and Java helper paths under long VS Code Windows profiles.
 const parent=process.platform==='win32'&&preferred.length>180?os.tmpdir():preferred;
 fs.mkdirSync(parent,{recursive:true});
 const parentReal=fs.realpathSync(parent),folder=fs.mkdtempSync(path.join(parentReal,'rb-compiler-'));
 const kind='RocketbrainSignatureCompiler-v20',id=crypto.randomUUID();
 const markerFile=path.join(folder,'owner.json');
 fs.writeFileSync(markerFile,JSON.stringify({kind,id}),{flag:'wx'});
 const source=path.join(folder,'rocketbrain','signature','SignatureInspector.java');
 const list=path.join(folder,'sources.tsv'),cp=path.join(folder,'classpath.txt'),empty=path.join(folder,'empty-providers');
 const env={...process.env};for(const name of Object.keys(env))if(['JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS','CLASSPATH','JAVA_OPTIONS'].includes(name.toUpperCase()))delete env[name];let exited=false,child,exit;
 try{
  fs.mkdirSync(empty);
  fs.mkdirSync(path.dirname(source),{recursive:true});
  for(const [name,text]of Object.entries(helpers))fs.writeFileSync(path.join(path.dirname(source),name),text);
  fs.writeFileSync(list,sources.map(s=>s.uri+'\t'+Buffer.from(s.text).toString('base64')).join('\n'));
  const effective=[];for(const [index,entry]of snapshot.entries.entries()){if(jarMetadata.get(entry)?.sanitized){const output=path.join(folder,'classpath-'+index+'.jar');await sanitizeCompilerJar(entry,output);effective.push(output);}else effective.push(entry);}fs.writeFileSync(cp,effective.join(path.delimiter));snapshot.validate();
  const output=await new Promise((resolve,reject)=>{const stdout=[];let total=0,stderr='',timer,cancel,settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);cancel?.dispose();error?reject(error):resolve(value);};child=spawn(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'),['--source','25',source,cp,list,empty,String(release),...query],{cwd:folder,env,windowsHide:true,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code)=>{exited=true;r(code);}));child.stdout.on('data',b=>{total+=b.length;if(total>8*1024*1024){child.kill();finish(Error('Compiler result exceeds its size limit.'));}else stdout.push(b);});child.stderr.on('data',b=>{stderr=(stderr+b.toString('utf8')).slice(-8000);});child.once('error',e=>{exited=true;finish(e);});child.once('close',code=>code===0?finish(null,Buffer.concat(stdout).toString('utf8')):finish(Error('Read-only Java compiler inspection failed: '+stderr)));timer=setTimeout(()=>{child.kill();finish(Error('Java compiler inspection timed out.'));},45000);cancel=cancellation?.onCancellationRequested?.(()=>{child.kill();finish(Error('Compiler inspection cancelled.'));});if(cancellation?.isCancellationRequested){child.kill();finish(Error('Compiler inspection cancelled.'));}});
  if(cancellation?.isCancellationRequested)throw Error('Compiler inspection cancelled.');snapshot.validate();const report=JSON.parse(output);if(report.format!=='RocketbrainSignatureCompiler-v20'||report.processorsEnabled!==false||report.classGenerationEnabled!==false)throw Error('Invalid read-only compiler response.');return {...report,classpathFingerprint:snapshot.key,validateClasspath:()=>snapshot.validate()};
 }finally{
  if(child&&!exited){child.kill();await Promise.race([exit,new Promise(r=>setTimeout(r,5000))]);}
  if(!child||exited){const marker=JSON.parse(fs.readFileSync(markerFile,'utf8'));if(marker.kind!==kind||marker.id!==id||path.dirname(fs.realpathSync(folder))!==parentReal)throw Error('Compiler inspection cleanup ownership changed.');fs.rmSync(folder,{recursive:true,force:false});}
 }
}
module.exports={analyzeJavaSources,inspectCompilerJar,snapshotClasspath,sanitizeCompilerJar,visitJar,crc32};
