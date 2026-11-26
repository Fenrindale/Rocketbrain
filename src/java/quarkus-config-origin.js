'use strict';

const {KEY,PROFILE,profileFile}=require('./quarkus-config-mapping');
const kinds=new Set(['classpath-properties','file-properties','environment','system','default','other','unavailable']);
const files=new Set(['classpath-properties','file-properties']);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const matches=(value,pattern)=>typeof value==='string'&&pattern.test(value);

function normalizeQuarkusConfigOrigins(payload) {
  const invalid=()=>{throw Error('Unsupported Quarkus configuration origin report.');};
  if(!payload||!['disabled','waiting','ready','partial'].includes(payload.state)||
    !integer(payload.processId,1,Number.MAX_SAFE_INTEGER)||!Array.isArray(payload.keys)||payload.keys.length>24||
    payload.keys.some(key=>!matches(key,KEY))||new Set(payload.keys).size!==payload.keys.length||
    (payload.state==='disabled')!==(payload.keys.length===0)||!Array.isArray(payload.contexts)||payload.contexts.length>8||
    (['disabled','waiting'].includes(payload.state)&&payload.contexts.length))return invalid();
  const configured=new Set(payload.keys), ids=new Set();
  const contexts=payload.contexts.map(context=>{
    if(!context||!matches(context.id,/^config-[1-9][0-9]{0,15}$/u)||ids.has(context.id)||
      !Array.isArray(context.activeProfiles)||context.activeProfiles.length>16||
      context.activeProfiles.some(profile=>!matches(profile,PROFILE))||
      new Set(context.activeProfiles).size!==context.activeProfiles.length||
      !Array.isArray(context.origins)||!context.origins.length||context.origins.length>configured.size)return invalid();
    ids.add(context.id);
    const keys=new Set();
    const origins=context.origins.map(item=>{
      if(!item||!configured.has(item.key)||keys.has(item.key)||!kinds.has(item.kind)||
        (files.has(item.kind)?typeof item.file!=='string'||profileFile(item.file)===null:item.file!==null)||
        (item.kind==='unavailable'?item.ordinal!==null:!integer(item.ordinal,-2147483648,2147483647))||
        (item.line!==null&&(!files.has(item.kind)||!integer(item.line,1,100000)))||
        (item.selectedProfile!==null&&!matches(item.selectedProfile,PROFILE)))return invalid();
      keys.add(item.key);
      return {key:item.key,kind:item.kind,file:item.file,ordinal:item.ordinal,line:item.line,selectedProfile:item.selectedProfile};
    }).sort((left,right)=>left.key.localeCompare(right.key));
    return {id:context.id,activeProfiles:[...context.activeProfiles],origins};
  });
  return {processId:payload.processId,state:payload.state,keys:[...payload.keys].sort(),contexts};
}

module.exports={normalizeQuarkusConfigOrigins};
