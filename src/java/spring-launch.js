'use strict';

const { argumentsList,environment,fail }=require('./workbench-model');

const sources=['environment','jvm','arguments'];
const active='spring.profiles.active';
const keyPattern=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const profilePattern=/^[A-Za-z0-9][\w.-]{0,79}$/;
const marker='__rocketbrainWorkbenchRunId',springMarker='__rocketbrainSpringBootLaunch';
const pending=new Map();
const propertyLimit=24;
const identity=value=>value.toLowerCase().replaceAll('_','.').replaceAll('-','');
const variable=value=>value.toUpperCase().replaceAll('.','_').replaceAll('-','');

function springLaunchOptions(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Choose Spring Boot launch options.');
  const profiles=input.profiles??[], properties=input.properties??[];
  if(!Array.isArray(profiles)||profiles.length>16||new Set(profiles).size!==profiles.length||
     profiles.some(profile=>typeof profile!=='string'||!profilePattern.test(profile)))throw fail('Use at most 16 distinct literal Spring profile names.');
  const profileSource=profiles.length?(input.profileSource??'environment'):null;
  if(profiles.length&&!sources.includes(profileSource))throw fail('Choose a delivery source for the active Spring profiles.');
  if(!Array.isArray(properties)||properties.length>propertyLimit)throw fail('Use at most 24 Spring Boot launch properties.');
  const used=new Set([identity(active)]);
  const checked=properties.map(property=>{
    if(!property||typeof property.key!=='string'||property.key.length>160||!keyPattern.test(property.key))
      throw fail('Use canonical lowercase Spring property keys.');
    const key=identity(property.key);
    if(used.has(key))throw fail('Remove a duplicate Spring property or use the active profiles field.');
    used.add(key);
    if(!sources.includes(property.source))throw fail('Choose an environment, JVM property or application argument source.');
    if(typeof property.value!=='string'||Buffer.byteLength(property.value)>4096||/[\r\n\0]/.test(property.value))
      throw fail('Use a single-line Spring property value no larger than 4 KiB.');
    return {key:property.key,source:property.source,value:property.value};
  });
  if(!profiles.length&&!checked.length)throw fail('Choose at least one Spring profile or launch property.');
  return {profiles:[...profiles],profileSource,properties:checked};
}

function describeSpringLaunch(options){
  return {profiles:[...options.profiles],profileSource:options.profileSource,
    properties:options.properties.map(({key,source})=>({key,source}))};
}

function restoreSpringLaunch(summary,values){
  if(!Array.isArray(summary?.properties)||!Array.isArray(values)||summary.properties.length!==values.length)
    throw fail('The saved Spring launch values are unavailable. Review the configuration and enter the values again.');
  return springLaunchOptions({...summary,properties:summary.properties.map((property,index)=>({...property,value:values[index]}))});
}

function projectSpringLaunch(base,options){
  const args=argumentsList(base.args),vmArgs=argumentsList(base.vmArgs),env=environment(base.env);
  const environmentKeys=Object.keys(env).map(key=>key.toUpperCase()), provided=new Set([
    ...environmentKeys.map(identity),
    ...args.filter(value=>value.startsWith('--')).map(value=>identity(value.slice(2).split('=',1)[0])),
    ...vmArgs.filter(value=>value.startsWith('-D')).map(value=>identity(value.slice(2).split('=',1)[0]))
  ]);
  const entries=options.profiles.length?[{key:active,source:options.profileSource,value:options.profiles.join(',')},...options.properties]:options.properties;
  for(const {key,source,value} of entries){
    const lookupAlias=key.toUpperCase().replace(/[.-]/g,'_');
    if(provided.has(identity(key))||environmentKeys.includes(variable(key))||environmentKeys.includes(lookupAlias))
      throw fail('Remove the existing launch option for '+key+' before selecting its Spring source.');
    if(source==='environment')env[variable(key)]=value;
    else if(source==='jvm')vmArgs.push('-D'+key+'='+value);
    else args.push('--'+key+'='+value);
  }
  return {args:argumentsList(args),vmArgs:argumentsList(vmArgs),env:environment(env)};
}

function retainSpringLaunch(id,options){pending.set(id,options);}
function discardSpringLaunch(id){pending.delete(id);}
function applyManagedSpringLaunch(config){
  if(config[springMarker]!==true)return;
  const options=pending.get(config[marker]);
  if(!options)throw fail('The managed Spring Boot launch was cancelled or replaced.');
  Object.assign(config,projectSpringLaunch(config,options));
}

module.exports={springLaunchOptions,describeSpringLaunch,restoreSpringLaunch,projectSpringLaunch,
  retainSpringLaunch,discardSpringLaunch,applyManagedSpringLaunch,marker,springMarker,propertyLimit};
