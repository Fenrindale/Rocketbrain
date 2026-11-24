'use strict';
// A deliberately small source language for extension contracts. No extension,
// constructor, annotation processor or project expression is evaluated here.
const {lexJava,parseJavaFile,rangeAt}=require('../spring/java');
const {analyzeFiniteSpringFlow}=require('./spring-contract-flow');
const {createConditionReviewer,isReviewedConditionName,CONDITION_TYPES,SPRING_CONDITION_LIMITS}=require('./spring-condition-analysis');
const {createComposedConditionReviewer}=require('./spring-composed-conditions');
const LIMITS=Object.freeze({files:1024,characters:16*1024*1024,types:2048,annotations:512,depth:24,members:256,findings:512});
const EXTENSIONS={ImportSelector:'org.springframework.context.annotation.ImportSelector',ImportBeanDefinitionRegistrar:'org.springframework.context.annotation.ImportBeanDefinitionRegistrar',BeanPostProcessor:'org.springframework.beans.factory.config.BeanPostProcessor'};
const ROLE_NAMES=new Set(['Component','Service','Repository','Controller','RestController','Configuration','Bean','Autowired','Qualifier','Value','Resource','Inject','Named','PostConstruct','PreDestroy','GetMapping','PostMapping','PutMapping','DeleteMapping','PatchMapping','RequestMapping','Scheduled','EventListener','Import','ImportResource','ComponentScan','Profile']);
const ROLE_FQNS=new Set([...['Component','Service','Repository','Controller'].map(name=>'org.springframework.stereotype.'+name),...['RestController','GetMapping','PostMapping','PutMapping','DeleteMapping','PatchMapping','RequestMapping'].map(name=>'org.springframework.web.bind.annotation.'+name),...['Configuration','Bean','Import','ImportResource','ComponentScan','Profile'].map(name=>'org.springframework.context.annotation.'+name),...['Autowired','Qualifier','Value'].map(name=>'org.springframework.beans.factory.annotation.'+name),'org.springframework.scheduling.annotation.Scheduled','org.springframework.context.event.EventListener',...['jakarta','javax'].flatMap(prefix=>['annotation.Resource','annotation.PostConstruct','annotation.PreDestroy','inject.Inject','inject.Named'].map(name=>prefix+'.'+name))]);
const META_NAMES=new Set(['java.lang.annotation.Target','java.lang.annotation.Retention','java.lang.annotation.Documented','java.lang.annotation.Inherited']);
const MODIFIERS=new Set(['public','private','protected','static','final','abstract','default','synchronized','native','strictfp']);
function matching(tokens,index){const open=tokens[index]?.text,close={'(':')','{':'}','[':']'}[open];if(!close)return -1;let depth=0;for(let i=index;i<tokens.length;i++){if(tokens[i].text===open)depth++;else if(tokens[i].text===close&&!--depth)return i;}return -1;}
function split(tokens,delimiter=','){let depth=0,from=0;const out=[];for(let i=0;i<tokens.length;i++){if(['(','{','[','<'].includes(tokens[i].text))depth++;else if([')','}',']','>'].includes(tokens[i].text))depth--;else if(!depth&&tokens[i].text===delimiter){out.push(tokens.slice(from,i));from=i+1;}}out.push(tokens.slice(from));return out;}
const text=tokens=>tokens.map(token=>token.text).join('');
const RESOLVABLE_TYPES=[...Object.values(EXTENSIONS),...Object.values(CONDITION_TYPES),'org.springframework.core.annotation.AliasFor','org.springframework.core.type.AnnotationMetadata','org.springframework.beans.factory.support.BeanDefinitionRegistry','org.springframework.beans.factory.support.RootBeanDefinition','org.springframework.beans.factory.support.GenericBeanDefinition',...META_NAMES,'org.springframework.stereotype.Component','org.springframework.stereotype.Service','org.springframework.context.annotation.Import','org.springframework.context.annotation.Configuration','org.springframework.web.bind.annotation.RestController'];
function resolve(name,file){if(name.includes('.'))return name;if(Object.hasOwn(file.imports,name))return file.imports[name];if(['String','Object','Override','Deprecated','SuppressWarnings'].includes(name))return 'java.lang.'+name;const exact=RESOLVABLE_TYPES.filter(value=>value.endsWith('.'+name)&&file.wildcards.includes(value.slice(0,value.lastIndexOf('.'))));return exact.length===1?exact[0]:(file.packageName?file.packageName+'.':'')+name;}
function annotation(tokens,index,file){
 if(tokens[index]?.text!=='@'||tokens[index+1]?.kind!=='id'||tokens[index+1].text==='interface')return null;
 let i=index+2,name=tokens[index+1].text,attributesComplete=true;
 while(tokens[i]?.text==='.'&&tokens[i+1]?.kind==='id'){name+='.'+tokens[i+1].text;i+=2;}
 const attributes=Object.create(null);
 if(tokens[i]?.text==='('){
  const end=matching(tokens,i);
  if(end<0)return null;
  const parts=end===i+1?[]:split(tokens.slice(i+1,end));
  for(const part of parts){
   const named=part[0]?.kind==='id'&&part[1]?.text==='=',key=named?part[0].text:'value',value=named?part.slice(2):part;
   if(!value.length||!named&&parts.length!==1||Object.hasOwn(attributes,key))attributesComplete=false;
   attributes[key]=value;
  }
  i=end+1;
 }
 return {name:resolve(name,file),rawName:name,shortName:name.split('.').at(-1),attributes,attributesComplete,start:tokens[index].start,end:tokens[i-1].end,next:i};
}
function literalStrings(tokens){if(!tokens)return [];if(tokens[0]?.text==='{'){if(tokens.at(-1)?.text!=='}')return null;tokens=tokens.slice(1,-1);}if(!tokens.length)return [];const parts=split(tokens);return parts.every(part=>part.length===1&&part[0].kind==='string'&&part[0].value!==null)?parts.map(part=>part[0].value):null;}
function classes(tokens,file){if(!tokens)return null;if(tokens[0]?.text==='{'){if(tokens.at(-1)?.text!=='}')return null;tokens=tokens.slice(1,-1);}if(!tokens.length)return [];return split(tokens).map(part=>{if(part.at(-1)?.text!=='class'||part.at(-2)?.text!=='.')return null;const name=text(part.slice(0,-2));return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)?resolve(name,file):null;}).every(Boolean)?split(tokens).map(part=>resolve(text(part.slice(0,-2)),file)):null;}
function* nestedConditionDeclarations(tokens,file,topLevel,hasConditionUse){
 let conditional=false;
 for(let index=0;index<tokens.length;index++){
  const item=annotation(tokens,index,file);
  if(item){
   conditional ||= isReviewedConditionName(item.shortName)||item.shortName.startsWith('ConditionalOn')||hasConditionUse(item,file);
   index=item.next-1;
   continue;
  }
  if(conditional&&tokens[index].text==='@'&&tokens[index+1]?.text==='interface'&&tokens[index+2]?.kind==='id'
     &&!topLevel?.has(tokens[index+2].start))yield tokens[index+2];
  if(!MODIFIERS.has(tokens[index].text))conditional=false;
 }
}
function sourceTypes(file){const tokens=lexJava(file.text).tokens,types=[];let pending=[],prefix=[],i=0;while(i<tokens.length){if(tokens[i].text==='@'&&tokens[i+1]?.text!=='interface'){const item=annotation(tokens,i,file);if(item){pending.push(item);i=item.next;continue;}}const isAnnotation=tokens[i].text==='@'&&tokens[i+1]?.text==='interface',kind=isAnnotation?'annotation':tokens[i].text,nameIndex=i+(isAnnotation?2:1);if((isAnnotation||['class','interface','record','enum'].includes(kind))&&tokens[nameIndex]?.kind==='id'){let open=nameIndex+1;while(open<tokens.length&&tokens[open].text!=='{')open++;const close=matching(tokens,open);if(close<0)break;const name=tokens[nameIndex].text,header=tokens.slice(nameIndex+1,open),type={name,fqn:(file.packageName?file.packageName+'.':'')+name,kind,file,tokens,nameStart:tokens[nameIndex].start,start:prefix[0]?.start??pending[0]?.start??tokens[i].start,end:tokens[close].end,open,close,header,annotations:pending,final:prefix.some(token=>token.text==='final'),members:[],unsupported:false};let cursor=open+1;while(cursor<close){if(tokens[cursor].text===';'){cursor++;continue;}const annotations=[];while(tokens[cursor]?.text==='@'){const a=annotation(tokens,cursor,file);if(!a)break;annotations.push(a);cursor=a.next;}const start=cursor;while(cursor<close&&!['(',';','=','{'].includes(tokens[cursor].text))cursor++;if(tokens[cursor]?.text!=='('){type.unsupported=true;if(tokens[cursor]?.text==='{')cursor=matching(tokens,cursor)+1;else {while(cursor<close&&tokens[cursor].text!==';')cursor++;cursor++;}continue;}const paramsEnd=matching(tokens,cursor);if(paramsEnd<0){type.unsupported=true;break;}const methodName=tokens[cursor-1],head=tokens.slice(start,cursor-1),parameters=split(tokens.slice(cursor+1,paramsEnd)).filter(part=>part.length).map(part=>{const rawType=text(part.slice(0,-1).filter(token=>token.text!=='final'));return {name:part.at(-1)?.text,rawType,type:resolve(rawType,file)};});let tail=paramsEnd+1;if(isAnnotation&&tokens[tail]?.text==='default'&&tokens[tail+1]?.text==='{'){const endDefault=matching(tokens,tail+1);if(endDefault<0){type.unsupported=true;break;}tail=endDefault+1;}while(tail<close&&!['{',';'].includes(tokens[tail].text))tail++;const bodyEnd=tokens[tail]?.text==='{'?matching(tokens,tail):tail;if(bodyEnd<0){type.unsupported=true;break;}type.members.push({name:methodName?.text,start:annotations[0]?.start??tokens[start]?.start,end:tokens[bodyEnd]?.end,head,parameters,annotations,nameStart:methodName.start,nameEnd:methodName.end,body:tokens[tail]?.text==='{'?tokens.slice(tail+1,bodyEnd):null,defaultTokens:tokens.slice(paramsEnd+1,tail),range:rangeAt(file.text,methodName.start,methodName.end)});cursor=bodyEnd+1;}types.push(type);pending=[];prefix=[];i=close+1;continue;}if(MODIFIERS.has(tokens[i].text))prefix.push(tokens[i]);else if(![';'].includes(tokens[i].text)){pending=[];prefix=[];}i++;}return types;}
function analyzeSpringContracts(sources){
 const java=sources.filter(source=>/\.java$/i.test(source.uri)),unknowns=[],references=[],extensions=[],annotations=[],conditions=[],resolvedConditionSpans=[],resolvedTokenSpans=[],methodContracts=[];let complete=true;
 const report=()=>({version:1,mode:'source-only-extension-contracts',complete,annotations,extensions,conditions,resolvedConditionSpans,references,methodContracts,resolvedTokenSpans,unknowns,executedProjectCode:false,limits:LIMITS,conditionLimits:SPRING_CONDITION_LIMITS});
 const finding=(list,kind,file,start,end,message,extra={})=>{if(list.length>=LIMITS.findings){complete=false;return;}list.push({kind,uri:file.uri,range:rangeAt(file.text,start,end),message,...extra});};
 const unknown=(type,message)=>finding(unknowns,'spring.extension-unresolved',type.file,type.start,type.end,message,{owner:type.fqn});
 if(java.length>LIMITS.files||java.reduce((n,file)=>n+file.text.length,0)>LIMITS.characters){complete=false;finding(unknowns,'spring.contract-budget',java[0],0,0,'Spring extension source budget exceeded; coverage is unknown.');return report();}
 for(const source of java)if(lexJava(source.text).issues.length)finding(unknowns,'spring.contract-syntax',source,0,0,'Java lexer coverage is incomplete; extension contracts cannot establish absence of consumers.');
 const files=java.map(parseJavaFile),types=files.flatMap(file=>sourceTypes(file)),byName=new Map();for(const type of types){if(byName.has(type.fqn)){unknown(type,'Duplicate source type identity prevents extension contract resolution.');byName.set(type.fqn,null);}else byName.set(type.fqn,type);}if(types.length>LIMITS.types){complete=false;unknown(types[0],'Spring extension type budget exceeded; no extension permission is inferred.');return report();}
 const reviewCondition=createConditionReviewer({byName,resolve}),protectedCallbacks=new Set();
 const composed=createComposedConditionReviewer({byName,resolve,reviewCondition});
 const topLevelAnnotations=new Map();
 for(const type of types)if(type.kind==='annotation'){
  if(!topLevelAnnotations.has(type.file))topLevelAnnotations.set(type.file,new Set());
  topLevelAnnotations.get(type.file).add(type.nameStart);
 }
 let conditionReportItems=0,conditionBudgetReached=false;
 function stopConditionReview(file,a){
  complete=false;
  conditionBudgetReached=true;
  finding(unknowns,'spring.condition-budget',file,a.start,a.end,'Spring condition report budget exceeded; condition reference coverage is incomplete.');
 }
 function retainCondition(a,file){
  if(conditionBudgetReached)return;
  if(composed.hasConditionUse(a,file)){
   const reviewed=composed.review(a,file);
   if(!reviewed){
    finding(unknowns,'spring.composed-condition-unresolved',file,a.start,a.end,
     'The composed condition metadata, alias binding or literal alternatives exceed the bounded source review.',{annotation:a.name});
    return;
   }
   for(const type of reviewed.references)finding(references,'spring.condition-meta-reference',file,a.start,a.end,
    'This source annotation is a potential composed Spring condition dependency.',{type,name:type.split('.').at(-1)});
   for(const branch of reviewed.leaves){
    if(!retainConditionResult(a,file,branch,{leaf:branch.leaf,chain:branch.chain,aliases:reviewed.aliases}))return;
   }
   resolvedConditionSpans.push({uri:file.uri,start:a.start,end:a.end,kind:'composed-condition'});
   return;
  }
  if(!isReviewedConditionName(a.shortName))return;
  const reviewed=reviewCondition(a,file);
  if(!reviewed){
   finding(unknowns,'spring.dynamic-condition',file,a.start,a.end,'Conditional form or callback exceeds the bounded source review.',{annotation:a.name});
   return;
  }
  if(retainConditionResult(a,file,reviewed))resolvedConditionSpans.push({uri:file.uri,start:a.start,end:a.end,kind:reviewed.kind});
 }
 function retainConditionResult(a,file,reviewed,composition){
  const {kind,queries,references:conditionReferences=[],callbacks=[],expression}=reviewed;
  conditionReportItems+=1+callbacks.length+conditionReferences.length+(composition?.chain.length||0)+(composition?.aliases.length||0)
   +queries.reduce((total,query)=>total+1+(query.names?.length||0),0);
  if(conditions.length>=LIMITS.findings||conditionReportItems>SPRING_CONDITION_LIMITS.reportItems){stopConditionReview(file,a);return false;}
  conditions.push({kind,annotation:a.name,uri:file.uri,range:rangeAt(file.text,a.start,a.end),queries,
   callbackOwners:callbacks.map(callback=>callback.type.fqn),evaluated:false,allOutcomesRetained:true,
   ...(callbacks.length?{callbackFlows:callbacks.map(callback=>({owner:callback.type.fqn,...callback.flow}))}:{}),
   ...(expression?{expression}:{}),...(composition?{composition}:{})});
  for(const {kind,...reference}of conditionReferences)finding(references,kind,file,a.start,a.end,'Conditional input is a potential Spring registration dependency for all deployment outcomes.',reference);
  for(const {type,method}of callbacks)if(!protectedCallbacks.has(type.fqn)){
   protectedCallbacks.add(type.fqn);
   finding(methodContracts,'spring.condition-entrypoint',type.file,method.nameStart,method.nameEnd,
    'Spring may invoke this reviewed Condition callback. Its declaration remains protected.',{name:method.name,owner:type.fqn});
  }
  return true;
 }
 const mark=type=>{resolvedTokenSpans.push({uri:type.file.uri,start:type.start,end:type.end});for(const token of type.tokens){if(token.start>=type.start)break;const semi=type.tokens.findIndex(item=>item.start>token.start&&item.text===';');if(token.text==='import'&&semi>=0&&Object.values(EXTENSIONS).concat('org.springframework.beans.factory.support.BeanDefinitionRegistry').includes(text(type.tokens.slice(type.tokens.indexOf(token)+1,semi))))resolvedTokenSpans.push({uri:type.file.uri,start:token.start,end:type.tokens[semi].end});}};
 const role=a=>ROLE_NAMES.has(a.shortName)&&ROLE_FQNS.has(a.name);
 const boundedMeta=(a,file)=>Object.entries(a.attributes).every(([key,value])=>!/(?:Filter|nameGenerator|scopeResolver|reader)/.test(key)&&(literalStrings(value)!==null||['Import','ComponentScan'].includes(a.shortName)&&classes(value,file)!==null||value.length===1&&(value[0].kind==='number'||['true','false'].includes(value[0].text))));
 const annotationCache=new Map(),visiting=new Set();
 function resolveAnnotation(type,depth=0){if(annotationCache.has(type.fqn))return annotationCache.get(type.fqn);if(depth>LIMITS.depth||visiting.has(type.fqn)||annotations.length>=LIMITS.annotations){complete=false;return null;}visiting.add(type.fqn);let valid=!type.unsupported&&type.kind==='annotation'&&type.members.length<=LIMITS.members,roles=[],aliases=[];for(const a of type.annotations){if(META_NAMES.has(a.name))continue;if(role(a)){roles.push(a.name);if(!boundedMeta(a,type.file))valid=false;}else {const meta=byName.get(a.name),resolved=meta?.kind==='annotation'?resolveAnnotation(meta,depth+1):null;if(!resolved)valid=false;else roles.push(...resolved.roles);}}
  for(const member of type.members.slice(0,LIMITS.members)){if(aliases.length>=LIMITS.findings){complete=false;valid=false;break;}if(member.body||member.parameters.length||!member.defaultTokens.length||member.defaultTokens[0].text!=='default'){valid=false;continue;}const values=literalStrings(member.defaultTokens.slice(1));if(values===null){valid=false;continue;}let alias=null;for(const a of member.annotations){if(a.name!=='org.springframework.core.annotation.AliasFor'){valid=false;continue;}const targetClasses=classes(a.attributes.annotation,type.file),attributes=literalStrings(a.attributes.attribute||a.attributes.value);if(!targetClasses||targetClasses.length!==1||!attributes||attributes.length!==1||!roles.includes(targetClasses[0])||!['value','name','path','initMethod','destroyMethod'].includes(attributes[0])){valid=false;continue;}alias={attribute:member.name,targetAnnotation:targetClasses[0],targetAttribute:attributes[0],defaultValues:values,uri:type.file.uri,range:rangeAt(type.file.text,a.start,a.end)};aliases.push(alias);}if(!alias&&values.some(value=>value!==''))valid=false;}
  visiting.delete(type.fqn);const result=valid&&roles.length?{name:type.fqn,roles:[...new Set(roles)],aliases,uri:type.file.uri,range:rangeAt(type.file.text,type.start,type.end),state:'resolved'}:null;annotationCache.set(type.fqn,result);if(result)annotations.push(result);return result;}
 for(const type of types.filter(type=>type.kind==='annotation'&&!composed.isCandidate(type.fqn)))resolveAnnotation(type);
 for(const type of types){
  if(type.kind==='annotation')continue;
  for(const a of type.annotations){if(role(a)||META_NAMES.has(a.name)||a.name.startsWith('java.lang.')||composed.hasConditionUse(a,type.file))continue;const definition=byName.get(a.name);if(definition?.kind==='annotation'&&!resolveAnnotation(definition))finding(unknowns,'spring.composed-unresolved',type.file,a.start,a.end,'Custom composed annotation attributes/meta-contracts are not fully resolved.',{owner:type.fqn,annotation:a.name});}
  const implemented=[];let inherit=false;for(const part of split(type.header.filter(token=>{if(token.text==='implements'||token.text==='extends'){inherit=true;return false;}return inherit;}))){if(part.length)implemented.push(resolve(text(part),type.file));}
  const extension=Object.entries(EXTENSIONS).find(([,fqn])=>implemented.includes(fqn));if(!extension)continue;
  if(extensions.length>=LIMITS.findings){complete=false;unknown(type,'Spring resolved extension budget exceeded.');continue;}let valid=type.kind==='class'&&type.members.length<=LIMITS.members&&type.final&&!type.unsupported&&new Set(type.members.map(method=>method.name+'('+method.parameters.map(parameter=>parameter.type).join(',')+')')).size===type.members.length&&implemented.length===1&&type.annotations.every(a=>role(a)||a.name==='java.lang.Deprecated'),contracts=[],finiteFlow=null;const pushContract=contract=>{if(contracts.length>=LIMITS.findings){complete=false;valid=false;return false;}contracts.push(contract);return true;};
  const [kind]=extension;for(const method of type.members.slice(0,LIMITS.members)){let methodValid=method.annotations.every(a=>a.name==='java.lang.Override')&&method.head.some(token=>token.text==='public')&&!method.head.some(token=>['static','native','synchronized','abstract'].includes(token.text))&&method.body!==null;const body=method.body||[];
   if(kind==='ImportSelector'){
    const signatureValid=methodValid&&type.members.length===1&&method.name==='selectImports'&&text(method.head.filter(token=>!MODIFIERS.has(token.text)))==='String[]'&&method.parameters.length===1&&method.parameters[0].type==='org.springframework.core.type.AnnotationMetadata';methodValid=signatureValid;
    const prefix=body.slice(0,5).map(token=>token.text).join(' '),values=prefix==='return new String [ ]'&&body[5]?.text==='{'&&body.at(-2)?.text==='}'&&body.at(-1)?.text===';'?literalStrings(body.slice(5,-1)):null;
    methodValid=methodValid&&values!==null&&values.every(value=>/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)&&byName.get(value));if(methodValid)for(const value of values)pushContract({kind:'spring.literal-selector-import',type:value,name:value,uri:type.file.uri,range:rangeAt(type.file.text,body[5].start,body.at(-2).end),message:'Literal ImportSelector source target; the selector is never executed by analysis.'});
    if(!methodValid&&signatureValid){const flow=analyzeFiniteSpringFlow(body,{kind,metadata:method.parameters[0].name,resolveType:name=>resolve(name,type.file),knownType:name=>Boolean(byName.get(name)),knownStringAttribute:(name,key)=>{const declaration=byName.get(name);if(!declaration||declaration.kind!=='annotation'||!resolveAnnotation(declaration))return false;const members=declaration.members.filter(member=>member.name===key);return members.length===1&&members[0].parameters.length===0&&resolve(text(members[0].head.filter(token=>!MODIFIERS.has(token.text))),declaration.file)==='java.lang.String';}});if(flow){finiteFlow=flow;methodValid=true;for(const {start,end,...contract}of flow.contracts)pushContract({...contract,uri:type.file.uri,range:rangeAt(type.file.text,start,end)});}}
   }else if(kind==='BeanPostProcessor'){
    methodValid=methodValid&&['postProcessBeforeInitialization','postProcessAfterInitialization'].includes(method.name)&&text(method.head.filter(token=>!MODIFIERS.has(token.text)))==='Object'&&method.parameters.length===2&&method.parameters[0].type==='java.lang.Object'&&method.parameters[1].type==='java.lang.String'&&text(body)==='return'+method.parameters[0].name+';';
   }else {
    const signatureValid=methodValid&&type.members.length===1&&method.name==='registerBeanDefinitions'&&text(method.head.filter(token=>!MODIFIERS.has(token.text)))==='void'&&method.parameters.length===2&&method.parameters[0].type==='org.springframework.core.type.AnnotationMetadata'&&method.parameters[1].type==='org.springframework.beans.factory.support.BeanDefinitionRegistry';methodValid=signatureValid;
    const statements=split(body,';');if(statements.at(-1)?.length===0)statements.pop();const registry=method.parameters[1]?.name;if(!statements.length)methodValid=false;
    for(const statement of statements){if(contracts.length>=LIMITS.findings){complete=false;methodValid=false;break;}const args=statement[3]?.text==='('?split(statement.slice(4,-1)):null;if(text(statement.slice(0,3))===registry+'.registerBeanDefinition'&&statement.at(-1)?.text===')'&&args?.length===2){const names=literalStrings(args[0]),definition=args[1],classTokens=definition.slice(3,-1),targets=classes(classTokens,type.file),definitionType=resolve(definition[1]?.text||'',type.file);if(names?.length!==1||!names[0]||!/^[A-Za-z_$][\w.$:-]*$/.test(names[0])||definition[0]?.text!=='new'||definition[2]?.text!=='('||definition.at(-1)?.text!==')'||!['org.springframework.beans.factory.support.RootBeanDefinition'].includes(definitionType)||targets?.length!==1||!byName.get(targets[0]))methodValid=false;else pushContract({kind:'spring.literal-bean-registration',name:names[0],type:targets[0],uri:type.file.uri,range:rangeAt(type.file.text,statement[0].start,statement.at(-1).end),message:'Literal registry Bean name and source type; no registry code was executed.'});}else if(text(statement.slice(0,3))===registry+'.registerAlias'&&statement.at(-1)?.text===')'&&args?.length===2){const names=args.map(literalStrings);if(names.some(value=>value?.length!==1||!value[0]||!/^[A-Za-z_$][\w.$:-]*$/.test(value[0])))methodValid=false;else pushContract({kind:'spring.literal-bean-alias',name:names[1][0],target:names[0][0],uri:type.file.uri,range:rangeAt(type.file.text,statement[0].start,statement.at(-1).end),message:'Literal Bean registry alias.'});}else methodValid=false;}
    if(!methodValid&&signatureValid){const flow=analyzeFiniteSpringFlow(body,{kind,metadata:method.parameters[0].name,registry:method.parameters[1].name,resolveType:name=>resolve(name,type.file),knownType:name=>Boolean(byName.get(name)),knownStringAttribute:(name,key)=>{const declaration=byName.get(name);if(!declaration||declaration.kind!=='annotation'||!resolveAnnotation(declaration))return false;const members=declaration.members.filter(member=>member.name===key);return members.length===1&&members[0].parameters.length===0&&resolve(text(members[0].head.filter(token=>!MODIFIERS.has(token.text))),declaration.file)==='java.lang.String';}});if(flow){contracts=[];finiteFlow=flow;methodValid=true;for(const {start,end,...contract}of flow.contracts)pushContract({...contract,uri:type.file.uri,range:rangeAt(type.file.text,start,end)});}}
   }
   valid=valid&&methodValid;if(methodValid)finding(methodContracts,'spring.extension-entrypoint',type.file,method.nameStart,method.nameEnd,'Spring extension method implements a framework callback contract.',{owner:type.fqn,name:method.name});
  }
  if(!type.members.length)valid=valid&&kind==='BeanPostProcessor';
  if(valid){mark(type);extensions.push({kind,owner:type.fqn,uri:type.file.uri,range:rangeAt(type.file.text,type.start,type.end),state:'resolved',behavior:finiteFlow?'finite-all-branches':kind==='BeanPostProcessor'?'identity-only':'literal-only',contracts,...(finiteFlow?{finiteFlow:{...finiteFlow,contracts:undefined}}:{})});references.push(...contracts);}else {unknown(type,'Extension constructor, fields, inheritance, method signature or body exceeds the literal/finite-branch/identity source language; dynamic behavior remains unknown.');}
 }
 // Imports, composed aliases and Bean lifecycle names are retained with spans.
 for(const file of files){const tokens=lexJava(file.text).tokens;
 for(const declaration of nestedConditionDeclarations(tokens,file,topLevelAnnotations.get(file),composed.hasConditionUse)){
  finding(unknowns,'spring.composed-condition-unresolved',file,declaration.start,declaration.end,
   'Nested condition-bearing annotation declarations require a separate source review.',{annotation:declaration.text});
 }
 for(let i=0;i<tokens.length;i++){const a=annotation(tokens,i,file);if(!a)continue;i=a.next-1;retainCondition(a,file);if(a.name==='org.springframework.context.annotation.Import'){const targets=classes(a.attributes.value,file);if(!targets||targets.some(target=>!byName.get(target)))finding(unknowns,'spring.import-unresolved',file,a.start,a.end,'Import targets must be literal reviewed source classes; external/computed import behavior is unknown.');else for(const type of targets)finding(references,'spring.literal-import',file,a.start,a.end,'Explicit source @Import contract.',{type,name:type});}if(a.name==='org.springframework.context.annotation.ImportResource'){const locations=literalStrings(a.attributes.locations||a.attributes.value);if(!locations?.length||a.attributes.reader||!locations.every(location=>/^classpath:/.test(location)&&!/[?*{}\x24#]|(?:^|\/)\.\.(?:\/|\x24)/.test(location)&&sources.some(resource=>{try{return decodeURIComponent(resource.uri).endsWith('/src/main/resources/'+location.slice(10))||decodeURIComponent(resource.uri).endsWith('/src/test/resources/'+location.slice(10));}catch{return false;}})))finding(unknowns,'spring.external-registration-resource',file,a.start,a.end,'External, computed or custom-reader meta-annotation registration resources are outside reviewed membership.');}const custom=annotationCache.get(a.name);if(custom)for(const alias of custom.aliases){const values=literalStrings(a.attributes[alias.attribute])??null;if(values===null)finding(unknowns,'spring.alias-unresolved',file,a.start,a.end,'Composed AliasFor value is computed; its contract is unknown.',{annotation:a.name});else for(const value of values.length?values:alias.defaultValues)if(value)finding(references,'spring.composed-alias',file,a.start,a.end,'Resolved composed annotation alias.',{annotation:a.name,targetAnnotation:alias.targetAnnotation,targetAttribute:alias.targetAttribute,name:value});}if(a.name==='org.springframework.context.annotation.Bean')for(const key of ['initMethod','destroyMethod'])for(const name of literalStrings(a.attributes[key])||[])if(name&&name!=='(inferred)')finding(references,'spring.literal-lifecycle',file,a.start,a.end,'Explicit Bean lifecycle method-name contract.',{name});}}
 if(!complete&&unknowns.length<LIMITS.findings)unknowns.push({kind:'spring.contract-budget',uri:java[0]?.uri,range:{start:{line:0,character:0},end:{line:0,character:0}},message:'Spring extension graph/report budget exceeded; coverage is incomplete.'});
 return report();
}
function inspectSpringMethodContract(report,{uri,owner,name}){const findings=[...report.unknowns,...report.methodContracts.filter(item=>item.uri===uri&&item.name===name&&(!owner||item.owner===owner)),...report.references.filter(item=>item.name===name||item.type===owner&&['spring.literal-bean-registration','spring.finite-bean-registration'].includes(item.kind))];return {allowed:report.complete&&findings.length===0,reason:findings[0]?.message,findings,executedProjectCode:false};}
module.exports={analyzeSpringContracts,inspectSpringMethodContract,SPRING_CONTRACT_LIMITS:LIMITS};
