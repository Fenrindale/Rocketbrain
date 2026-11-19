'use strict';

// A finite source language, not a Java interpreter. Conditions are recorded,
// never selected: every branch contributes its contracts to the result.
const FLOW_LIMITS=Object.freeze({tokens:4096,depth:4,branches:16,constants:16,strings:64,stringCharacters:512,contracts:64,booleanLocals:16,conditionNodes:256,conditionDepth:24,switchArms:16});
const RESERVED=new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var yield record sealed permits'.split(' '));
const spelling=tokens=>tokens.map(token=>token.text).join('');
function close(tokens,start){const pairs={'(':')','{':'}','[':']'},end=pairs[tokens[start]?.text];if(!end)return -1;let depth=0;for(let i=start;i<tokens.length;i++){if(tokens[i].text===tokens[start].text)depth++;else if(tokens[i].text===end&&!--depth)return i;}return -1;}
function parts(tokens){let depth=0,start=0;const result=[];for(let i=0;i<tokens.length;i++){if(['(','{','['].includes(tokens[i].text))depth++;else if([')','}',']'].includes(tokens[i].text))depth--;else if(!depth&&tokens[i].text===','){result.push(tokens.slice(start,i));start=i+1;}}result.push(tokens.slice(start));return result;}
function constantString(tokens,constants){if(!tokens.length)return null;let value='',expect=true;for(const token of tokens){if(expect){const part=token.kind==='string'?token.value:token.kind==='id'&&constants.has(token.text)?constants.get(token.text):null;if(typeof part!=='string')return null;value+=part;if(value.length>FLOW_LIMITS.stringCharacters)return null;}else if(token.text!=='+')return null;expect=!expect;}return expect?null:value;}

