'use strict';

// A finite source language, not a Java interpreter. Conditions are recorded,
// never selected: every branch contributes its contracts to the result.
const FLOW_LIMITS=Object.freeze({tokens:4096,depth:4,branches:16,constants:16,strings:64,stringCharacters:512,contracts:64});
const spelling=tokens=>tokens.map(token=>token.text).join('');
function close(tokens,start){const pairs={'(':')','{':'}','[':']'},end=pairs[tokens[start]?.text];if(!end)return -1;let depth=0;for(let i=start;i<tokens.length;i++){if(tokens[i].text===tokens[start].text)depth++;else if(tokens[i].text===end&&!--depth)return i;}return -1;}
function parts(tokens){let depth=0,start=0;const result=[];for(let i=0;i<tokens.length;i++){if(['(','{','['].includes(tokens[i].text))depth++;else if([')','}',']'].includes(tokens[i].text))depth--;else if(!depth&&tokens[i].text===','){result.push(tokens.slice(start,i));start=i+1;}}result.push(tokens.slice(start));return result;}
function constantString(tokens,constants){if(!tokens.length)return null;let value='',expect=true;for(const token of tokens){if(expect){const part=token.kind==='string'?token.value:token.kind==='id'&&constants.has(token.text)?constants.get(token.text):null;if(typeof part!=='string')return null;value+=part;if(value.length>FLOW_LIMITS.stringCharacters)return null;}else if(token.text!=='+')return null;expect=!expect;}return expect?null:value;}

