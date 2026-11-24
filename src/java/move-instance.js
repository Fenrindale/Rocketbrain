'use strict';
const path=require('node:path');
const {parseJavaFile,lexJava}=require('../spring/java'),S=require('./move-scope');
const primitive=new Set(['boolean','byte','short','int','long','char','float','double','String']);
const literal=token=>token&&(['number','string','char'].includes(token.kind)||['true','false'].includes(token.text));
const words=tokens=>tokens.map(token=>token.text).join(' ');
const graphLimits={types:8,depth:4,fields:8,allocations:64};
const maxRebindings=4;
function fieldTokens(model,field){
 const tokens=model.tokens,at=tokens.findIndex(token=>token.start===field.start);let begin=at-1,end=at+1;
 while(begin>=0&&!['{','}',';'].includes(tokens[begin].text))begin--;
 while(end<tokens.length&&tokens[end].text!==';')end++;
 const header=words(tokens.slice(begin+1,at)),isFinal=header==='private final '+field.type.raw;
 if(at<0||!tokens[end]||field.annotations.length||!isFinal&&header!=='private '+field.type.raw)throw Error('Instance Move state requires private fields without annotations or additional modifiers.');
 const initialized=tokens[at+1]?.text==='=',value=initialized?tokens.slice(at+2,end):[];
 if(initialized&&!value.length||!initialized&&end!==at+1)throw Error('Instance Move state requires one explicit literal initializer or a reviewed constructor assignment.');
 return {field,value,isFinal,initialized,typeOffset:tokens[at-1].start,tokens:tokens.slice(begin+1,end+1)};
}
function allocation(tokens,target){
 if(tokens[0]?.text!=='new'||tokens[1]?.text!==target.type.name||tokens[2]?.text!=='('||tokens.at(-1)?.text!==')')return false;
 const values=tokens.slice(3,-1),args=[];for(let i=0;i<values.length;i+=2){if(!literal(values[i])||i+1<values.length&&values[i+1]?.text!==',')return false;args.push(values[i]);}
 return (!values.length||values.length===args.length*2-1)&&(target.constructors.length?target.constructors.some(item=>item.method.parameters.length===args.length):args.length===0);
}
function splitArguments(tokens){
 if(!tokens.length)return [];
 const groups=[];let start=0,depth=0;
 for(const [index,token] of tokens.entries()){
  if(token.text==='(')depth++;
  if(token.text===')'&&--depth<0)return null;
  if(token.text===','&&depth===0){
   if(index===start)return null;
   groups.push(tokens.slice(start,index));start=index+1;
  }
 }
 if(depth||start===tokens.length)return null;
 groups.push(tokens.slice(start));return groups;
}
function resolveReferencePath(tokens,fields,{assigned,complete=false,shadowed=new Set()}={}){
 const qualified=tokens[0]?.text==='this'&&tokens[1]?.text==='.';
 const start=qualified?2:0,name=tokens[start]?.text;
 if(!qualified&&(assigned||shadowed.has(name)))return null;
 const field=fields.find(item=>item.field.name===name&&item.node&&(complete||item.initialized||assigned?.has(name)));
 if(!field)return null;
 let node=field.node;const accessors=[];
 for(let index=start+1;index<tokens.length;index+=4){
  const accessor=tokens[index+1]?.text,member=node.carrier?.accessors.get(accessor);
  if(tokens[index]?.text!=='.'||!member||tokens[index+2]?.text!=='('||tokens[index+3]?.text!==')'||accessors.length===graphLimits.depth)return null;
  accessors.push(accessor);node=node.links.get(member);
 }
 return {field:name,node,accessors,qualified,isFinal:field.isFinal};
}
function referenceValue(tokens,model,target,root,assigned,depth=0){
 const existing=resolveReferencePath(tokens,model.fields,{assigned});
 if(existing)return {...existing,kind:'alias'};
 if(depth>graphLimits.depth||tokens[0]?.text!=='new'||tokens[2]?.text!=='('||tokens.at(-1)?.text!==')')return null;
 const type=tokens[1]?.text,carrier=model.graph?.types.get(type);
 if(++model.referenceAllocations>graphLimits.allocations)throw Error('Instance Move exceeds the reviewed reference allocation limit.');
 if(type===target.type.name&&allocation(tokens,target))return {node:{root,type},kind:'allocation'};
 if(!carrier)return null;
 const args=splitArguments(tokens.slice(3,-1));
 if(!args||args.length!==carrier.parameters.length)return null;
 const inputs=new Map();
 for(const [index,arg] of args.entries()){
  const value=referenceValue(arg,model,target,root+'['+index+']',assigned,depth+1);
  const parameter=carrier.parameters[index];
  if(!value||value.node.type!==parameter.type.raw)return null;
  inputs.set(parameter.name,value.node);
 }
 const links=new Map([...carrier.assignments].map(([field,parameter])=>[field,inputs.get(parameter)]));
 return {node:{root,type,carrier,links},kind:'allocation'};
}
function referenceAssignment(tokens,target,model,field,assigned){
 const value=referenceValue(tokens,model,target,field.name,assigned);
 if(!value||value.node.type!==field.type.raw)return null;
 const reference={field:field.name,root:value.node.root,kind:value.kind,phase:assigned?'constructor':'initializer'};
 if(value.field)reference.from=value.field;
 if(value.accessors?.length)reference.path=value.accessors;
 return {reference,node:value.node};
}
function memberTokens(model,method){
 const tokens=model.tokens,index=tokens.findIndex(token=>token.start===method.start);let begin=index-1;
 while(begin>=0&&!['{','}',';'].includes(tokens[begin].text))begin--;
 let open=index;while(open<tokens.length&&tokens[open].text!=='{')open++;
 let end=open+1;while(end<tokens.length&&tokens[end].text!=='}')end++;
 if(index<0||!tokens[end]||tokens.slice(open+1,end).some(token=>token.text==='{'))throw Error('Instance Move requires a plain concrete method or constructor without nested blocks.');
 return {header:tokens.slice(begin+1,open),body:tokens.slice(open+1,end),all:tokens.slice(begin+1,end+1),open,end,index,begin};
}
function inspectConstructors(model,target){
 const constructors=model.type.methods.filter(method=>method.constructor);
 if(constructors.length>4||new Set(constructors.map(method=>method.parameters.length)).size!==constructors.length)throw Error('Instance Move constructor delegation requires at most four constructors with unique scalar arities; ambiguous overloads are refused.');
 const reviewed=[];
 for(const method of constructors){
  const shape=memberTokens(model,method),parameters=method.parameters,assigned=new Set();
  const expected=['public',model.type.name,'(',...parameters.flatMap((p,i)=>[...(i?[',']:[]),p.type.raw,p.name]),')'].join(' ');
  if(method.annotations.length||parameters.length>8||new Set(parameters.map(p=>p.name)).size!==parameters.length||parameters.some(p=>!primitive.has(p.type.raw)||p.annotations.length)||words(shape.header)!==expected||!shape.body.length)throw Error('Instance Move constructors require public scalar parameters and explicit reviewed field assignments.');
  if(shape.body[0]?.text==='this'&&shape.body[1]?.text==='('){
   if(shape.body.at(-2)?.text!==')'||shape.body.at(-1)?.text!==';')throw Error('Instance Move constructor delegation must be the only statement.');
   const values=shape.body.slice(2,-2),args=[];for(let i=0;i<values.length;i+=2){const token=values[i],parameter=parameters.find(p=>p.name===token.text);if(!literal(token)&&!parameter||i+1<values.length&&values[i+1]?.text!==',')throw Error('Constructor delegation only forwards scalar literals or unchanged parameters, without effects or extra statements.');args.push({token,parameter});}
   if(values.length&&values.length!==args.length*2-1)throw Error('Constructor delegation has an incomplete scalar argument list.');
   reviewed.push({method,...shape,assigned:[],delegation:{arity:args.length,args}});continue;
  }
  let at=0;while(at<shape.body.length){
   const start=at;while(at<shape.body.length&&shape.body[at].text!==';')at++;
   const statement=shape.body.slice(start,at++),name=statement[2]?.text,field=model.fields.find(item=>item.field.name===name),value=statement.slice(4);
   if(statement[0]?.text!=='this'||statement[1]?.text!=='.'||statement[3]?.text!=='='||!field||field.initialized||assigned.has(name)||shape.body[at-1]?.text!==';')throw Error('Instance Move constructor assignments must initialize each blank private field exactly once with an explicit this.field target.');
   const parameter=parameters.find(p=>p.name===value[0]?.text&&p.type.raw===field.field.type.raw);
   if(field.kind!=='literal'){
    const result=referenceAssignment(value,target,model,field.field,assigned);
    if(!result)throw Error('Instance Move constructor reference state requires a reviewed non-null allocation or an exact path through already assigned private references.');
    Object.assign(field,result);
   }else if(value.length!==1||!literal(value[0])&&!parameter)throw Error('Instance Move constructor values require scalar literals/parameters or a non-null target allocation with literal arguments.');
   assigned.add(name);
  }
  for(const field of model.fields)if(!field.initialized&&!assigned.has(field.field.name))throw Error('Instance Move fields require an explicit literal initializer or a complete constructor assignment.');
  reviewed.push({method,...shape,assigned:[...assigned],delegation:null});
 }
 if(reviewed.length&&reviewed.filter(item=>!item.delegation).length!==1)throw Error('Instance Move constructor delegation requires one direct-assignment terminal constructor.');
 for(const item of reviewed){
  let current=item;const seen=new Set();while(current.delegation){if(seen.has(current))throw Error('Cyclic constructor delegation is refused.');seen.add(current);const next=reviewed.find(candidate=>candidate.method.parameters.length===current.delegation.arity);if(!next)throw Error('Constructor delegation must resolve to a reviewed same-owner scalar constructor.');for(const [index,arg]of current.delegation.args.entries())if(arg.parameter&&arg.parameter.type.raw!==next.method.parameters[index].type.raw)throw Error('Constructor delegation cannot change a forwarded scalar parameter type.');current=next;}
 }
 for(const field of model.fields){if(!reviewed.length&&!field.initialized)throw Error('Instance Move fields require an explicit literal initializer or a complete constructor assignment.');if(!field.isFinal&&field.initialized)throw Error('Mutable private fields require a reviewed constructor initializer rather than an unreviewed mutable field initializer.');}
 return reviewed;
}
function ownerModel(text,uri){
 const parsed=parseJavaFile({text,uri}),lex=lexJava(text),type=parsed.types[0];
 if(parsed.issues.length||lex.issues.length||parsed.types.length!==1||type.kind!=='class'||type.superTypes.length||type.annotations.length||lex.tokens.filter(token=>token.text==='class').length!==1||lex.tokens.some(token=>['import','@','extends','implements','super','static','synchronized','volatile','transient'].includes(token.text)))throw Error('Instance Move requires plain final classes without imports, annotations, inheritance or unreviewed source receiver state.');
 const at=lex.tokens.findIndex(token=>token.start===type.start);
 if(words(lex.tokens.slice(at-3,at))!=='public final class'||lex.tokens[at+1]?.text!=='{'||lex.tokens.filter(token=>token.text==='{').length!==type.methods.length+1||type.fields.length>16||type.methods.length>32)throw Error('Instance Move requires public final classes with reviewed constructors and no initializer blocks.');
 if(new Set(type.fields.map(field=>field.name)).size!==type.fields.length)throw Error('Instance Move requires unique immutable field identities.');
 return {parsed,type,tokens:lex.tokens,fields:[],bodyStart:at+2,referenceAllocations:0};
}
function validateOwnerMembers(model){
 const {type,tokens,bodyStart}=model;
 const members=[...model.fields.map(field=>field.tokens),...type.methods.map(method=>memberTokens(model,method).all)];
 const lastClose=tokens.findLastIndex(token=>token.text==='}');
 if(tokens.slice(bodyStart,lastClose).some(token=>!members.some(member=>token.start>=member[0].start&&token.end<=member.at(-1).end)))throw Error('Instance Move requires complete private field and method membership; unmodeled multi-field declarations or initializer effects are refused.');
}
function inspectCarrier(source,targetName,ownerName,resolve){
 const model=ownerModel(source.text,source.uri),{type}=model;
 if(!type.fields.length||type.fields.length>graphLimits.fields)throw Error('Instance Move reference carriers require one to eight final object fields.');
 for(const field of type.fields){
  const shape=fieldTokens(model,field);
  if(!shape.isFinal||shape.initialized||primitive.has(field.type.raw)||field.type.raw===ownerName)throw Error('Instance Move reference carriers require blank private final reviewed object fields.');
  model.fields.push(shape);
 }
 validateOwnerMembers(model);
 const constructors=type.methods.filter(method=>method.constructor);
 const constructor=constructors[0],parameters=constructor?.parameters||[];
 if(constructors.length!==1||!parameters.length||parameters.length>graphLimits.fields||new Set(parameters.map(p=>p.name)).size!==parameters.length)throw Error('Instance Move reference carriers require exactly one reviewed constructor.');
 const shape=memberTokens(model,constructor);
 const header=['public',type.name,'(',...parameters.flatMap((p,index)=>[...(index?[',']:[]),p.type.raw,p.name]),')'].join(' ');
 if(words(shape.header)!==header||parameters.some(p=>p.annotations.length||primitive.has(p.type.raw)))throw Error('Instance Move reference carrier constructors require plain typed object parameters.');
 const assignments=new Map();
 for(let index=0;index<shape.body.length;index+=6){
  const [self,dot,name,equals,param,semicolon]=shape.body.slice(index,index+6).map(token=>token.text);
  const field=model.fields.find(item=>item.field.name===name);
  if(self!=='this'||dot!=='.'||equals!=='='||semicolon!==';'||!field||assignments.has(name)||!parameters.some(p=>p.name===param&&p.type.raw===field.field.type.raw)){
   throw Error('Instance Move reference carrier assignments must bind each field once to an unchanged typed parameter.');
  }
  assignments.set(name,param);
 }
 if(assignments.size!==model.fields.length||new Set(assignments.values()).size!==parameters.length)throw Error('Instance Move reference carrier constructors must bind their complete input and field set.');
 const accessors=new Map();
 for(const method of type.methods){
  if(method.constructor)continue;
  const accessor=memberTokens(model,method);
  const [ret,first,second,third,end]=accessor.body.map(token=>token.text);
  const name=first==='this'&&second==='.'&&end===';'&&accessor.body.length===5?third:accessor.body.length===3&&second===';'?first:null;
  const field=model.fields.find(item=>item.field.name===name&&item.field.type.raw===method.type.raw);
  if(ret!=='return'||!field||accessors.has(method.name)||words(accessor.header)!==`public ${method.type.raw} ${method.name} ( )`){
   throw Error('Instance Move reference carrier accessors must return one exact private final field without effects.');
  }
  accessors.set(method.name,name);
 }
 if(!accessors.size)throw Error('Instance Move reference carriers require a reviewed field accessor.');
 const children=new Set(model.fields.map(item=>item.field.type.raw));
 const depth=1+Math.max(...[...children].map(name=>{
  if(name===targetName)return 0;
  const child=resolve(name);
  if(!child)throw Error('Instance Move reference carrier fields require reviewed same-package source declarations.');
  return child.depth;
 }));
 if(depth>graphLimits.depth)throw Error('Instance Move reference carriers exceed the reviewed nesting limit.');
 const fieldTypes=model.fields.map(field=>({name:field.field.type.raw,offset:field.tokens[2].start}));
 return {name:type.name,fqn:type.fqn,uri:source.uri,parameters,assignments,accessors,depth,fieldTypes};
}
function carrierGraph(sources,owner,target){
 const types=new Map(),active=new Set();
 function resolve(name){
  if(!/^[A-Za-z_$][\w$]*$/.test(name))return null;
  if(types.has(name))return types.get(name);
  if(active.has(name))throw Error('Cyclic reference carriers are outside the Instance Move proof.');
  if(active.size===graphLimits.depth||active.size+types.size>=graphLimits.types)throw Error('Instance Move exceeds the reviewed reference carrier graph limit.');
  const matches=sources.filter(source=>source.uri.endsWith('/'+name+'.java')).filter(source=>{
   const parsed=parseJavaFile(source);
   return parsed.packageName===owner.parsed.packageName&&parsed.types[0]?.name===name;
  });
  if(matches.length>1)throw Error('Instance Move found ambiguous source declarations for a reference carrier.');
  if(!matches.length)return null;
  active.add(name);
  try{
   const carrier=inspectCarrier(matches[0],target.type.name,owner.type.name,resolve);
   types.set(name,carrier);return carrier;
  }finally{active.delete(name);}
 }
 return {types,resolve};
}
function tokensFor(text,uri,{target,role='target',graphSources=[],graph}={}){
 const model=ownerModel(text,uri),{type}=model;
 if(role==='source')model.graph=graph||carrierGraph(graphSources,model,target);
 // Resolve every declared carrier type before reviewing values; constructor
 // expressions can use a carrier that is declared in a later owner field.
 const carriers=new Map();
 if(role==='source')for(const field of type.fields){
  if(!primitive.has(field.type.raw)&&field.type.raw!==target.type.name){
   carriers.set(field.type.raw,model.graph.resolve(field.type.raw));
  }
 }
 for(const field of type.fields){
  const shape=fieldTokens(model,field),isLiteral=primitive.has(field.type.raw)&&(!shape.initialized||shape.value.length===1&&literal(shape.value[0]));
  const referenceEligible=role==='source'&&(field.type.raw===target.type.name||shape.isFinal&&carriers.get(field.type.raw));
  const binding=referenceEligible&&shape.initialized?referenceAssignment(shape.value,target,model,field):null;
  if(!isLiteral&&(!referenceEligible||shape.initialized&&!binding))throw Error('Instance Move fields require scalar state, a reviewed destination reference, or a private final carrier with a reviewed earlier-field path.');
  const kind=isLiteral?'literal':field.type.raw===target.type.name?'target':'carrier';
  model.fields.push({...shape,kind,...binding});
 }
 validateOwnerMembers(model);
 model.constructors=inspectConstructors(model,target);model.constructor=model.constructors.find(item=>!item.delegation)||null;model.mutableState=model.fields.some(field=>!field.isFinal);
 return model;
}
function methodTokens(model,method){
 const shape=memberTokens(model,method);
 if(method.constructor||words(model.tokens.slice(shape.begin+1,shape.index))!=='public '+method.type.raw||!primitive.has(method.type.raw)||method.annotations.length)throw Error('Instance Move supports public primitive/String concrete methods without annotations.');
 return shape;
}
function reviewedTargetMethod(model,method){
 const shape=methodTokens(model,method),body=shape.body,parameters=method.parameters;
 if(parameters.length>1||parameters.some(p=>!primitive.has(p.type.raw)||p.annotations.length)||new Set(parameters.map(p=>p.name)).size!==parameters.length)throw Error('Instance Move target accessors require at most one plain scalar parameter.');
 const plain=body.filter((token,index)=>!(token.text==='this'&&body[index+1]?.text==='.')&&!(token.text==='.'&&body[index-1]?.text==='this'));
 const state=model.fields.find(item=>item.field.name===plain[1]?.text&&item.kind==='literal');
 if(!parameters.length&&plain.length===3&&plain[0].text==='return'&&plain[2].text===';'&&(literal(plain[1])||state&&state.field.type.raw===method.type.raw))return {method,shape,mutates:false};
 const field=model.fields.find(item=>item.field.name===plain[0]?.text&&item.kind==='literal'&&!item.isFinal),operand=plain[4],parameter=parameters[0];
 if(!field||!['int','long'].includes(field.field.type.raw)||method.type.raw!==field.field.type.raw||parameter&&(parameter.type.raw!==field.field.type.raw||model.fields.some(item=>item.field.name===parameter.name))||plain.length!==9||plain[1]?.text!=='='||plain[2]?.text!==field.field.name||!['+','-'].includes(plain[3]?.text)||plain[5]?.text!==';'||plain[6]?.text!=='return'||plain[7]?.text!==field.field.name||plain[8]?.text!==';'||(parameter?operand?.text!==parameter.name:operand?.kind!=='number'))throw Error('Instance Move destination methods must be literal/field getters or reviewed constructor-initialized int/long state updates followed by the exact updated field return.');
 // Qualifiers can only name the reviewed instance itself. A this prefix on a
 // parameter would change binding; the exact field-only spelling is retained.
 for(let i=0;i<body.length;i++)if(body[i].text==='this'&&(body[i+1]?.text!=='.'||body[i+2]?.text!==field.field.name))throw Error('Instance Move state updates cannot qualify parameters or other owners.');
 return {method,shape,mutates:true,field:field.field.name};
}
function reviewedCallArguments(tokens,wrapper,source,parameters,referenceNames){
 const groups=splitArguments(tokens);
 if(!groups||groups.length!==parameters.length)throw Error('Instance Move caller argument arity differs from the selected method.');
 const expected=[],transfers=[],references=[];
 const shadowed=new Set(wrapper.parameters.map(parameter=>parameter.name));
 for(const [index,group]of groups.entries()){
  if(index)expected.push({text:','});
  const explicitField=group.length===3&&group[0].text==='this'&&group[1].text==='.',name=group[explicitField?2:0]?.text,param=!explicitField&&wrapper.parameters.find(p=>p.name===name);
  if(referenceNames.has(parameters[index].name)){
   if(group.length===1&&param?.type.raw===parameters[index].type.raw){
    expected.push({text:name});
    references.push({kind:'external-caller-parameter',name,parameter:index,type:param.type.raw});
    continue;
   }
   const path=resolveReferencePath(group,source.fields,{complete:true,shadowed});
   if(!path||path.node.type!==parameters[index].type.raw)throw Error('Instance Move object arguments must capture the exact private owner reference, a reviewed alias path or an unchanged destination-typed caller parameter.');
   if(shadowed.has(path.field))expected.push(...group.map(token=>({text:token.text})));
   else expected.push({text:path.field,allowThis:true},...group.slice(path.qualified?3:1).map(token=>({text:token.text})));
   // Retain the read itself. The constructor provenance of a mutable field
   // does not identify its value when a wrapper is eventually called.
   const proof={field:path.field,parameter:index,type:path.node.type,...(path.isFinal?{root:path.node.root}:{kind:'mutable-owner-read'})};
   if(path.accessors.length)proof.path=path.accessors;
   references.push(proof);
   continue;
  }
  const field=!param&&source.fields.find(item=>item.field.name===name&&item.kind==='literal');
  if(group.length===1&&literal(group[0])){expected.push({text:group[0].text});continue;}
  if((group.length!==1&&!explicitField)||(!param&&!field))throw Error('Instance Move arguments require a scalar literal, unchanged caller parameter or exact private owner field read.');
  const type=param?param.type.raw:field.field.type.raw;if(type!==parameters[index].type.raw)throw Error('Instance Move scalar state passing requires matching explicit parameter and field types.');
  if(param){expected.push({text:name});transfers.push({kind:'caller-parameter',name,parameter:index,type});}
  else{const shadowed=wrapper.parameters.some(p=>p.name===name);expected.push(...(shadowed?group.map(token=>({text:token.text})):[{text:name,allowThis:true}]));transfers.push({kind:'owner-field',name,parameter:index,type});}
 }
 return {expected,transfers,references};
}
function reviewedRebindingPrefix(body,wrapper,source,target){
 const prefix=[],rebindings=[],shadowed=new Set(wrapper.parameters.map(parameter=>parameter.name));
 let start=0;
 while(start<body.length&&body[start].text!=='return'){
  const end=body.findIndex((token,index)=>index>=start&&token.text===';');
  const statement=end<0?[]:body.slice(start,end+1);
  const [self,dot,name,equals]=statement.map(token=>token.text);
  const field=source.fields.find(item=>item.field.name===name&&item.kind==='target'&&!item.isFinal);
  if(self!=='this'||dot!=='.'||equals!=='='||!field||rebindings.length===maxRebindings){
   throw Error('Instance Move caller prefixes require at most four explicit assignments to reviewed private mutable destination references.');
  }
  const value=statement.slice(4,-1);
  const parameter=value.length===1&&wrapper.parameters.find(item=>item.name===value[0].text&&item.type.raw===target.type.name);
  const path=resolveReferencePath(value,source.fields,{complete:true,shadowed});
  let origin;
  if(parameter)origin={kind:'external-caller-parameter',name:parameter.name};
  else if(path?.node.type===target.type.name)origin={kind:'owner-reference-read',field:path.field,...(path.accessors.length?{path:path.accessors}:{})};
  else if(allocation(value,target))origin={kind:'reviewed-allocation'};
  else if(value.length===1&&value[0].text==='null')origin={kind:'null'};
  else throw Error('Instance Move mutable reference assignments require an exact owner reference read, an unchanged destination-typed caller parameter, null or a reviewed allocation.');
  prefix.push(...statement.map(token=>({text:token.text})));
  rebindings.push({field:name,origin});
  start=end+1;
 }
 return {prefix,rebindings,call:body.slice(start)};
}
function reviewedAccessorEnd(expression,index,getters,scalarNames){
 const accessor=getters.get(expression[index+2]?.text);
 if(expression[index+1]?.text!=='.'||!accessor||expression[index+3]?.text!=='(')throw Error('The target receiver or captured reference may only invoke a reviewed literal getter or constructor-state accessor.');
 const arity=accessor.method.parameters.length,close=index+4+arity;
 if(expression[close]?.text!==')'||arity&&!(literal(expression[index+4])||scalarNames.has(expression[index+4]?.text)))throw Error('Reviewed target accessors require exactly their scalar literal/parameter arguments.');
 return close;
}
function inspectInstanceMove(sourceText,sourceUri,targetText,targetUri,offset,targetParameter,{graphSources=[]}={}){
 const target=tokensFor(targetText,targetUri),source=tokensFor(sourceText,sourceUri,{target,role:'source',graphSources});
 if(source.parsed.packageName!==target.parsed.packageName||!source.parsed.packageName||source.type.name===target.type.name)throw Error('Instance Move currently requires different classes in the same named Java package.');
 const method=source.type.methods.find(candidate=>offset>=candidate.start&&offset<=candidate.end);
 if(!method||method.constructor||new Set(source.type.methods.filter(item=>!item.constructor).map(item=>item.name)).size!==source.type.methods.filter(item=>!item.constructor).length||target.type.methods.some(candidate=>candidate.name===method.name))throw Error('Select a unique non-overloaded instance method and caller names absent from the target.');
 const first=method.parameters[0],parameter=first?.name===targetParameter&&first.type.raw===target.type.name?first:null;
 const field=source.fields.find(shape=>shape.field.name===targetParameter&&shape.kind==='target'&&shape.isFinal);
 if(parameter&&parameter.annotations.length||!parameter&&!field||!parameter&&method.parameters.some(candidate=>candidate.name===targetParameter))throw Error('Instance Move requires an explicit first target parameter or a definitely non-null private final target field.');
 const receiver=parameter?{...parameter,isField:false}:{...field.field,isField:true},parameters=parameter?method.parameters.slice(1):method.parameters;
 const referenceNames=new Set(parameters.filter(candidate=>candidate.type.raw===target.type.name&&!primitive.has(candidate.type.raw)).map(candidate=>candidate.name));
 const scalarNames=new Set(parameters.filter(candidate=>!referenceNames.has(candidate.name)).map(candidate=>candidate.name));
 if(parameters.some(candidate=>!primitive.has(candidate.type.raw)&&!referenceNames.has(candidate.name)||candidate.annotations.length)||referenceNames.size+scalarNames.size!==parameters.length)throw Error('Instance Move requires unique plain scalar parameters or exact destination-typed object captures.');
 const getters=new Map();
 for(const candidate of target.type.methods){
  if(candidate.constructor)continue;
  if(getters.has(candidate.name))throw Error('Instance Move destination methods require unique non-overloaded accessor names.');
  getters.set(candidate.name,reviewedTargetMethod(target,candidate));
 }
 const selected=methodTokens(source,method),expression=selected.body.slice(1,-1);
 if(selected.body[0]?.text!=='return'||selected.body.at(-1)?.text!==';'||!expression.length)throw Error('Instance Move requires one pure return expression.');
 const usedReferences=new Set(),receiverUses=new Set();
 for(let i=0;i<expression.length;i++){
  const token=expression[i];
  if(token.text===receiver.name){receiverUses.add(token.start);i=reviewedAccessorEnd(expression,i,getters,scalarNames);continue;}
  if(referenceNames.has(token.text)){
   usedReferences.add(token.text);
   const right=expression[i+3]?.text;
   if(['=','!'].includes(expression[i+1]?.text)&&expression[i+2]?.text==='='&&(referenceNames.has(right)||right==='null')&&expression[i+4]?.text!=='.'){
    if(right!=='null')usedReferences.add(right);
    i+=3;continue;
   }
   i=reviewedAccessorEnd(expression,i,getters,scalarNames);continue;
  }
  if(token.text==='='&&!['=','!','<','>'].includes(expression[i-1]?.text)&&expression[i+1]?.text!=='='||['+','-'].includes(token.text)&&expression[i+1]?.text===token.text)throw Error('Instance Move return expressions cannot assign or increment parameters; only the reviewed target accessor may mutate state.');
  if(token.kind==='id'&&!scalarNames.has(token.text)&&!['true','false'].includes(token.text)||token.kind==='symbol'&&!['+','-','*','/','%','(',')','?',':','!','<','>','=','&','|','^','~'].includes(token.text)||!['id','symbol','number','string','char'].includes(token.kind))throw Error('Instance Move return expressions cannot use source state, arbitrary calls or effects.');
 }
 if(!receiverUses.size)throw Error('The moved method must actually use its target receiver.');
 if(usedReferences.size!==referenceNames.size)throw Error('Every captured object reference must be used by a reviewed accessor or identity comparison.');
 const calls=[],wrappers=[];
 for(const candidate of source.type.methods){
  if(candidate===method||candidate.constructor)continue;
  const shape=methodTokens(source,candidate);
  if(candidate.parameters.length>8||candidate.parameters.some(p=>!primitive.has(p.type.raw)&&p.type.raw!==target.type.name||p.annotations.length)||new Set(candidate.parameters.map(p=>p.name)).size!==candidate.parameters.length)throw Error('Instance Move callers require plain scalar or exact destination-typed parameters.');
  const {prefix,rebindings,call:body}=reviewedRebindingPrefix(shape.body,candidate,source,target);
  if(body[0]?.text!=='return'||body[1]?.text!==method.name||body[2]?.text!=='('||body.at(-2)?.text!==')'||body.at(-1)?.text!==';')throw Error('Instance Move callers must be source-owner wrappers invoking the method directly with reviewed arguments.');
  let argumentsTokens=body.slice(3,-2);
  let receiverTokens=[];
  if(!receiver.isField){const close=argumentsTokens.findIndex(token=>token.text===')');receiverTokens=argumentsTokens.slice(0,close+1);if(close<0||!allocation(receiverTokens,target))throw Error('Instance Move callers require a new non-null target with reviewed constructor literal arguments.');argumentsTokens=argumentsTokens.slice(close+1);if(parameters.length){if(argumentsTokens[0]?.text!==',')throw Error('Instance Move caller argument arity differs from the selected method.');argumentsTokens=argumentsTokens.slice(1);}}
  const argumentsProof=reviewedCallArguments(argumentsTokens,candidate,source,parameters,referenceNames);
  for(const parameter of candidate.parameters){
   if(primitive.has(parameter.type.raw)){
    if(argumentsProof.transfers.filter(item=>item.kind==='caller-parameter'&&item.name===parameter.name).length!==1)throw Error('Instance Move caller arguments must explicitly forward every scalar caller parameter exactly once.');
   }else if(![...argumentsProof.references,...rebindings.map(item=>item.origin)].some(item=>item.kind==='external-caller-parameter'&&item.name===parameter.name)){
    throw Error('Instance Move requires external references to be explicitly captured or assigned to a reviewed private mutable field.');
   }
  }
  calls.push(body[1].start);wrappers.push({method:candidate,argumentsProof,receiverTokens,prefix,rebindings});
 }
 if(!calls.length)throw Error('Instance Move requires an observed definitely non-null source-owner call.');
 const referenceFields=source.fields.filter(item=>item.reference).map(item=>item.reference);
 const referenceCaptures=wrappers.flatMap(wrapper=>wrapper.argumentsProof.references.map(capture=>({caller:wrapper.method.name,...capture})));
 const mutableReferenceFields=source.fields.filter(item=>item.kind==='target'&&!item.isFinal).map(item=>item.field.name);
 const referenceRebindings=wrappers.flatMap(wrapper=>wrapper.rebindings.map(binding=>({caller:wrapper.method.name,...binding})));
 const callTimeReferences=mutableReferenceFields.length>0||referenceCaptures.some(item=>item.kind==='external-caller-parameter');
 return {source,target,method,receiver,receiverUses,parameters,calls,wrappers,selected,selection:method.start,immutableState:source.fields.length>0||target.fields.length>0,mutableState:source.mutableState||target.mutableState,explicitConstructors:!!(source.constructor||target.constructor),targetAccessors:[...getters.values()],scalarTransfers:wrappers.flatMap(wrapper=>wrapper.argumentsProof.transfers),referenceFields,referenceCaptures,mutableReferenceFields,referenceRebindings,callTimeReferences,constructorDelegations:[...source.constructors,...target.constructors].filter(item=>item.delegation).length};
}
function matchesReviewedTokens(actual,expected){
 let at=0;
 for(const token of expected){
  if(token.allowThis===true&&actual[at]?.text==='this'&&actual[at+1]?.text==='.')at+=2;
  if(actual[at++]?.text!==token.text)return false;
 }
 return at===actual.length;
}
function restoreReceiverEncapsulation(model,sources,entries){
 if(!model.receiver.isField)return {entries,normalization:{receiverVisibilityRestored:false}};
 const source=sources.find(item=>item.uri===model.source.parsed.uri),transformed=S.transformed(sources,entries),after=transformed.find(item=>item.uri===source.uri),parsed=parseJavaFile(after),tokens=lexJava(after.text).tokens,field=parsed.types[0]?.fields.find(item=>item.name===model.receiver.name),before=model.source.fields.find(item=>item.field.name===model.receiver.name);
 if(!source||!field||parsed.issues.length)throw Error('The field-receiver engine result cannot establish its original encapsulation.');
 const at=tokens.findIndex(token=>token.start===field.start);let begin=at-1,end=at+1;while(begin>=0&&!['{','}',';'].includes(tokens[begin].text))begin--;while(end<tokens.length&&tokens[end].text!==';')end++;
 const declaration=tokens.slice(begin+1,end+1),original=words(before.tokens);
 if(words(declaration)===original)return {entries,normalization:{receiverVisibilityRestored:false}};
 if(words(declaration)!==words(before.tokens.slice(1))||tokens[begin+1]?.text!=='final'||before.tokens[0]?.text!=='private')throw Error('The field-receiver engine changed more than the observed private visibility removal.');
 const corrected=after.text.slice(0,tokens[begin+1].start)+'private '+after.text.slice(tokens[begin+1].start),lines=source.text.split('\n'),replace={range:{start:{line:0,character:0},end:{line:lines.length-1,character:lines.at(-1).length}},newText:corrected};
 const normalized=entries.map(entry=>entry.textDocument.uri===source.uri?{...entry,edits:[replace]}:entry);
 return {entries:normalized,normalization:{receiverVisibilityRestored:true,kind:'restore-exact-original-private-final-receiver',field:model.receiver.name,originalDeclaration:original,engineDeclaration:words(declaration),independentCorrection:'private prefix restored before exact state/call/member and before/after compiler validation'}};
}
function inspectStatefulResult(model,sourceText,targetText){
 // Compilation alone does not prove receiver order. Retain the original state
 // and require the engine to perform exactly the bounded reviewed relocation.
 let source,target;try{target=tokensFor(targetText,model.target.parsed.uri);source=tokensFor(sourceText,model.source.parsed.uri,{target,role:'source',graph:model.source.graph});}catch(error){throw Error('The stateful instance Move result has unreviewed Java structure or lifecycle: '+error.message);}
 for(const [before,after]of [[model.source,source],[model.target,target]]){
  if(after.type.fqn!==before.type.fqn||after.type.superTypes.length||after.type.annotations.length||words(after.tokens.filter(token=>['import','@','extends','implements','static','synchronized','volatile','transient'].includes(token.text))))throw Error('The stateful instance Move changed owner identity or lifecycle.');
  if(after.type.fields.length!==before.fields.length)throw Error('The stateful instance Move changed private state field membership.');
  for(const [index,field]of before.fields.entries()){
   const moved=after.fields[index];
   if(moved.field.name!==field.field.name||words(moved.tokens)!==words(field.tokens))throw Error('The stateful instance Move changed a field initializer, declaration order, modifier or ownership.');
  }
  if(before.constructors.length!==after.constructors.length||before.constructors.some((constructor,index)=>words(constructor.all)!==words(after.constructors[index].all)))throw Error('The stateful instance Move changed constructor delegation, parameters, assignment order or initialization behavior.');
 }
 const moved=target.type.methods.find(candidate=>candidate.name===model.method.name);
 if(source.type.methods.some(candidate=>candidate.name===model.method.name)||!moved||target.type.methods.length!==model.target.type.methods.length+1||source.type.methods.length!==model.source.type.methods.length-1||moved.parameters.length!==model.parameters.length||moved.parameters.some((parameter,index)=>parameter.name!==model.parameters[index].name||parameter.type.raw!==model.parameters[index].type.raw)||moved.type.raw!==model.method.type.raw)throw Error('The stateful instance Move must relocate exactly the reviewed method and parameters.');
 const expected=[];for(let i=0;i<model.selected.body.length;i++){
  const token=model.selected.body[i];
  if(model.receiverUses.has(token.start)){expected.push({text:model.selected.body[i+2].text,allowThis:true});i+=2;continue;}
  expected.push({text:token.text});
 }
 if(!matchesReviewedTokens(methodTokens(target,moved).body,expected))throw Error('The stateful instance Move changed the pure return expression, Java field/parameter binding or receiver evaluation.');
 for(const original of model.target.type.methods){if(original.constructor)continue;const current=target.type.methods.find(candidate=>candidate.name===original.name);if(!current||words(methodTokens(target,current).all)!==words(methodTokens(model.target,original).all))throw Error('The stateful instance Move changed an existing destination getter or state update.');}
 for(const wrapper of model.wrappers){
  const current=source.type.methods.find(candidate=>candidate.name===wrapper.method.name);
  if(!current||words(methodTokens(source,current).header)!==words(methodTokens(model.source,wrapper.method).header))throw Error('The stateful instance Move changed source-owner callers.');
  const body=methodTokens(source,current).body;
  if(!matchesReviewedTokens(body.slice(0,wrapper.prefix.length),wrapper.prefix))throw Error('The stateful instance Move changed a reviewed mutable reference assignment or its order.');
  const receiver=model.receiver.isField?(wrapper.method.parameters.some(p=>p.name===model.receiver.name)?
   ['this','.',model.receiver.name].map(text=>({text})):[{text:model.receiver.name,allowThis:true}]):wrapper.receiverTokens.map(token=>({text:token.text}));
  const expected=[{text:'return'},...receiver,{text:'.'},{text:model.method.name},{text:'('},...wrapper.argumentsProof.expected,{text:')'},{text:';'}];
  if(!matchesReviewedTokens(body.slice(wrapper.prefix.length),expected))throw Error('The stateful instance Move changed call evaluation, scalar/reference argument capture or owner-field/parameter binding.');
 }
 const proof={immutableFieldsPreserved:true,ownerOnlyLiteralCallsPreserved:model.scalarTransfers.length===0&&model.referenceCaptures.length===0,returnExpressionPreserved:true,receiverNonNullByFinalInitializer:model.receiver.isField,receiverKind:model.receiver.isField?'field':'parameter'};
 if(model.mutableState||model.explicitConstructors)Object.assign(proof,{mutableFieldsPreserved:true,constructorsPreserved:true,stateUpdateOrderPreserved:true,constructorCount:model.source.constructors.length+model.target.constructors.length,mutableFieldCount:model.source.fields.filter(f=>!f.isFinal).length+model.target.fields.filter(f=>!f.isFinal).length,reviewedMutatorCount:model.targetAccessors.filter(a=>a.mutates).length});
 if(model.scalarTransfers.length||model.constructorDelegations)Object.assign(proof,{ownerOnlyReviewedCallsPreserved:true,scalarStatePassingPreserved:true,ownerFieldIdentityPreserved:true,constructorDelegationPreserved:true,scalarArgumentCaptures:model.scalarTransfers,constructorDelegationCount:model.constructorDelegations});
 if(model.referenceCaptures.length||model.referenceFields.some(field=>field.kind==='alias')){
  const receiverReference=model.receiver.isField?model.referenceFields.find(field=>field.field===model.receiver.name):{kind:'fresh-caller-allocation'};
  Object.assign(proof,{ownerReferenceFieldsPreserved:true,sharedReferenceIdentityPreserved:true,referenceCaptureOrderPreserved:true,receiverReference,referenceFields:model.referenceFields,referenceArgumentCaptures:model.referenceCaptures});
 }
 if(model.callTimeReferences)proof.referenceFlow={
  captureOrderPreserved:true,assignmentsPreserved:true,
  receiverIndependentOfMutableAndExternalReferences:true,
  infersDynamicAliasOrNullability:false,
  mutableFields:model.mutableReferenceFields,rebindings:model.referenceRebindings,
  callTimeCaptures:model.referenceCaptures.filter(item=>item.kind)
 };
 if(model.source.graph.types.size){
  const carrierTypes=[...model.source.graph.types.values()].map(carrier=>({
   type:carrier.fqn,depth:carrier.depth,constructorFields:Object.fromEntries(carrier.assignments),
   accessorFields:Object.fromEntries(carrier.accessors)
  }));
  Object.assign(proof,{nestedReferencePathsPreserved:true,referenceGraph:{
   carrierTypes,maximumCarrierDepth:Math.max(...carrierTypes.map(carrier=>carrier.depth)),
   ownerAllocationCount:model.source.referenceAllocations,
   capturedPaths:model.referenceCaptures.filter(capture=>capture.path)
  }});
 }
 return proof;
}
async function reviewReferenceDefinitions(model,sources,{vscode,send,cancellation}){
 const {source,target}=model,carriers=[...source.graph.types.values()];
 if(!carriers.length&&!model.callTimeReferences)return 0;
 const expected=new Map(carriers.map(carrier=>[carrier.name,carrier.uri]));
 expected.set(target.type.name,target.parsed.uri);
 const ownerTypes=source.fields.filter(field=>field.kind!=='literal')
  .map(field=>({name:field.field.type.raw,offset:field.typeOffset}));
 if(model.callTimeReferences)for(const method of [model.method,...model.wrappers.map(wrapper=>wrapper.method)]){
  for(const parameter of method.parameters){
   if(parameter.type.raw!==target.type.name)continue;
   const index=source.tokens.findIndex(token=>token.start===parameter.start);
   const token=source.tokens[index-1];
   if(token?.text!==target.type.name)throw Error('The reviewed caller parameter does not have an exact destination type token.');
   ownerTypes.push({name:token.text,offset:token.start});
  }
 }
 const origins=[{uri:source.parsed.uri,fieldTypes:ownerTypes},...carriers];
 const checked=new Set();
 for(const origin of origins){
  const input=sources.find(file=>file.uri===origin.uri);
  for(const type of origin.fieldTypes){
   if(checked.has(type.name))continue;
   const prefix=input.text.slice(0,type.offset),line=prefix.split('\n');
   const result=await send('textDocument/definition',{
    textDocument:{uri:origin.uri},position:{line:line.length-1,character:line.at(-1).length}
   },cancellation);
   const locations=Array.isArray(result)?result:result?[result]:[];
   const uri=locations.length===1?vscode.Uri.parse(locations[0]?.targetUri||locations[0]?.uri||''):null;
   if(uri?.scheme!=='file'||S.key(uri.fsPath)!==S.key(vscode.Uri.parse(expected.get(type.name)).fsPath)){
    throw Error('The Java engine did not bind the reviewed reference type to its exact workspace source: '+type.name);
   }
   checked.add(type.name);
  }
 }
 if(checked.size!==expected.size)throw Error('The Java engine did not cover every reviewed reference type definition.');
 return checked.size;
}
async function prepareInstanceMove(deps,document,range,targetDocument,{targetParameter,cancellation}={}){
 const {vscode,send,trusted,refactoring,runtime,synchronizeFiles,memberMoveParameters,protocolOffset}=deps;trusted(cancellation);for(const doc of [document,targetDocument])if(doc?.uri?.scheme!=='file'||doc.languageId!=='java'||doc.isDirty||doc.isClosed)throw Error('Open and save local source and target Java classes before Instance Move.');
 const sourceUri=document.uri.toString(),targetUri=targetDocument.uri.toString(),params=memberMoveParameters(sourceUri,range);
 const text=document.getText(),targetText=targetDocument.getText(),offset=protocolOffset(text,params.range.start);
 const targetType=parseJavaFile({text:targetText,uri:targetUri}).types[0]?.name;
 const usesCarrier=parseJavaFile({text,uri:sourceUri}).types[0]?.fields.some(field=>!primitive.has(field.type.raw)&&field.type.raw!==targetType);
 const inspect=graphSources=>inspectInstanceMove(text,sourceUri,targetText,targetUri,offset,targetParameter,{graphSources});
 const initial=usesCarrier?null:inspect();
 if(synchronizeFiles)await synchronizeFiles([{uri:document.uri.toString(),type:1},{uri:targetDocument.uri.toString(),type:1}]);for(const doc of [document,targetDocument]){const symbols=await send('textDocument/documentSymbol',{textDocument:{uri:doc.uri.toString()}},cancellation);if(!symbols?.length)throw Error('Wait for both instance Move classes to finish importing.');}
 const scope=await S.moveScope(vscode,send,document.uri,targetDocument.uri,cancellation);if(!scope.same)throw Error('Instance Move currently requires the same imported Java project.');const sources=await S.snapshotScope(scope,vscode,trusted,cancellation),guard=S.scopeGuards(scope,sources,vscode,trusted,cancellation);
 if(sources.find(source=>source.uri===sourceUri)?.text!==text||sources.find(source=>source.uri===targetUri)?.text!==targetText)throw Error('The saved owner or destination changed before Instance Move review.');
 const ownerFolder=S.key(path.dirname(document.uri.fsPath));
 const model=initial||inspect(sources.filter(source=>source.file.endsWith('.java')&&source.uri!==sourceUri&&source.uri!==targetUri&&S.key(path.dirname(source.file))===ownerFolder));
 if((usesCarrier||model.callTimeReferences)&&(S.key(scope.source.sourceRoot)!==S.key(scope.target.sourceRoot)||ownerFolder!==S.key(path.dirname(targetDocument.uri.fsPath)))){
  throw Error('Instance Move reference graphs and call-time captures require the same observed source root and package directory as both owners.');
 }
 if(synchronizeFiles&&model.source.graph.types.size){
  const changes=[...model.source.graph.types.values()].map(carrier=>({uri:carrier.uri,type:1}));
  for(let index=0;index<changes.length;index+=2)await synchronizeFiles(changes.slice(index,index+2));
 }
 const reviewDefinitions=()=>reviewReferenceDefinitions(model,sources,{vscode,send,cancellation});
 const referenceDefinitionCount=await reviewDefinitions();
 for(const source of sources){if(source.uri!==document.uri.toString()&&(lexJava(source.text).tokens.some(token=>token.text===model.method.name||['string','char','text-block'].includes(token.kind)&&(token.value===model.method.name||token.kind==='text-block'&&token.text.includes(model.method.name)))||!source.file.endsWith('.java')&&source.text.includes(model.method.name))||/\b(?:Class\s*\.\s*forName|loadClass|ServiceLoader|ClassLoader|getDeclaredMethod|getMethod|MethodHandles|ReflectionUtils)\b/.test(source.text))throw Error('Instance Move cannot preserve external, reflective or effectful selected-method clients.');
 }
 const references=await send('textDocument/references',{textDocument:{uri:document.uri.toString()},position:params.range.start,context:{includeDeclaration:true}},cancellation),expected=new Set([model.selection,...model.calls]);if(!Array.isArray(references)||references.length!==expected.size)throw Error('The instance Move reference model does not match all reviewed declaration/call positions.');for(const reference of references){if(S.key(vscode.Uri.parse(reference.uri).fsPath)!==S.key(document.uri.fsPath)||!expected.delete(protocolOffset(text,reference.range?.start)))throw Error('Instance Move found a caller outside its definitely non-null pure owner scope.');}if(expected.size)throw Error('Instance Move reference coverage is incomplete.');
 const destinations=await send('java/getMoveDestinations',{moveKind:'moveInstanceMethod',params},cancellation);if(destinations?.errorMessage)throw Error(destinations.errorMessage);const matches=destinations?.destinations?.filter(item=>item?.name===targetParameter&&item.type===model.target.type.name&&item.isField===model.receiver.isField&&typeof item.bindingKey==='string');if(matches?.length!==1)throw Error('The Java engine did not offer the exact reviewed instance receiver binding.');guard();
 const response=await send('java/move',{moveKind:'moveInstanceMethod',params,destination:{...matches[0]},updateReferences:true},cancellation);if(response?.errorMessage||response?.confirmationToken)throw Error('The Java engine requires a separate instance Move conflict review: '+(response.errorMessage||'confirmation'));
 const reviewedEntries=S.textEntries(response?.edit,sources);
 if(reviewedEntries.length!==2||reviewedEntries.some(entry=>entry.textDocument.uri!==sourceUri&&entry.textDocument.uri!==targetUri))throw Error('The Java engine must edit exactly the two reviewed instance owners. Carrier and client sources must remain unchanged.');
 const normalized=restoreReceiverEncapsulation(model,sources,reviewedEntries),entries=normalized.entries,after=S.transformed(sources,entries);
 for(const [uri,count]of [[sourceUri,0],[targetUri,1]])if(parseJavaFile({uri,text:after.find(source=>source.uri===uri).text}).types.flatMap(type=>type.methods).filter(method=>method.name===model.method.name).length!==count)throw Error('The Java engine did not move exactly the selected instance declaration.');
 const statefulContract=inspectStatefulResult(model,after.find(source=>source.uri===document.uri.toString()).text,after.find(source=>source.uri===targetDocument.uri.toString()).text),immutableState=model.immutableState&&!model.mutableState?statefulContract:null;
 for(const proof of [statefulContract.referenceGraph,statefulContract.referenceFlow])if(proof)proof.reviewedJavaSourceBindings=referenceDefinitionCount;
 const compiled=await S.validateCompilation(scope,sources,entries,null,runtime,cancellation),preApply=()=>{guard();compiled.validate();};preApply();const plan=await refactoring.previewWorkspaceEdit({documentChanges:entries},{title:'Move '+model.method.name+' to '+model.target.type.name,kind:'refactor.move.instanceMethod',anchorDocument:document,cancellation,guards:sources.map(source=>({uri:source.uri})),validate:async()=>{await S.validateScope(scope,vscode,send,document.uri,targetDocument.uri,cancellation);preApply();await reviewDefinitions();preApply();},preApply,warnings:['Saved source-owner calls may capture destination references through final carrier paths, reviewed mutable owner fields and exact destination-typed caller parameters. The receiver stays independently non-null. Field ownership, assignment and capture order, bounded constructor delegation and reviewed target updates are preserved.']});
 return {...plan,memberMove:{kind:'instance-method',member:model.method.name,source:model.source.type.fqn,destination:model.target.type.fqn,targetParameter,receiverKind:model.receiver.isField?'field':'parameter',immutableState,statefulContract,normalization:normalized.normalization,reviewedCalls:model.calls.length,reviewedFiles:sources.length,semantic:compiled.report,scope:'Final same-package owners with a fresh first target parameter or a private final target field. Reviewed wrapper assignments and call-time field reads and captures retain runtime references. Acyclic final carriers support allocation and getter paths up to four layers. Scalar captures, constructor delegation, shared identity, capture order and reviewed target updates are preserved.'}};
}
module.exports={inspectInstanceMove,inspectStatefulResult,restoreReceiverEncapsulation,prepareInstanceMove};
