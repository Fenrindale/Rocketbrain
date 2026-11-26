'use strict';

const {createHash}=require('node:crypto');
const {SaxesParser}=require('saxes');
const {visitArchive,inspectWar}=require('./jakarta-archive');
const {fail}=require('./workbench-model');
const {contextPattern}=require('./jakarta-war');

const ns='https://jakarta.ee/xml/ns/jakartaee';
const schema='http://www.w3.org/2001/XMLSchema-instance';
const application='META-INF/application.xml';
const moduleName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:war|jar)$/u;
const libraryName=/^lib\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jar$/u;
const applicationName=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const descriptorBytes=32*1024;
const moduleBytes=96*1024*1024;
const hierarchy={
  application:new Set(['application-name','display-name','description','initialize-in-order','module','library-directory']),
  module:new Set(['web','ejb']),
  web:new Set(['web-uri','context-root'])
};
const invalid=()=>fail('Use a bounded Maven EAR with one Jakarta WAR, one EJB JAR and one explicit context in META-INF/application.xml.');

function parseApplication(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!text.trim()||Buffer.byteLength(text)>descriptorBytes) throw invalid();
  const stack=[];
  let descriptor, nodes=0;
  const parser=new SaxesParser({xmlns:true});
  parser.on('doctype',()=>{throw invalid();});
  parser.on('processinginstruction',()=>{throw invalid();});
  parser.on('opentag',tag=>{
    const parent=stack.at(-1), name=tag.local;
    if(++nodes>32||tag.uri!==ns||(parent?!hierarchy[parent.name]?.has(name):name!=='application')) throw invalid();
    const entry={name,text:'',children:[]};
    for(const attribute of Object.values(tag.attributes)){
      if(attribute.uri==='http://www.w3.org/2000/xmlns/') continue;
      if(!parent&&attribute.uri===''&&attribute.local==='version'&&['9','10','11'].includes(attribute.value)){
        entry.version=attribute.value;
        continue;
      }
      if(!parent&&attribute.uri===schema&&attribute.local==='schemaLocation'&&attribute.value.length<=500){
        entry.schemaLocation=attribute.value.trim().replace(/\s+/gu,' ');
        continue;
      }
      if(name==='module'&&attribute.uri===''&&attribute.local==='id'&&applicationName.test(attribute.value)) continue;
      throw invalid();
    }
    if(parent) parent.children.push(entry);
    stack.push(entry);
  });
  const append=value=>{if(stack.length) stack.at(-1).text+=value;};
  parser.on('text',append);
  parser.on('cdata',append);
  parser.on('closetag',()=>{
    const current=stack.pop();
    if(!stack.length) descriptor=current;
  });
  try{parser.write(text).close();}catch{throw invalid();}
  if(!descriptor?.version||descriptor.text.trim()||
      descriptor.schemaLocation!==undefined&&descriptor.schemaLocation!==ns+' '+ns+'/application_'+descriptor.version+'.xsd'){
    throw invalid();
  }
  const modules=[], metadata=new Map();
  for(const item of descriptor.children){
    if(item.name==='module') modules.push(item);
    else{
      if(metadata.has(item.name)||item.children.length||item.text.length>1024) throw invalid();
      metadata.set(item.name,item.text.trim());
    }
  }
  const order=metadata.get('initialize-in-order'), name=metadata.get('application-name');
  if(modules.length!==2||name!==undefined&&!applicationName.test(name)||
      order!==undefined&&!['true','false'].includes(order)||
      metadata.has('library-directory')&&metadata.get('library-directory')!=='lib') throw invalid();
  let war, ejb, context;
  for(const module of modules){
    if(module.children.length!==1||module.text.trim()) throw invalid();
    const type=module.children[0];
    if(type.name==='ejb'){
      if(ejb||type.children.length) throw invalid();
      ejb=type.text.trim();
    }else{
      if(war||type.children.length!==2||type.text.trim()||
          new Set(type.children.map(child=>child.name)).size!==2) throw invalid();
      war=type.children.find(child=>child.name==='web-uri').text.trim();
      const root=type.children.find(child=>child.name==='context-root').text.trim();
      if(!root.startsWith('/')||!contextPattern.test(root.slice(1))) throw invalid();
      context=root.slice(1);
    }
  }
  if(!moduleName.test(war||'')||!moduleName.test(ejb||'')||!war.endsWith('.war')||!ejb.endsWith('.jar')||
      war.slice(0,-4).toLowerCase()===ejb.slice(0,-4).toLowerCase()) throw invalid();
  return {descriptorVersion:descriptor.version,context,war,ejb,...(name&&{applicationName:name})};
}

function moduleReceipt(name,bytes){
  return {name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}

async function manifestPaths(read,references){
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await read(descriptorBytes));
  if(text.startsWith('\uFEFF')) throw invalid();
  const lines=text.replace(/(?:\r\n|\r|\n) /gu,'').split(/\r\n|\r|\n/u);
  for(const line of lines){
    if(/^dependencies:/iu.test(line)) throw invalid();
    if(!/^class-path:/iu.test(line)) continue;
    for(const item of line.slice(11).trim().split(/ +/u).filter(Boolean)){
      if(references.size>=128||!libraryName.test(item)&&!moduleName.test(item)) throw invalid();
      references.add(item);
    }
  }
}

function validMetadata(name){
  return /^META-INF\/(?:MANIFEST\.MF|LICENSE(?:\.txt)?|NOTICE(?:\.txt)?|maven\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pom\.(?:xml|properties))$/u
    .test(name);
}

async function inspectEar(file) {
  let descriptor;
  const modules=new Map(), libraries=new Set(), references=new Set();
  const readManifest=read=>manifestPaths(read,references);
  await visitArchive(file,invalid,async (entry,read)=>{
    const {name,directory}=entry;
    if(directory) {
      if(!/^(?:lib|META-INF(?:\/maven(?:\/[A-Za-z0-9._-]+){0,2})?)\/$/u.test(name)) throw invalid();
      return;
    }
    if(name===application) {
      descriptor=parseApplication(await read(descriptorBytes));
    }else if(moduleName.test(name)) {
      if(modules.size>=2) throw invalid();
      const bytes=await read(moduleBytes);
      if(name.endsWith('.war')) {
        try{await inspectWar(bytes,{strictVendor:true,manifest:readManifest});}catch{throw invalid();}
      }else{
        await visitArchive(bytes,invalid,({key},readModule)=>{
          if(/^meta-inf\/jboss-[^/]+\.xml$/u.test(key)||key==='meta-inf/ra.xml') throw invalid();
          if(key==='meta-inf/manifest.mf') return readManifest(readModule);
        });
      }
      modules.set(name,moduleReceipt(name,bytes));
    }else if(libraryName.test(name)){
      if(libraries.size>=64) throw invalid();
      await visitArchive(await read(moduleBytes),invalid,()=>{});
      libraries.add(name);
    }else if(name==='META-INF/MANIFEST.MF') await readManifest(read);
    else if(!validMetadata(name)) throw invalid();
  });
  if(!descriptor||modules.size!==2||!modules.has(descriptor.war)||!modules.has(descriptor.ejb)||
      [...references].some(file=>!modules.has(file)&&!libraries.has(file))) throw invalid();
  const {war,ejb,...overview}=descriptor;
  return {...overview,web:modules.get(war),ejb:modules.get(ejb),libraries:[...libraries].sort()};
}

module.exports={inspectEar,parseApplication};