function analyzeFiniteSpringFlow(tokens,{kind,metadata,registry,resolveType,knownType}){
 if(!Array.isArray(tokens)||tokens.length>FLOW_LIMITS.tokens||!['ImportSelector','ImportBeanDefinitionRegistrar'].includes(kind))return null;
 const contracts=[],conditions=[],constantsSeen=[];let branchCount=0,constantCount=0,stringCount=0,failed=false;
 const add=contract=>{if(contracts.length>=FLOW_LIMITS.contracts){failed=true;return;}contracts.push(contract);};
 const string=(value,constants)=>{const result=constantString(value,constants);if(result===null||++stringCount>FLOW_LIMITS.strings){failed=true;return null;}return result;};
 function predicate(value,constants){
  // This exact framework query reads the immutable importing-class metadata.
  // Unknown calls, runtime properties, expressions and negations are refused.
  if(value[0]?.text!==metadata||value[1]?.text!=='.'||value[2]?.text!=='isAnnotated'||value[3]?.text!=='('||close(value,3)!==value.length-1)return false;
  const name=string(value.slice(4,-1),constants);if(!name||!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name))return false;
  conditions.push({kind:'annotation-metadata-presence',annotation:name,start:value[0].start,end:value.at(-1).end,evaluated:false});return true;
 }
 function selector(statement,constants){
  if(spelling(statement.slice(0,5))!=='returnnewString[]'||statement[5]?.text!=='{'||close(statement,5)!==statement.length-1)return false;
  const members=statement.slice(6,-1),expressions=members.length?parts(members):[];
  for(const expression of expressions){const name=string(expression,constants);if(!name||!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)||!knownType(name))return false;add({kind:'spring.finite-selector-import',type:name,name,start:expression[0].start,end:expression.at(-1).end,message:'Source ImportSelector target from an exhaustive finite branch; every branch is retained without executing its condition.'});}return !failed;
 }
 function registrar(statement,constants){
  if(statement[0]?.text!==registry||statement[1]?.text!=='.'||!['registerBeanDefinition','registerAlias'].includes(statement[2]?.text)||statement[3]?.text!=='('||close(statement,3)!==statement.length-1)return false;
  const args=parts(statement.slice(4,-1));if(args.length!==2)return false;
  const name=string(args[0],constants);if(!name||!/^[A-Za-z_$][\w.$:-]*$/.test(name))return false;
  if(statement[2].text==='registerAlias'){const alias=string(args[1],constants);if(!alias||!/^[A-Za-z_$][\w.$:-]*$/.test(alias))return false;add({kind:'spring.finite-bean-alias',name:alias,target:name,start:statement[0].start,end:statement.at(-1).end,message:'Bean alias from the union of all reviewed finite source branches.'});return !failed;}
  const definition=args[1];if(definition[0]?.text!=='new'||definition[2]?.text!=='('||close(definition,2)!==definition.length-1||resolveType(definition[1]?.text)!=='org.springframework.beans.factory.support.RootBeanDefinition')return false;
  const typeTokens=definition.slice(3,-1);if(typeTokens.at(-1)?.text!=='class'||typeTokens.at(-2)?.text!=='.')return false;const nameTokens=typeTokens.slice(0,-2),typeName=spelling(nameTokens);if(!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(typeName))return false;const type=resolveType(typeName);if(!knownType(type))return false;
  add({kind:'spring.finite-bean-registration',name,type,start:statement[0].start,end:statement.at(-1).end,message:'Bean name/source type from the union of all exhaustive finite registration branches.'});return !failed;
 }
 function block(body,inherited,depth){
  if(depth>FLOW_LIMITS.depth)return null;const constants=new Map(inherited);let cursor=0,terminated=false,actions=0;
  while(cursor<body.length){if(terminated)return null;
   if(body[cursor].text==='if'){
    if(body[cursor+1]?.text!=='(')return null;const conditionEnd=close(body,cursor+1);if(conditionEnd<0||!predicate(body.slice(cursor+2,conditionEnd),constants)||body[conditionEnd+1]?.text!=='{')return null;
    const thenEnd=close(body,conditionEnd+1),elseOpen=thenEnd+2;if(thenEnd<0||body[thenEnd+1]?.text!=='else'||body[elseOpen]?.text!=='{')return null;const elseEnd=close(body,elseOpen);if(elseEnd<0||++branchCount>FLOW_LIMITS.branches)return null;
    const first=block(body.slice(conditionEnd+2,thenEnd),constants,depth+1),second=block(body.slice(elseOpen+1,elseEnd),constants,depth+1);if(!first||!second||kind==='ImportSelector'&&(!first.terminated||!second.terminated))return null;terminated=kind==='ImportSelector';actions+=first.actions+second.actions;cursor=elseEnd+1;continue;
   }
   let end=cursor,nesting=0;while(end<body.length){if(['(','{','['].includes(body[end].text))nesting++;else if([')','}',']'].includes(body[end].text))nesting--;if(body[end].text===';'&&!nesting)break;end++;}if(end>=body.length)return null;
   const statement=body.slice(cursor,end);
   if(spelling(statement.slice(0,2))==='finalString'&&statement[2]?.kind==='id'&&statement[3]?.text==='='){
    const name=statement[2].text;if(constants.has(name)||name===metadata||name===registry||++constantCount>FLOW_LIMITS.constants)return null;const value=string(statement.slice(4),constants);if(value===null)return null;constants.set(name,value);constantsSeen.push({name,value,start:statement[0].start,end:statement.at(-1).end});
   }else if(kind==='ImportSelector'){if(!selector(statement,constants))return null;terminated=true;actions++;}
   else {if(!registrar(statement,constants))return null;actions++;}
   cursor=end+1;
  }
  return {terminated,actions};
 }
 const result=block(tokens,new Map(),0);if(!result||failed||!branchCount||!result.actions||kind==='ImportSelector'&&!result.terminated)return null;
 return {contracts,conditions,constants:constantsSeen,branchPoints:branchCount,allBranchesRetained:true,conditionsEvaluated:false,executedProjectCode:false,limits:FLOW_LIMITS};
}

module.exports={analyzeFiniteSpringFlow,SPRING_FLOW_LIMITS:FLOW_LIMITS};
