'use strict';
const crypto=require('node:crypto'),yauzl=require('yauzl');
const LIMITS=Object.freeze({metadataBytes:2*1024*1024,zipBytes:16*1024*1024,expandedBytes:64*1024*1024,fileBytes:4*1024*1024,entries:500,dependencies:50});
const fail=(code,message)=>Object.assign(Error(message),{code:'ROCKETBRAIN_SPRING_PROJECT_'+code});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function endpoint(value='https://start.spring.io/'){let url;try{url=new URL(value);}catch{throw fail('ENDPOINT','Choose a valid Initializr service URL.');}if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw fail('ENDPOINT','Use HTTPS, or an explicitly selected loopback HTTP Initializr fixture; URL credentials and redirects are not supported.');url.pathname=url.pathname.replace(/\/*$/,'/');return url;}
async function download(url,{accept,signal,maximum,fetchImpl=fetch}={}){const response=await fetchImpl(url,{headers:{Accept:accept},redirect:'manual',signal:signal||AbortSignal.timeout(60000)});if(!response.ok)throw fail('HTTP','Initializr returned HTTP '+response.status+'. No project files were written.');if(Number(response.headers.get('content-length'))>maximum)throw fail('SIZE','Initializr response exceeds its limit.');const chunks=[];let size=0;try{for await(const chunk of response.body){size+=chunk.length;if(size>maximum)throw fail('SIZE','Initializr response exceeds its limit.');chunks.push(Buffer.from(chunk));}}catch(error){await response.body?.cancel?.().catch(()=>{});throw error;}return Buffer.concat(chunks);}
function values(metadata,key){const rows=metadata[key]?.values;if(!Array.isArray(rows)||!rows.length||rows.length>500)throw fail('METADATA','Initializr metadata is missing supported '+key+' choices.');return rows;}
const SOURCE_LANGUAGES=new Set(['java','kotlin','groovy']);
const PACKAGING_TYPES=new Set(['jar','war']);
const CONFIGURATION_FORMATS=new Set(['properties','yaml']);

function advertised(rows,available){
 return rows.filter(row=>row&&available.has(row.id)).map(row=>({id:row.id,name:typeof row.name==='string'&&row.name.length<=80?row.name:row.id}));
}

class InitializrClient{
 constructor(value,{fetchImpl=fetch}={}){this.url=endpoint(value);this.fetchImpl=fetchImpl;}
 async json(relative,signal){const bytes=await download(new URL(relative,this.url),{accept:'application/vnd.initializr.v2.3+json',maximum:LIMITS.metadataBytes,signal,fetchImpl:this.fetchImpl});let result;try{result=JSON.parse(bytes.toString('utf8'));}catch{throw fail('METADATA','Initializr did not return valid JSON metadata.');}return{value:result,sha256:sha(bytes)};}
 async metadata({signal,bootVersion}={}){
  const root=await this.json('',signal),m=root.value;
  for(const key of ['type','bootVersion','javaVersion','language','packaging'])values(m,key);
  const selected=bootVersion||m.bootVersion.default;
  if(typeof selected!=='string'||!/^\d+\.\d+\.\d+(?:[.\-][A-Za-z0-9.\-]+)?$/.test(selected)||selected.length>80)
   throw fail('METADATA','Use an explicit supported Spring Boot version.');
  const catalog=await this.json('dependencies?bootVersion='+encodeURIComponent(selected),signal);
  if(catalog.value.bootVersion!==selected||!catalog.value.dependencies||Object.keys(catalog.value.dependencies).length>1000)
   throw fail('METADATA','Initializr resolved a different or invalid dependency catalog.');
  const configurationFormats=m.configurationFileFormat?advertised(values(m,'configurationFileFormat'),CONFIGURATION_FORMATS):[];
  const configurationFileFormat=configurationFormats.find(item=>item.id===m.configurationFileFormat?.default)?.id??configurationFormats[0]?.id;
  const languages=advertised(values(m,'language'),SOURCE_LANGUAGES),packaging=advertised(values(m,'packaging'),PACKAGING_TYPES);
  const flat=m.dependencies?.values?.flatMap(group=>(group.values||[]).map(item=>({...item,group:group.name})))||[];
  return {endpoint:this.url.toString(),metadataSha256:root.sha256,catalogSha256:catalog.sha256,bootVersion:selected,
   defaults:{type:m.type.default,javaVersion:m.javaVersion.default,language:m.language.default,packaging:m.packaging.default,
    ...(configurationFileFormat?{configurationFileFormat}:{}),groupId:m.groupId?.default||'com.example',artifactId:m.artifactId?.default||'demo',
    name:m.name?.default||'demo',description:m.description?.default||'Demo project',packageName:m.packageName?.default||'com.example.demo',version:m.version?.default||'0.0.1-SNAPSHOT'},
   types:values(m,'type').filter(t=>['maven-project','gradle-project','gradle-project-kotlin'].includes(t.id)&&t.action==='/starter.zip'),
   bootVersions:values(m,'bootVersion'),javaVersions:values(m,'javaVersion'),languages,packaging,configurationFormats,
   dependencies:flat.filter(d=>Object.hasOwn(catalog.value.dependencies,d.id)).map(d=>({id:d.id,name:d.name,description:d.description||'',group:d.group,...catalog.value.dependencies[d.id]}))};
 }
 async archive(selection,metadata,{signal}={}){
  const s={...metadata.defaults,...selection};
  const choices=[['type',metadata.types],['bootVersion',metadata.bootVersions],['javaVersion',metadata.javaVersions],
   ['language',metadata.languages],['packaging',metadata.packaging]];
  for(const [key,rows] of choices)
   if(!rows.some(value=>value.id===s[key]))throw fail('CHOICE','Select a supported advertised '+key+' value.');
  if(s.bootVersion!==metadata.bootVersion)throw fail('CHOICE','Load the advertised catalog for the selected Spring Boot version.');
  if(s.configurationFileFormat!==undefined&&!metadata.configurationFormats.some(item=>item.id===s.configurationFileFormat))
   throw fail('CHOICE','Select a supported advertised configuration file format.');
  for(const key of ['groupId','packageName'])
   if(typeof s[key]!=='string'||s[key].length>180||!s[key].split('.').every(part=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)))
    throw fail('CHOICE','Use a literal JVM '+key+'.');
  if(!/^[a-z][a-z0-9-]{0,62}$/.test(s.artifactId)||!/^[A-Za-z0-9_.\-]{1,80}$/.test(s.version))
   throw fail('CHOICE','Use a simple artifact identifier and project version.');
  for(const key of ['name','description'])
   if(typeof s[key]!=='string'||s[key].length>240||/[\u0000-\u001f\u007f]/.test(s[key]))
    throw fail('CHOICE','Use bounded single-line project text.');
  if(!Array.isArray(s.dependencies)||s.dependencies.length>LIMITS.dependencies||new Set(s.dependencies).size!==s.dependencies.length||
     s.dependencies.some(id=>!metadata.dependencies.some(d=>d.id===id)))
   throw fail('CHOICE','Select compatible unique dependency identifiers.');
  const url=new URL('starter.zip',this.url);
  const known=['type','bootVersion','javaVersion','language','packaging','groupId','artifactId','version','name','description','packageName'];
  for(const key of known)url.searchParams.set(key,s[key]);
  if(s.configurationFileFormat!==undefined)url.searchParams.set('configurationFileFormat',s.configurationFileFormat);
  url.searchParams.set('dependencies',s.dependencies.join(','));
  url.searchParams.set('baseDir','');
  const bytes=await download(url,{accept:'application/zip',maximum:LIMITS.zipBytes,signal,fetchImpl:this.fetchImpl});
  return {bytes,selection:Object.fromEntries([...known,'configurationFileFormat','dependencies'].filter(key=>s[key]!==undefined).map(key=>[key,s[key]])),
   requestUrl:url.toString(),sha256:sha(bytes)};
 }
}

function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
function safeEntry(name){if(typeof name!=='string'||name.length>240||!name||name.startsWith('/')||name.includes('\\')||/[^A-Za-z0-9_./ -]/.test(name))throw fail('ARCHIVE','Unsafe archive path.');const directory=name.endsWith('/'),parts=name.replace(/\/$/,'').split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))||['.git','.vscode','.idea'].includes(parts[0].toLowerCase()))throw fail('ARCHIVE','Reserved or unsafe archive path.');return{path:parts.join('/'),directory};}
async function unpack(bytes){return new Promise((resolve,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{if(error)return reject(fail('ARCHIVE','The generator did not return a valid ZIP archive.'));const entries=[],names=new Set();let total=0,count=0,done=false;const bad=error=>{if(!done){done=true;zip.close();reject(error?.code?.startsWith('ROCKETBRAIN_')?error:fail('ARCHIVE','Corrupt or unsupported project archive.'));}};zip.on('error',bad);zip.on('entry',entry=>{try{const item=safeEntry(entry.fileName),mode=(entry.externalFileAttributes>>>16)&0xf000;if(++count>LIMITS.entries||names.has(item.path.toLowerCase())||entry.generalPurposeBitFlag&1||![0,8].includes(entry.compressionMethod)||![0,0x8000,0x4000].includes(mode)||mode===0x4000&&!item.directory||mode===0x8000&&item.directory)throw fail('ARCHIVE','Duplicate, encrypted, symbolic or excessive project entries.');names.add(item.path.toLowerCase());total+=entry.uncompressedSize;if(total>LIMITS.expandedBytes||entry.uncompressedSize>LIMITS.fileBytes)throw fail('ARCHIVE','Expanded project exceeds its byte limit.');if(item.directory){if(entry.uncompressedSize!==0||entry.crc32!==0)throw fail('ARCHIVE','Directory entries must contain no payload.');entries.push(item);zip.readEntry();return;}zip.openReadStream(entry,(error,stream)=>{if(error)return bad(error);const chunks=[];let length=0;stream.on('error',bad);stream.on('data',chunk=>{length+=chunk.length;if(length>LIMITS.fileBytes){stream.destroy();bad(fail('ARCHIVE','A generated file exceeds its bound.'));}else chunks.push(chunk);});stream.on('end',()=>{if(done)return;const data=Buffer.concat(chunks);if(data.length!==entry.uncompressedSize||crc32(data)!==entry.crc32)return bad(fail('ARCHIVE','Project ZIP CRC or length mismatch.'));entries.push({...item,bytes:data,sha256:sha(data),executable:Boolean((entry.externalFileAttributes>>>16)&0o111)});zip.readEntry();});});}catch(error){bad(error);}});zip.on('end',()=>{if(done)return;try{const files=entries.filter(e=>!e.directory);if(!files.length)throw fail('ARCHIVE','The project archive is empty.');for(const item of entries){const p=item.path.split('/');for(let i=1;i<p.length;i++)if(files.some(f=>f.path.toLowerCase()===p.slice(0,i).join('/').toLowerCase()))throw fail('ARCHIVE','An archive file is also a parent directory.');}done=true;resolve(entries);}catch(error){bad(error);}});zip.readEntry();}));}
module.exports={InitializrClient,LIMITS,endpoint,unpack,safeEntry,sha,fail};
