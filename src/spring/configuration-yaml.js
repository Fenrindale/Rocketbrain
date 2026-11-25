'use strict';

const { parseAllDocuments,isAlias,isMap,isScalar,isSeq,LineCounter }=require('yaml');
const LIMIT={bytes:1024*1024,documents:32,nodes:16000,entries:6000,depth:40,aliases:120};
const syntheticKey='__rocketbrain_yaml_completion_anchor__';
const keys=/^[^\s\u0000-\u001f.][^\u0000-\u001f]*$/;

function sourceRange(counter,node){
  if(!node?.range)return null;
  const position=offset=>{
    const point=counter.linePos(offset);
    return {line:point.line-1,character:point.col-1};
  };
  return {start:position(node.range[0]),end:position(node.range[1])};
}

function scalarText(node){
  if(node===null||node.value===null)return '';
  const value=node.value;
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='bigint'||Number.isFinite(value))return String(value);
  return null;
}

function parseYaml(file){
  const parsed={entries:[],documents:[],issues:[]};
  const raise=message=>{throw Error(message);};
  if(typeof file.text!=='string'||Buffer.byteLength(file.text)>LIMIT.bytes){
    parsed.issues.push('YAML exceeds the Spring source size limit.');
    return parsed;
  }
  let starts=0;
  for(const marker of file.text.matchAll(/^---(?=[ \t\r\n]|$)/gm)){
    if(++starts>LIMIT.documents){
      parsed.issues.push('YAML exceeds the Spring logical document limit.');
      return parsed;
    }
  }
  const counter=new LineCounter();
  let documents;
  try{
    documents=parseAllDocuments(file.text,{lineCounter:counter,version:'1.1',merge:false,intAsBigInt:true,uniqueKeys:true,
      prettyErrors:false,logLevel:'silent'});
  }catch{
    parsed.issues.push('YAML could not be parsed within the Spring source limits.');
    return parsed;
  }
  if(documents.length>LIMIT.documents){
    parsed.issues.push('YAML exceeds the Spring logical document limit.');
    return parsed;
  }

  let nodes=0, aliases=0, fields=0;
  for(const [index,document] of documents.entries()){
    const entries=[],issues=[],tag='YAML document '+(index+1)+': ';
    parsed.documents.push({index,entries,issues});
    if(document.errors.length||document.warnings.length){
      issues.push(tag+'invalid, duplicate or unsupported YAML syntax.');
      parsed.issues.push(...issues);
      continue;
    }
    function visit(depth){
      if(++nodes>LIMIT.nodes||depth>LIMIT.depth)raise('nested structure exceeds the source limit.');
    }
    function aliasTarget(node){
      if(++aliases>LIMIT.aliases)raise('too many alias expansions.');
      const target=node.resolve(document);
      if(!target)raise('undefined alias.');
      return target;
    }
    function mapping(node,depth,ancestors){
      visit(depth);
      if(ancestors.has(node))raise('cyclic merge or alias.');
      const next=new Set(ancestors).add(node);
      if(isAlias(node))return mapping(aliasTarget(node),depth+1,next);
      if(!isMap(node))raise('merge source must be a mapping.');
      const inherited=new Map(),explicit=[];
      for(const pair of node.items){
        if(isScalar(pair.key)&&pair.key.source==='<<'&&pair.key.type==='PLAIN'){
          const candidates=isSeq(pair.value)?pair.value.items:[pair.value];
          for(const candidate of candidates){
            for(const contribution of mapping(candidate,depth+1,next)){
              if(!inherited.has(contribution.key.value))inherited.set(contribution.key.value,contribution);
            }
          }
        }else{
          if(!isScalar(pair.key)||typeof pair.key.value!=='string'||pair.key.value.length>200||!keys.test(pair.key.value))
            raise('only literal Spring string keys are modeled.');
          explicit.push(pair);
        }
      }
      for(const pair of explicit)inherited.delete(pair.key.value);
      return [...inherited.values(),...explicit];
    }
    function emit(key,node,declaration){
      if(key.length>500||++fields>LIMIT.entries)raise('flattened property count or path exceeds the source limit.');
      const range=sourceRange(counter,declaration||node);
      const value=scalarText(node);
      if(!range||value===null)raise('unsupported or unbounded scalar.');
      entries.push({key,value,uri:file.uri,range,source:file.uri,document:index});
    }
    function walk(node,key,depth,ancestors,declaration){
      visit(depth);
      if(node===null||isScalar(node)){if(key)emit(key,node,declaration);return;}
      if(ancestors.has(node))raise('cyclic merge or alias.');
      if(isAlias(node)){
        walk(aliasTarget(node),key,depth+1,new Set(ancestors).add(node),declaration||node);
        return;
      }
      const next=new Set(ancestors).add(node);
      if(isMap(node)){
        for(const pair of mapping(node,depth,ancestors)){
          const name=pair.key.value, child=!key||name.startsWith('[')?key+name:key+'.'+name;
          walk(pair.value,child,depth+1,next,pair.key);
        }
        return;
      }
      if(isSeq(node)&&key){
        if(node.items.length===0){emit(key,null,declaration||node);return;}
        for(const [position,item] of node.items.entries())walk(item,key+'['+position+']',depth+1,next,item||declaration);
        return;
      }
      raise('the root or one of its values is outside the Spring configuration model.');
    }
    try{
      if(document.contents!==null&&!isMap(document.contents))raise('the root must be a mapping.');
      if(document.contents!==null)walk(document.contents,'',0,new Set());
    }catch(error){
      entries.length=0;
      issues.push(tag+error.message);
    }
    parsed.entries.push(...entries);
    parsed.issues.push(...issues);
  }
  return parsed;
}

function yamlCompletionContext(text,line){
  if(typeof text!=='string'||text.includes(syntheticKey))return null;
  const lines=text.split('\n'),original=lines[line];
  if(original===undefined)return null;
  const cr=original.endsWith('\r')?'\r':'';
  const content=cr?original.slice(0,-1):original;
  const key=/^([ ]*(?:-[ ]+)?)([\w.-]*)[ ]*$/.exec(content);
  if(!key)return null;
  lines[line]=key[1]+syntheticKey+':'+cr;
  const parsed=parseYaml({uri:'',text:lines.join('\n')});
  const match=parsed.entries.find(entry=>entry.range.start.line===line&&
    (entry.key===syntheticKey||entry.key.endsWith('.'+syntheticKey)));
  if(!match)return null;
  const prefix=match.key===syntheticKey?'':match.key.slice(0,-syntheticKey.length-1);
  return {prefix,keyStart:key[1].length,keyEnd:key[1].length+key[2].length};
}

module.exports={parseYaml,yamlCompletionContext};