function analyzeFiniteSpringFlow(tokens,{kind,metadata,registry,resolveType,knownType,knownStringAttribute=()=>false}){
 if(!Array.isArray(tokens)||tokens.length>FLOW_LIMITS.tokens||!['ImportSelector','ImportBeanDefinitionRegistrar'].includes(kind))return null;
 const contracts=[],conditions=[],constantsSeen=[],booleanLocals=[],predicateExpressions=[],metadataValueReads=[],returnChoices=[],switchStatements=[];let branchCount=0,constantCount=0,stringCount=0,conditionNodes=0,switchArmCount=0,failed=false;
 const add=contract=>{if(contracts.length>=FLOW_LIMITS.contracts){failed=true;return;}contracts.push(contract);};
 const string=(value,constants)=>{const result=constantString(value,constants);if(result===null||++stringCount>FLOW_LIMITS.strings){failed=true;return null;}return result;};
 function classNameReference(name,from,to){if(!name||!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)||!knownType(name))return false;add({kind:'spring.finite-metadata-class-name',type:name,name,start:from,end:to,message:'Reviewed source class name used by finite importing-class metadata logic; its branch is retained without selecting it.'});return !failed;}
 function metadataString(value,start,constants){
  if(value[start]?.text!==metadata||value[start+1]?.text!=='.'||value[start+3]?.text!=='(')return null;const end=close(value,start+3);if(end<0)return null;let read,next=end+1;
  if(value[start+2]?.text==='getClassName'&&end===start+4)read={kind:'metadata-class-name',method:'getClassName'};
  else if(value[start+2]?.text==='getAnnotationAttributes'){
   const annotation=string(value.slice(start+4,end),constants);if(!annotation||value[next]?.text!=='.'||value[next+1]?.text!=='get'||value[next+2]?.text!=='(')return null;const last=close(value,next+2);if(last<0)return null;const attribute=string(value.slice(next+3,last),constants);if(!attribute||!knownStringAttribute(annotation,attribute))return null;add({kind:'spring.finite-metadata-string-attribute',type:annotation,name:attribute,start:value[start].start,end:value[last].end,message:'Reviewed source annotation String attribute read by finite metadata logic; no attribute value is evaluated.'});read={kind:'metadata-string-attribute',method:'getAnnotationAttributes',annotation,attribute,sourceDeclaredString:true,nullableMapPossible:true};next=last+1;
  }else return null;
  const item={...read,start:value[start].start,end:value[next-1].end,evaluated:false};metadataValueReads.push(item);return {read:item,next};
 }
 function predicate(value,constants,booleans,role){
  // Parse only typed boolean syntax over immutable metadata queries/locals.
  // Never evaluate a node, even a literal, or prune short-circuit branches.
  let cursor=0;const depths=new WeakMap();
  const node=(kind,extra)=>{const depth=1+Math.max(0,...[extra.operand,extra.left,extra.right].filter(Boolean).map(value=>depths.get(value)||0));if(++conditionNodes>FLOW_LIMITS.conditionNodes||depth>FLOW_LIMITS.conditionDepth){failed=true;return null;}const result={...extra,kind};depths.set(result,depth);return result;};
  const op=operator=>{for(let i=0;i<operator.length;i++)if(value[cursor+i]?.text!==operator[i]||i&&value[cursor+i-1].end!==value[cursor+i].start)return false;cursor+=operator.length;return true;};
  function primary(depth){
   if(depth>FLOW_LIMITS.conditionDepth)return null;const token=value[cursor];if(!token)return null;
   if(token.text==='('){cursor++;const expression=or(depth+1);if(!expression||value[cursor]?.text!==')')return null;cursor++;return expression;}
   if(['true','false'].includes(token.text)){cursor++;return node('boolean-literal',{value:token.text,evaluated:false});}
   if((token.kind==='string'||token.kind==='id'&&constants.has(token.text))&&value[cursor+1]?.text==='.'&&value[cursor+2]?.text==='equals'&&value[cursor+3]?.text==='('){
    const expected=string([token],constants),end=close(value,cursor+3),query=metadataString(value,cursor+4,constants);if(expected===null||!query||query.next!==end)return null;if(query.read.kind==='metadata-class-name'&&!classNameReference(expected,token.start,token.end))return null;cursor=end+1;conditions.push({...query.read,expected,comparison:'literal-String.equals'});const read=node(query.read.kind,query.read);return read&&node('metadata-string-equality',{expected,right:read,evaluated:false});
   }
   if(token.text===metadata&&value[cursor+1]?.text==='.'&&['isAnnotated','hasAnnotation','hasMetaAnnotation'].includes(value[cursor+2]?.text)&&value[cursor+3]?.text==='('){
    const start=cursor,end=close(value,cursor+3);if(end<0)return null;const name=string(value.slice(cursor+4,end),constants);if(!name||!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name))return null;cursor=end+1;
    const query={kind:'annotation-metadata-presence',method:value[start+2].text,annotation:name,start:token.start,end:value[end].end,evaluated:false};conditions.push(query);return node('metadata-query',query);
   }
   if(token.kind==='id'&&booleans.has(token.text)){cursor++;return node('boolean-local-reference',{name:token.text,declarationStart:booleans.get(token.text).start,evaluated:false});}
   return null;
  }
  function unary(depth){if(depth>FLOW_LIMITS.conditionDepth)return null;if(op('!')){const operand=unary(depth+1);return operand&&node('not',{operand,evaluated:false});}return primary(depth);}
  function equal(depth){let left=unary(depth);if(!left)return null;for(;;){let operator;if(op('=='))operator='==';else if(op('!='))operator='!=';else break;const right=unary(depth);if(!right)return null;left=node('boolean-comparison',{operator,left,right,evaluated:false});if(!left)return null;}return left;}
  function and(depth){let left=equal(depth);if(!left)return null;while(op('&&')){const right=equal(depth);if(!right)return null;left=node('and',{left,right,evaluated:false});if(!left)return null;}return left;}
  function or(depth){let left=and(depth);if(!left)return null;while(op('||')){const right=and(depth);if(!right)return null;left=node('or',{left,right,evaluated:false});if(!left)return null;}return left;}
  if(!value.length)return null;const expression=or(0);if(!expression||cursor!==value.length||failed)return null;
  predicateExpressions.push({role,start:value[0].start,end:value.at(-1).end,expression,evaluated:false});return expression;
 }
 function selectorArray(value,constants){
  if(spelling(value.slice(0,4))!=='newString[]'||value[4]?.text!=='{'||close(value,4)!==value.length-1)return false;
  const members=value.slice(5,-1),expressions=members.length?parts(members):[];
  for(const expression of expressions){const name=string(expression,constants);if(!name||!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)||!knownType(name))return false;add({kind:'spring.finite-selector-import',type:name,name,start:expression[0].start,end:expression.at(-1).end,message:'Source ImportSelector target from an exhaustive finite branch; every branch is retained without executing its condition.'});}return !failed;
 }
 function selectorChoice(value,constants,booleans,depth){
  if(depth>FLOW_LIMITS.depth)return false;while(value[0]?.text==='('&&close(value,0)===value.length-1)value=value.slice(1,-1);let nesting=0,question=-1,colon=-1,choices=0;
  for(let i=0;i<value.length;i++){if(['(','{','['].includes(value[i].text))nesting++;else if([')','}',']'].includes(value[i].text))nesting--;else if(!nesting&&value[i].text==='?'){if(question<0)question=i;choices++;}else if(!nesting&&value[i].text===':'&&!--choices){colon=i;break;}}
  if(question<0)return selectorArray(value,constants);if(colon<0||++branchCount>FLOW_LIMITS.branches||!predicate(value.slice(0,question),constants,booleans,'selector-ternary'))return false;returnChoices.push({kind:'selector-ternary',start:value[0].start,end:value.at(-1).end,evaluated:false,allArmsRetained:true});return selectorChoice(value.slice(question+1,colon),constants,booleans,depth+1)&&selectorChoice(value.slice(colon+1),constants,booleans,depth+1);
 }
 function selector(statement,constants,booleans,depth){return statement[0]?.text==='return'&&selectorChoice(statement.slice(1),constants,booleans,depth);}
 function registrar(statement,constants){
  if(statement[0]?.text!==registry||statement[1]?.text!=='.'||!['registerBeanDefinition','registerAlias'].includes(statement[2]?.text)||statement[3]?.text!=='('||close(statement,3)!==statement.length-1)return false;
  const args=parts(statement.slice(4,-1));if(args.length!==2)return false;
  const name=string(args[0],constants);if(!name||!/^[A-Za-z_$][\w.$:-]*$/.test(name))return false;
  if(statement[2].text==='registerAlias'){const alias=string(args[1],constants);if(!alias||!/^[A-Za-z_$][\w.$:-]*$/.test(alias))return false;add({kind:'spring.finite-bean-alias',name:alias,target:name,start:statement[0].start,end:statement.at(-1).end,message:'Bean alias from the union of all reviewed finite source branches.'});return !failed;}
  const definition=args[1];if(definition[0]?.text!=='new'||definition[2]?.text!=='('||close(definition,2)!==definition.length-1||resolveType(definition[1]?.text)!=='org.springframework.beans.factory.support.RootBeanDefinition')return false;
  const typeTokens=definition.slice(3,-1);if(typeTokens.at(-1)?.text!=='class'||typeTokens.at(-2)?.text!=='.')return false;const nameTokens=typeTokens.slice(0,-2),typeName=spelling(nameTokens);if(!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(typeName))return false;const type=resolveType(typeName);if(!knownType(type))return false;
  add({kind:'spring.finite-bean-registration',name,type,start:statement[0].start,end:statement.at(-1).end,message:'Bean name/source type from the union of all exhaustive finite registration branches.'});return !failed;
 }
 function conditional(body,cursor,constants,booleans,depth){
  if(depth>FLOW_LIMITS.depth||body[cursor+1]?.text!=='(')return null;const conditionEnd=close(body,cursor+1);if(conditionEnd<0||!predicate(body.slice(cursor+2,conditionEnd),constants,booleans,'if')||body[conditionEnd+1]?.text!=='{')return null;
  const thenEnd=close(body,conditionEnd+1);if(thenEnd<0||body[thenEnd+1]?.text!=='else'||++branchCount>FLOW_LIMITS.branches)return null;const elseStart=thenEnd+2,first=block(body.slice(conditionEnd+2,thenEnd),constants,booleans,depth+1);let second,next;
  if(body[elseStart]?.text==='{'){const elseEnd=close(body,elseStart);if(elseEnd<0)return null;second=block(body.slice(elseStart+1,elseEnd),constants,booleans,depth+1);next=elseEnd+1;}
  else if(body[elseStart]?.text==='if'){second=conditional(body,elseStart,constants,booleans,depth+1);next=second?.next;}
  if(!first||!second||kind==='ImportSelector'&&(!first.terminated||!second.terminated))return null;return {terminated:kind==='ImportSelector',actions:first.actions+second.actions,next};
 }
 function switchBlock(body,cursor,constants,booleans,depth){
  if(depth>FLOW_LIMITS.depth||body[cursor+1]?.text!=='(')return null;const conditionEnd=close(body,cursor+1),query=metadataString(body,cursor+2,constants);if(!query||query.next!==conditionEnd||query.read.kind!=='metadata-class-name'||body[conditionEnd+1]?.text!=='{')return null;const end=close(body,conditionEnd+1);if(end<0||++branchCount>FLOW_LIMITS.branches)return null;let index=conditionEnd+2,actions=0,defaultSeen=false,arms=0;const labels=new Set();
  while(index<end){const isDefault=body[index]?.text==='default';if(defaultSeen||!isDefault&&body[index]?.text!=='case')return null;let arrow=index+1;while(arrow<end&&body[arrow].text!=='-')arrow++;if(body[arrow+1]?.text!=='>'||body[arrow].end!==body[arrow+1].start||body[arrow+2]?.text!=='{')return null;
   if(isDefault){if(arrow!==index+1)return null;defaultSeen=true;}else{const label=string(body.slice(index+1,arrow),constants);if(labels.has(label)||!classNameReference(label,body[index+1].start,body[arrow-1].end))return null;labels.add(label);}
   if(++switchArmCount>FLOW_LIMITS.switchArms)return null;const armEnd=close(body,arrow+2);if(armEnd<0||armEnd>=end)return null;const result=block(body.slice(arrow+3,armEnd),constants,booleans,depth+1);if(!result||kind==='ImportSelector'&&!result.terminated)return null;actions+=result.actions;arms++;index=armEnd+1;
  }
  if(!defaultSeen||arms<2)return null;switchStatements.push({kind:'metadata-class-name-switch',start:body[cursor].start,end:body[end].end,arms,defaultRequired:true,fallthrough:false,evaluated:false,allArmsRetained:true});return {terminated:kind==='ImportSelector',actions,next:end+1};
 }
 function block(body,inherited,inheritedBooleans,depth){
  if(depth>FLOW_LIMITS.depth)return null;const constants=new Map(inherited),booleans=new Map(inheritedBooleans);let cursor=0,terminated=false,actions=0;
  while(cursor<body.length){if(terminated)return null;
   if(body[cursor].text==='if'){
    const branches=conditional(body,cursor,constants,booleans,depth);if(!branches)return null;terminated=branches.terminated;actions+=branches.actions;cursor=branches.next;continue;
   }
   if(body[cursor].text==='switch'){const selected=switchBlock(body,cursor,constants,booleans,depth);if(!selected)return null;terminated=selected.terminated;actions+=selected.actions;cursor=selected.next;continue;}
   let end=cursor,nesting=0;while(end<body.length){if(['(','{','['].includes(body[end].text))nesting++;else if([')','}',']'].includes(body[end].text))nesting--;if(body[end].text===';'&&!nesting)break;end++;}if(end>=body.length)return null;
   const statement=body.slice(cursor,end);
   if(spelling(statement.slice(0,2))==='finalString'&&statement[2]?.kind==='id'&&statement[3]?.text==='='){
    const name=statement[2].text;if(RESERVED.has(name)||constants.has(name)||booleans.has(name)||name===metadata||name===registry||++constantCount>FLOW_LIMITS.constants)return null;const value=string(statement.slice(4),constants);if(value===null)return null;constants.set(name,value);constantsSeen.push({name,value,start:statement[0].start,end:statement.at(-1).end});
   }else if(spelling(statement.slice(0,2))==='finalboolean'&&statement[2]?.kind==='id'&&statement[3]?.text==='='){
    const name=statement[2].text;if(RESERVED.has(name)||constants.has(name)||booleans.has(name)||name===metadata||name===registry||booleanLocals.length>=FLOW_LIMITS.booleanLocals)return null;const expression=predicate(statement.slice(4),constants,booleans,'final-boolean');if(!expression)return null;const local={name,start:statement[0].start,end:statement.at(-1).end,expression,evaluated:false};booleans.set(name,local);booleanLocals.push(local);
   }else if(kind==='ImportSelector'){if(!selector(statement,constants,booleans,depth))return null;terminated=true;actions++;}
   else {if(!registrar(statement,constants))return null;actions++;}
   cursor=end+1;
  }
  return {terminated,actions};
 }
 const result=block(tokens,new Map(),new Map(),0);if(!result||failed||!branchCount||!result.actions||kind==='ImportSelector'&&!result.terminated)return null;
 return {contracts,conditions,constants:constantsSeen,booleanLocals,predicateExpressions,metadataValueReads,returnChoices,switchStatements,conditionNodes,branchPoints:branchCount,allBranchesRetained:true,conditionsEvaluated:false,executedProjectCode:false,limits:FLOW_LIMITS};
}

module.exports={analyzeFiniteSpringFlow,SPRING_FLOW_LIMITS:FLOW_LIMITS};
