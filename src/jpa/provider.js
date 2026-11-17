'use strict';
const { lexJava } = require('../spring/java');
const LIMITS = { functions: 1024, arguments: 64, contributors: 256 };
const CATEGORIES = new Set(['ANY','STRING','NUMERIC','INTEGER','BOOLEAN','TEMPORAL','DATE','TIME','COMPARABLE','ENUM','COLLECTION','ARRAY']);
const JAVA_TYPES = { STRING:'java.lang.String',INTEGER:'java.lang.Integer',LONG:'java.lang.Long',FLOAT:'java.lang.Float',DOUBLE:'java.lang.Double',BIG_DECIMAL:'java.math.BigDecimal',BIG_INTEGER:'java.math.BigInteger',BOOLEAN:'java.lang.Boolean',DATE:'java.sql.Date',TIME:'java.sql.Time',TIMESTAMP:'java.sql.Timestamp',LOCAL_DATE:'java.time.LocalDate',LOCAL_TIME:'java.time.LocalTime',LOCAL_DATE_TIME:'java.time.LocalDateTime',INSTANT:'java.time.Instant',UUID:'java.util.UUID' };
const FEATURES = new Set(['temporalArithmetic','windowFunctions','filterClause','extractExtensions','castExtensions','enumLiteralInference','arrayCollectionBindings','enumStringCoercion']);
const DURATION_UNITS = new Set(['year','quarter','month','week','day','hour','minute','second','nanosecond']);
const WINDOW_FUNCTIONS = new Set(['row_number','rank','dense_rank','percent_rank','cume_dist','ntile','lag','lead','first_value','last_value','nth_value']);
function own(object, key) { const descriptor = object && typeof object === 'object' && Object.getOwnPropertyDescriptor(object,key); return descriptor && Object.hasOwn(descriptor,'value') ? descriptor.value : undefined; }
function string(value, length=256) { return typeof value==='string' && value.length<=length ? value : null; }
function javaType(value) { return typeof value==='string'&&value.length<=256&&/^[\w.$]+(?:\[\])*$/.test(value)?value:null; }
function argument(value) {
  if (typeof value==='string') value={category:value};
  const category=string(own(value,'category'),32)?.toUpperCase(), type=javaType(own(value,'javaType'));
  return type||CATEGORIES.has(category)?{...(type?{javaType:type}:{}),...(CATEGORIES.has(category)?{category}:{}),optional:own(value,'optional')===true}:null;
}
function normalizeProviderProfile(input) {
  const rawProvider=string(own(input,'provider'),80),version=string(own(input,'version'),100),id=string(own(input,'id'));
  const enabled=Boolean(id&&/^(hibernate|hibernate orm|hibernate-orm|org\.hibernate\.orm)$/i.test(rawProvider||'')&&/^7\.4\.\d+(?:[.-][\w]+)*$/.test(version||''));
  const profile={id:id||null,provider:rawProvider||null,version:version||null,observedAt:string(own(input,'observedAt'),80),source:['runtime-observed','source-declared'].includes(own(input,'source'))?own(input,'source'):'supplied',enabled,functions:Object.create(null),capabilities:Object.create(null),unknowns:[]};
  if (!enabled) { if(input)profile.unknowns.push('Provider profile does not identify a supported Hibernate7.4 snapshot.');return profile; }
  const capabilities=own(input,'capabilities');
  for(const name of FEATURES)profile.capabilities[name]=typeof own(capabilities,name)==='boolean'?own(capabilities,name):!['arrayCollectionBindings','enumStringCoercion'].includes(name);
  const functions=own(input,'functions');
  if(functions&&typeof functions==='object')for(const name of Object.keys(functions).slice(0,LIMITS.functions)){
    if(!/^[A-Za-z_][\w$]{0,127}$/.test(name))continue;
    const value=own(functions,name);if(!value||typeof value!=='object')continue;
    const rawArgs=own(value,'arguments'),args=Array.isArray(rawArgs)&&rawArgs.length<=LIMITS.arguments?rawArgs.map(argument):null;
    const rawReturns=own(value,'returns'),returnsType=javaType(typeof rawReturns==='string'?rawReturns:own(rawReturns,'javaType')),argumentIndex=own(rawReturns,'argumentIndex');
    const returns=returnsType?{javaType:returnsType}:Number.isInteger(argumentIndex)&&argumentIndex>=0&&argumentIndex<LIMITS.arguments?{argumentIndex}:null;
    const min=own(value,'minArgs'),max=own(value,'maxArgs'),validArity=Number.isInteger(min)&&min>=0&&min<=LIMITS.arguments&&Number.isInteger(max)&&max>=min&&max<=LIMITS.arguments;
    profile.functions[name.toLowerCase()]={name:name.toLowerCase(),state:['observed','declared'].includes(own(value,'state'))?own(value,'state'):'unknown',arguments:args&&args.every(Boolean)?args:null,minArgs:validArity?min:null,maxArgs:validArity?max:null,returns,signature: string(own(value,'signature'),1024),descriptorClass:string(own(value,'descriptorClass')),overridden:own(value,'overridden')===true};
  }
  if(functions&&Object.keys(functions).length>LIMITS.functions)profile.unknowns.push('Function profile was truncated; missing entries are not proof of absence.');
  return profile;
}
function providerProfileFromSnapshot(snapshot,factoryId){
  if(!snapshot||typeof snapshot!=='object'||own(snapshot,'state')&& !['observed','connected','partial'].includes(own(snapshot,'state')))return null;
  const candidates=own(snapshot,'factories');if(!Array.isArray(candidates))return null;
  const matches=factoryId===undefined?candidates:candidates.filter(value=>own(value,'id')===factoryId);if(matches.length!==1)return null;
  const factory=matches[0],id=string(own(factory,'id'),128);if(!id)return null;
  const functions=Object.create(null),entries=own(factory,'functions');
  if(Array.isArray(entries))for(const value of entries.slice(0,LIMITS.functions)){const name=string(own(value,'name'),128);if(name&&/^[A-Za-z_][\w$]*$/.test(name))functions[name]={state:own(value,'state'),arguments:own(value,'arguments'),returns:own(value,'returns'),minArgs:own(value,'minArgs'),maxArgs:own(value,'maxArgs'),signature:own(value,'signature'),descriptorClass:own(value,'descriptorClass'),overridden:own(value,'overridden')};}
  const observedAt=string(own(snapshot,'observedAt'),80)||string(own(snapshot,'fetchedAt'),80)||string(own(factory,'observedAt'),80);
  return normalizeProviderProfile({id:('runtime:'+id+':'+(observedAt||'time-unreported')).slice(0,256),provider:own(factory,'provider'),version:own(factory,'version'),source:'runtime-observed',observedAt,functions,capabilities:own(factory,'capabilities')});
}
function feature(profile,name){return Boolean(profile?.enabled&&profile.capabilities?.[name]);}
function descriptor(profile,name){return profile?.enabled?profile.functions?.[name.toLowerCase()]||null:null;}
function knownFunction(profile,name){return Boolean(descriptor(profile,name))||Boolean(profile?.enabled&&WINDOW_FUNCTIONS.has(name.toLowerCase()));}
function isExtensionKeyword(profile,name){return profile?.enabled&&(['filter','over','partition','rows','range','groups','exclude','preceding','following','unbounded'].includes(name)||WINDOW_FUNCTIONS.has(name));}
function profileSummary(profile){return{profileId:profile?.id||null,provider:profile?.provider||null,version:profile?.version||null,observedAt:profile?.observedAt||null,profileSource:profile?.source||'supplied',certainty:profile?.enabled?'conditional-on-explicit-profile':'unconfigured',sourceRevisionMatched:false,allRuntimeRegistrationsVerified:false,usedFunctions:[],usedFeatures:[],unknowns:[...(profile?.unknowns||[])]};}
function functionContract(profile,name,declarations=[]){const observed=descriptor(profile,name);if(observed?.arguments&&observed.returns&&observed.minArgs!==null&&['observed','declared'].includes(observed.state))return{...observed,certainty:observed.state==='observed'?'runtime-profile-contract':'supplied-declared-contract'};const declared=declarations.filter(value=>value.name===name.toLowerCase());return declared.length===1?{...declared[0],certainty:'source-declared-registration-unverified',registryObserved:Boolean(observed)}:observed?{...observed,certainty:'registry-presence-only'}:null;}

