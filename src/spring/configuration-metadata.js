'use strict';

const { parseJavaFile,rangeAt }=require('./java');
const { parseYaml }=require('./configuration-yaml');
const { parseProperties }=require('./configuration');

const exactType=/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const propertyName=/^[A-Za-z0-9][\w.-]{0,499}$/;
const normalizePath=text=>text.replaceAll('\\','/');

function metadataProperties(json, origin) {
  if (!json || !Array.isArray(json.properties) || json.properties.length>10000) return [];
  return json.properties.filter(item=>item&&typeof item.name==='string'&&propertyName.test(item.name)).map(item=>({
    name:item.name,
    type:typeof item.type==='string'?item.type.slice(0,500):'java.lang.String',
    description:typeof item.description==='string'?item.description.slice(0,4000):'',
    defaultValue:typeof item.defaultValue==='string'?item.defaultValue.slice(0,800):
      typeof item.defaultValue==='boolean'||Number.isFinite(item.defaultValue)?item.defaultValue:undefined,
    origin,
    ...(typeof item.sourceType==='string'&&item.sourceType.length<=192&&exactType.test(item.sourceType)?{sourceType:item.sourceType}:{})
  }));
}

function metadataModule(uri){
  const value=normalizePath(uri);
  const descriptor=/\/(?:build\/(?:classes|resources|generated)|target\/(?:classes|test-classes)|src\/(?:main|test)\/resources)\//i.exec(value);
  const fallback=value.lastIndexOf('/META-INF/');
  return value.slice(0,descriptor?.index??fallback);
}

function workspaceMetadata(records,documentPath){
  if(!documentPath)return records;
  const full=normalizePath(documentPath);
  const resources=/\/src\/(?:main|test)\/resources\//i.exec(full);
  if(resources){
    const owner=full.slice(0,resources.index);
    return records.filter(record=>record.moduleRoot===owner);
  }
  const applicable=records.filter(record=>full.startsWith(record.moduleRoot+'/'));
  const depth=Math.max(-1,...applicable.map(record=>record.moduleRoot.length));
  return applicable.filter(record=>record.moduleRoot.length===depth);
}

function selectMetadata(records){
  const result=new Map();
  for(const item of records){
    const previous=result.get(item.name);
    if(!previous){result.set(item.name,item);continue;}
    if(item.sourceType&&previous.sourceType&&item.sourceType!==previous.sourceType){
      result.set(item.name,{...previous,sourceType:null,ambiguous:true});
    }else if(!previous.sourceType&&!previous.ambiguous&&item.sourceType){
      result.set(item.name,item);
    }
  }
  return [...result.values()];
}

function declarationAt(file,position){
  const parser=/\.properties$/i.test(file.uri)?parseProperties:parseYaml;
  const within=(value,from,to)=>value>=from&&value<=to;
  const declarations=parser(file).entries.filter(entry=>entry.range.start.line===position.line&&entry.range.end.line===position.line&&
    within(position.character,entry.range.start.character,entry.range.end.character));
  return declarations.length===1?declarations[0]:null;
}

function metadataJavaSource(file,entry){
  if(!entry.sourceType||entry.sourceType.includes('$'))return null;
  const model=parseJavaFile(file);
  const owners=model.types.filter(type=>type.fqn===entry.sourceType);
  if(owners.length!==1)return null;
  const owner=owners[0],name=entry.name.split('.').at(-1).replaceAll('-','').toLowerCase();
  const fields=owner.fields.filter(field=>field.name.toLowerCase()===name);
  const field=fields.length===1?fields[0]:null;
  return {uri:file.uri,range:field?rangeAt(file.text,field.start,field.end):owner.range};
}

module.exports={metadataProperties,metadataModule,workspaceMetadata,selectMetadata,declarationAt,metadataJavaSource};
