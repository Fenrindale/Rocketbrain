'use strict';

const { SaxesParser }=require('saxes');
const { fail }=require('./project-client');
const { tokens }=require('./project-build');

const builds={'maven-project':'pom.xml','gradle-project':'build.gradle','gradle-project-kotlin':'build.gradle.kts'};
const extensions={java:'.java',kotlin:'.kt',groovy:'.groovy'};
const formats={properties:['application.properties'],yaml:['application.yaml','application.yml']};

function mavenPackaging(text){
 if(/<!DOCTYPE|<!ENTITY/i.test(text))return null;
 const parser=new SaxesParser(),stack=[],found=[];
 let project=false;
 parser.on('opentag',tag=>{
  if(stack.length===0)project=tag.name==="project";
  stack.push(tag.name);
  if(stack.length===2&&stack[0]==='project'&&tag.name==='packaging')found.push('');
 });
 const content=part=>{
  if(stack.length===2&&stack[0]==='project'&&stack[1]==='packaging')found[found.length-1]+=part;
 };
 parser.on('text',content);parser.on('cdata',content);
 parser.on('closetag',()=>stack.pop());
 try{parser.write(text).close();}
 catch{return null;}
 if(!project||found.length>1||found.length===1&&!found[0].trim())return null;
 const packing=found[0]?.trim()||'jar';
 return packing==='jar'||packing==='war'?packing:null;
}

function gradlePackaging(text){
 let parts;
 try{parts=tokens(text);}
 catch{return null;}
 let depth=0, plugins=false;
 for(let index=0;index<parts.length;index++){
  const part=parts[index];
  if(depth===0&&part.type==='id'&&part.value==='plugins'&&parts[index+1]?.type==='punct'&&parts[index+1].value==='{')plugins=true;
  if(part.type==='punct'&&part.value==='{'){depth++;continue;}
  if(part.type==='punct'&&part.value==='}'){
   if(--depth===0)plugins=false;
   continue;
  }
  if(!plugins||depth!==1||part.type!=='id')continue;
  if(part.value==='war')return 'war';
  if(part.value==='id'){
   const call=parts[index+1]?.value==='(',id=parts[index+(call?2:1)];
   const next=index+(call?4:2);
   const disabled=parts[next]?.value==='apply'&&parts[next+1]?.value==='false';
   if(id?.type==='string'&&id.literal&&id.value==='war'&&!disabled)return 'war';
  }
 }
 return depth===0?'jar':null;
}

function projectArchiveShape(entries,selection){
 const expected=builds[selection.type], profiles=entries.filter(entry=>!entry.directory&&Object.values(builds).includes(entry.path));
 if(profiles.length!==1||profiles[0].path!==expected)throw fail('ARCHIVE','The archive must contain one matching root build descriptor.');
 const sourceRoot='src/main/'+selection.language+'/', extension=extensions[selection.language];
 const sources=entries.filter(entry=>!entry.directory&&entry.path.startsWith(sourceRoot)&&entry.path.endsWith(extension));
 if(!sources.length)throw fail('ARCHIVE','The archive does not contain source files for the selected language.');
 let buildText;
 try{buildText=new TextDecoder('utf-8',{fatal:true}).decode(profiles[0].bytes);}
 catch{throw fail('ARCHIVE','The archive build descriptor must be UTF-8.');}
 if(buildText.length>1024*1024)throw fail('ARCHIVE','The archive build descriptor exceeds its review limit.');
 const packaging=expected==='pom.xml'?mavenPackaging(buildText):gradlePackaging(buildText);
 if((packaging===null&&(selection.packaging==='war'||expected==='pom.xml'))||(packaging&&packaging!==selection.packaging))
  throw fail('ARCHIVE','The archive build descriptor does not match the selected packaging.');
 const configFormats=formats[selection.configurationFileFormat];
 const recognizedNames=Object.values(formats).flat();
 const configFiles=configFormats?entries.filter(entry=>!entry.directory&&recognizedNames.some(name=>entry.path==='src/main/resources/'+name)):[];
 if(configFormats&&(configFiles.length!==1||!configFormats.some(name=>configFiles[0].path==='src/main/resources/'+name)))
  throw fail('ARCHIVE','The archive does not contain one matching application configuration file.');
 return {buildFile:expected,mainSourceDirectory:sourceRoot.slice(0,-1),sourceFileCount:sources.length,
  declaredPackaging:packaging,configurationFile:configFiles[0]?.path||null};
}

module.exports={projectArchiveShape};