// Recognize only literal builder metadata. This does not execute a contributor,
// decide whether it is registered, resolve its priority or prove no override.
function contributorDeclarations(files){
  const result=[];
  for(const file of files){const tokens=file.tokens||lexJava(file.text).tokens;for(const owner of file.types||[]){if(!owner.superTypes?.includes('org.hibernate.boot.model.FunctionContributor'))continue;
    for(let i=0;i<tokens.length&&result.length<LIMITS.contributors;i++){
      if(!['namedDescriptorBuilder','patternDescriptorBuilder','namedAggregateDescriptorBuilder','patternAggregateDescriptorBuilder'].includes(tokens[i].text)||tokens[i-1]?.text!=='.'||tokens[i+1]?.text!=='('||tokens[i+2]?.kind!=='string')continue;
      const name=tokens[i+2].value;if(!/^[A-Za-z_][\w$]{0,127}$/.test(name||''))continue;
      let end=i+1,depth=0;for(;end<tokens.length;end++){if(tokens[end].text==='(')depth++;else if(tokens[end].text===')'&&!--depth){end++;break;}}
      let min=null,max=null,returns=null,args=null,registered=false;
      for(let at=end;tokens[at]?.text==='.'&&tokens[at+1]?.kind==='id'&&tokens[at+2]?.text==='(';){let last=at+2,nesting=0;for(;last<tokens.length;last++){if(tokens[last].text==='(')nesting++;else if(tokens[last].text===')'&&!--nesting)break;}if(last>=tokens.length)break;
        const method=tokens[at+1].text,parts=tokens.slice(at+3,last),raw=parts.map(value=>value.text).join('');
        if(method==='setExactArgumentCount'&&/^\d+$/.test(raw))min=max=Number(raw);
        else if(method==='setArgumentCountBetween'&&/^\d+,\d+$/.test(raw))[min,max]=raw.split(',').map(Number);
        else if(method==='setParameterTypes'){const values=raw.split(',').map(value=>/^(?:org\.hibernate\.query\.sqm\.produce\.function\.)?FunctionParameterType\.([A-Z_]+)$/.exec(value)?.[1]);if(values.every(value=>CATEGORIES.has(value)))args=values.map(category=>({category,optional:false}));}
        else if(method==='setInvariantType'){const constants=parts.filter((value,index)=>value.text==='StandardBasicTypes'&&parts[index+1]?.text==='.'&&JAVA_TYPES[parts[index+2]?.text]).map((value,index)=>value);const match=/StandardBasicTypes\.([A-Z_]+)/.exec(raw);if(constants.length===1&&match)returns={javaType:JAVA_TYPES[match[1]]};}
        else if(method==='register'&&parts.length===0)registered=true;
        else if(!['setArgumentListSignature','setUseParenthesesWhenNoArgs'].includes(method))break;
        at=last+1;
      }
      if(registered&&args&&returns&&Number.isInteger(min)&&Number.isInteger(max)&&max<=LIMITS.arguments)result.push({name:name.toLowerCase(),arguments:args,minArgs:min,maxArgs:max,returns,state:'declared',uri:file.uri,contributor:owner.fqn,certainty:'source-declared-registration-unverified',executedUserCode:false});
    }
  }}return result;
}
function enumValues(environment,fqn){const choices=environment.get(fqn);if(choices?.length!==1||choices[0].type.kind!=='enum')return null;const {file,type}=choices[0],tokens=file.tokens||lexJava(file.text).tokens;let at=tokens.findIndex((token,index)=>token.text==='enum'&&tokens[index+1]?.text===type.name);if(at<0)return null;while(at<tokens.length&&tokens[at].text!=='{')at++;const values=[];let expected=true,depth=0;for(at++;at<tokens.length;at++){const token=tokens[at];if(!depth&&[';','}'].includes(token.text))break;if(!depth&&expected){if(token.kind!=='id')return null;values.push(token.text);expected=false;}if(['(','{'].includes(token.text))depth++;else if([')','}'].includes(token.text))depth--;else if(!depth&&token.text===',')expected=true;}return values;}
function enumLiteral(profile,environment,name,expected){return feature(profile,'enumLiteralInference')&&expected?.kind==='enum'&&enumValues(environment,expected.javaType)?.includes(name)?{kind:'enum',javaType:expected.javaType,providerInferred:true}:null;}
function castType(profile,name){if(!feature(profile,'castExtensions'))return null;return{byte:'java.lang.Byte',short:'java.lang.Short',integer:'java.lang.Integer',int:'java.lang.Integer',long:'java.lang.Long',float:'java.lang.Float',double:'java.lang.Double',biginteger:'java.math.BigInteger',bigdecimal:'java.math.BigDecimal',string:'java.lang.String',boolean:'java.lang.Boolean',localdate:'java.time.LocalDate',localtime:'java.time.LocalTime',localdatetime:'java.time.LocalDateTime',date:'java.sql.Date',time:'java.sql.Time',timestamp:'java.sql.Timestamp',instant:'java.time.Instant',uuid:'java.util.UUID'}[name.toLowerCase()]||null;}
function extractType(profile,field){if(!feature(profile,'extractExtensions'))return null;return{second:'java.lang.Float',nanosecond:'java.lang.Long',epoch:'java.lang.Long','day of week':'java.lang.Integer','day of month':'java.lang.Integer','day of year':'java.lang.Integer','week of month':'java.lang.Integer','week of year':'java.lang.Integer','offset hour':'java.lang.Integer','offset minute':'java.lang.Integer'}[field.toLowerCase()]||null;}
function temporalArithmetic(profile,op,left,right){if(!feature(profile,'temporalArithmetic'))return null;const duration=type=>type?.kind==='duration',temporal=type=>type?.kind==='temporal';if(op==='-'&&temporal(left)&&temporal(right)){const date=type=>['java.time.LocalDate','java.sql.Date'].includes(type.javaType);if(date(left)!==date(right))return{unknown:'Date/datetime duration categories do not match.'};return{kind:'duration',javaType:'java.time.Duration',durationKind:date(left)?'year-day':'week-nanosecond'};}if(['+','-'].includes(op)&&temporal(left)&&duration(right))return{...left};if(op==='+'&&duration(left)&&temporal(right))return{...right};if(['+','-'].includes(op)&&duration(left)&&duration(right))return left.durationKind===right.durationKind?{...left}:{unknown:'Different HQL duration categories cannot be assumed compatible.'};if(op==='*'&&(duration(left)&&right?.kind==='numeric'||left?.kind==='numeric'&&duration(right)))return duration(left)?{...left}:{...right};return{unknown:'Temporal/duration arithmetic form is not covered by this provider profile.'};}

module.exports={normalizeProviderProfile,providerProfileFromSnapshot,feature,descriptor,knownFunction,isExtensionKeyword,profileSummary,functionContract,contributorDeclarations,enumLiteral,castType,extractType,temporalArithmetic,DURATION_UNITS,WINDOW_FUNCTIONS,LIMITS};
