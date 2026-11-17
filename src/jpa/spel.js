'use strict';
const {parseJavaFile,rangeAt,literal,lexJava}=require('../spring/java');
const typeCache=new WeakMap(),tokenCache=new WeakMap();
const NUMERIC=['java.lang.Byte','java.lang.Short','java.lang.Integer','java.lang.Long','java.math.BigInteger','java.lang.Float','java.lang.Double','java.math.BigDecimal'];
const boxed=name=>({byte:'java.lang.Byte',short:'java.lang.Short',int:'java.lang.Integer',long:'java.lang.Long',float:'java.lang.Float',double:'java.lang.Double',boolean:'java.lang.Boolean',char:'java.lang.Character',String:'java.lang.String',Integer:'java.lang.Integer',Long:'java.lang.Long',Boolean:'java.lang.Boolean'}[name]||name);
const typed=(javaType,extra={})=>({javaType:boxed(javaType),nullable:!['byte','short','int','long','float','double','boolean','char'].includes(javaType),...extra});
const unresolved=reason=>typed(null,{state:'unknown',reason});
function indexes(model,file){if(model&&typeCache.has(model))return typeCache.get(model);const files=(model?.files||[file]).filter(f=>f.uri?.endsWith('.java')).map(f=>f.types?f:parseJavaFile(f));if(!files.some(f=>f.uri===file.uri))files.push(file);const types=new Map();for(const f of files)for(const t of f.types||[]){if(!types.has(t.fqn))types.set(t.fqn,[]);types.get(t.fqn).push({type:t,file:f});}const result={files,types};if(model)typeCache.set(model,result);return result;}
function fromRef(ref,file,index){if(!ref)return unresolved('Declared Java type is unavailable.');const raw=ref.raw?.replace(/<.*>/,'').replace(/\[\]/g,'').trim();let name=ref.name;
  if(raw&&boxed(raw)!==raw)name=boxed(raw);else if(raw&&['byte','short','int','long','float','double','boolean','char'].includes(raw))name=boxed(raw);
  else if(raw&&!raw.includes('.')&&!file?.imports?.[raw]&&index?.types.has(file?.packageName+'.'+raw))name=file.packageName+'.'+raw;
  return typed(name+(ref.array?'[]':''),{arguments:(ref.arguments||[]).map(r=>fromRef(r,file,index))});}
function publicMember(member,file,type){let tokens=tokenCache.get(file);if(!tokens){tokens=lexJava(file.text).tokens;tokenCache.set(file,tokens);}const at=tokens.findIndex(t=>t.start===member.start);let start=at-1;while(start>=0&&![';','{','}'].includes(tokens[start].text))start--;const header=tokens.slice(start+1,at).map(t=>t.text);return !header.includes('private')&&!header.includes('protected')&&(header.includes('public')||type.kind==='interface');}
function lex(text){const tokens=[];let i=0;while(i<text.length){if(/\s/.test(text[i])){i++;continue;}const start=i,c=text[i];if(c==="'"||c==='"'){i++;let value='',closed=false;while(i<text.length){if(text[i]===c){if(text[i+1]===c){value+=c;i+=2;}else{i++;closed=true;break;}}else value+=text[i++];}if(!closed)throw Error('Unterminated SpEL string literal.');tokens.push({kind:'string',text:text.slice(start,i),value,start,end:i});continue;}if(/[\p{L}_$]/u.test(c)){i++;while(/[\p{L}\p{N}_$]/u.test(text[i]||''))i++;tokens.push({kind:'id',text:text.slice(start,i),start,end:i});continue;}if(/[0-9]/.test(c)){i++;while(/[0-9.]/.test(text[i]||''))i++;if(/[lLfFdD]/.test(text[i]||''))i++;tokens.push({kind:'number',text:text.slice(start,i),start,end:i});continue;}const pair=text.slice(i,i+2);if(['?.','?:','==','!=','<=','>=','&&','||'].includes(pair)){i+=2;tokens.push({kind:'symbol',text:pair,start,end:i});}else{tokens.push({kind:'symbol',text:c,start,end:++i});}}return tokens;}

function analyzeExpression(text,context={},base=0,decoded){
  const file=context.file,method=context.method,model=context.model,index=indexes(model,file),params=method?.parameters||[],variables=new Map();
  for(const p of params){const ann=p.annotations?.find(a=>a.shortName==='Param'&&(a.name==='org.springframework.data.repository.query.Param'||file.imports?.Param==='org.springframework.data.repository.query.Param'||file.wildcards?.includes('org.springframework.data.repository.query')));const name=literal(ann,'value',p.name);if(name)variables.set(name,fromRef(p.type,file,index));}
  const diagnostics=[],reasons=[];let tokens,at=0,steps=0;
  const rawFiles=new Map((model?.files||[file]).map(f=>[f.uri,f]));
  function location(start,end){const a=base+start,b=base+Math.max(start+1,end),uri=decoded?.sourceUris?.[a]||file.uri;const source=rawFiles.get(uri)||file;const first=decoded?.map?.[a]??a,last=decoded?.ends?.[b-1]??first;return{uri,range:rangeAt(source.text,first,last)};}
  function problem(token,message,code='jpa.spel.unknown',severity='information'){diagnostics.push({...location(token.start,token.end),code,severity,message});if(severity==='information')reasons.push(message);return unresolved(message);}
  function numeric(a,b){return typed(NUMERIC[Math.max(2,NUMERIC.indexOf(a.javaType),NUMERIC.indexOf(b.javaType))]);}
  function common(a,b){if(!a?.javaType||!b?.javaType)return unresolved(a?.reason||b?.reason||'SpEL branch type is unresolved.');if(a.javaType==='null')return{...b,nullable:true};if(b.javaType==='null')return{...a,nullable:true};if(a.javaType===b.javaType)return{...a,nullable:a.nullable||b.nullable};if(NUMERIC.includes(a.javaType)&&NUMERIC.includes(b.javaType))return numeric(a,b);return unresolved('SpEL branch types do not have a proven common declared type.');}
  function property(owner,token,safe){if(!owner.javaType)return owner;if(['class','classLoader','declaringClass','metaClass'].includes(token.text))return problem(token,'Reflection properties are outside the restricted SpEL subset.');
    if(owner.javaType.endsWith('[]')&&token.text==='length')return typed('int');
    const choices=index.types.get(owner.javaType)||[];if(choices.length!==1)return problem(token,'SpEL property type is external or ambiguous: '+owner.javaType+'.'+token.text);
    let current=choices[0],seen=new Set();while(current&&!seen.has(current.type.fqn)){seen.add(current.type.fqn);const field=current.type.fields.find(f=>f.name===token.text&&publicMember(f,current.file,current.type)),cap=token.text[0].toUpperCase()+token.text.slice(1),getter=current.type.methods.find(m=>{if(m.parameters.length||!publicMember(m,current.file,current.type))return false;return m.type?.raw!=='void'&&["get"+cap,token.text].includes(m.name)||m.name==='is'+cap&&boxed(m.type?.raw)==='java.lang.Boolean';});
      if(field||getter)return{...fromRef((getter||field).type,current.file,index),nullable:safe||owner.nullable||fromRef((getter||field).type,current.file,index).nullable};
      const parent=current.type.superTypes[0],parents=index.types.get(parent)||[];current=parents.length===1?parents[0]:null;
    }
    return problem(token,'SpEL property '+token.text+' is not declared on '+owner.javaType+'.','jpa.spel.property.missing','warning');
  }
  function indexed(owner,key,token){if(owner.javaType==='__method_args'){if(key.constant===undefined||!Number.isInteger(key.constant)||key.constant<0||key.constant>=params.length)return problem(token,'SpEL method argument index is unavailable or out of range.','jpa.spel.index','warning');return fromRef(params[key.constant].type,file,index);}
    if(owner.javaType?.endsWith('[]')){if(!NUMERIC.includes(key.javaType))return problem(token,'A Java array requires a numeric SpEL index.','jpa.spel.type','warning');return typed(owner.javaType.slice(0,-2));}
    if(['java.util.List','java.util.Collection','java.util.Set'].includes(owner.javaType)){if(!NUMERIC.includes(key.javaType))return problem(token,'A collection requires a numeric SpEL index.','jpa.spel.type','warning');return owner.arguments?.[0]||unresolved('Collection element type is not declared.');}
    if(owner.javaType==='java.util.Map')return owner.arguments?.[1]||unresolved('Map value type is not declared.');return problem(token,'SpEL indexing is outside the known array/collection/map subset.');
  }
  function stringMethod(owner,name,args,safe){
    const signatures={toLowerCase:{arities:[0],result:'java.lang.String'},toUpperCase:{arities:[0],result:'java.lang.String'},trim:{arities:[0],result:'java.lang.String'},length:{arities:[0],result:'int'},isEmpty:{arities:[0],result:'boolean'},substring:{arities:[1,2],arguments:['java.lang.Byte','java.lang.Short','java.lang.Integer'],result:'java.lang.String'}};
    const signature=owner.javaType==='java.lang.String'&&signatures[name.text];if(!signature)return problem(name,'Only an exact java.lang.String signature from the restricted whitelist is inferred; arbitrary methods are not executed.');
    if(!signature.arities.includes(args.length))return problem(name,'SpEL String.'+name.text+' has an unsupported argument count.','jpa.spel.method.signature','warning');
    if(args.some(arg=>!arg.javaType||signature.arguments&&!signature.arguments.includes(arg.javaType)))return problem(name,'SpEL String.'+name.text+' requires declared int-compatible arguments.','jpa.spel.method.signature','warning');
    return typed(signature.result,{nullable:safe,signatureOnly:true});
  }
  const prec={'or':1,'||':1,'and':2,'&&':2,'==':3,'!=':3,'eq':3,'ne':3,'<':4,'>':4,'<=':4,'>=':4,'lt':4,'gt':4,'le':4,'ge':4,'+':5,'-':5,'*':6,'/':6,'%':6};
  try{tokens=lex(text);if(tokens.length>512)throw Error('SpEL token limit exceeded.');
    function primary(depth){if(++steps>2048||depth>24)throw Error('SpEL expression complexity limit exceeded.');const token=tokens[at++];if(!token)throw Error('Incomplete SpEL expression.');let out;
      if(token.text==='('){out=expression(0,depth+1);if(tokens[at++]?.text!==')')throw Error('Unbalanced SpEL parentheses.');}
      else if(token.kind==='string')out=typed('java.lang.String',{constant:token.value});
      else if(token.kind==='number'){if(!/^\d+(?:\.\d+)?[lLfFdD]?$/.test(token.text))throw Error('Unsupported SpEL number literal.');const n=Number(token.text.replace(/[lLfFdD]$/,'')),kind=/[fF]$/.test(token.text)?'java.lang.Float':/[dD.]|\d\./.test(token.text)?'java.lang.Double':/[lL]$/.test(token.text)?'java.lang.Long':'java.lang.Integer';if(!Number.isFinite(n)||kind==='java.lang.Integer'&&n>2147483647||kind==='java.lang.Long'&&!Number.isSafeInteger(n))throw Error('SpEL number literal exceeds the supported bound.');out=typed(kind,{constant:n});}
      else if(token.text==='true'||token.text==='false')out=typed('boolean',{constant:token.text==='true'});else if(token.text==='null')out=typed('null',{constant:null});
      else if(['!','not','-','+'].includes(token.text)){out=primary(depth+1);if(['!','not'].includes(token.text)&&out.javaType!=='java.lang.Boolean')out=problem(token,'Logical negation requires a Boolean SpEL value.','jpa.spel.type','warning');else if(['-','+'].includes(token.text)){out=NUMERIC.includes(out.javaType)?numeric(out,out):problem(token,'Numeric unary operator requires a number.','jpa.spel.type','warning');}}
      else if(token.text==='#'){const name=tokens[at++];if(name?.kind!=='id')throw Error('Expected a SpEL variable name.');if(name.text==='root')out=typed('__method_args');else if(variables.has(name.text))out=variables.get(name.text);else if(name.text==='args'){out=typed('__method_args');reasons.push('The #args alias requires a runtime evaluation-context binding that is not inferred.');}else out=problem(name,'SpEL variable is not a declared repository parameter: #'+name.text);}
      else if(token.text==='['){const key=expression(0,depth+1);if(tokens[at++]?.text!==']')throw Error('Unbalanced SpEL argument index.');out=indexed(typed('__method_args'),key,token);}
      else {if(['@','T','new'].includes(token.text))return problem(token,'Bean lookup, type references and object construction are not evaluated by restricted SpEL analysis.');out=problem(token,'Unsupported SpEL root or operation: '+token.text);}
      while(at<tokens.length){const next=tokens[at];if(['.','?.'].includes(next.text)){at++;const name=tokens[at++];if(name?.kind!=='id')throw Error('Expected a SpEL property name.');if(tokens[at]?.text==='('){at++;const args=[];if(tokens[at]?.text!==')')for(;;){args.push(expression(0,depth+1));if(tokens[at]?.text!==',')break;at++;}if(tokens[at++]?.text!==')')throw Error('Unbalanced SpEL method arguments.');out=stringMethod(out,name,args,next.text==='?.');}else out=property(out,name,next.text==='?.');}
        else if(next.text==='['){at++;const key=expression(0,depth+1);if(tokens[at++]?.text!==']')throw Error('Unbalanced SpEL property index.');out=indexed(out,key,next);}else break;
      }return out;
    }
    function expression(min,depth){let out=primary(depth);while(at<tokens.length){const token=tokens[at],level=prec[token.text];if(level===undefined||level<min)break;at++;const right=expression(level+1,depth+1),a=out.javaType,b=right.javaType;
        if(!a||!b){out=unresolved(out.reason||right.reason);continue;}
        if(['or','||','and','&&'].includes(token.text)){out=a==='java.lang.Boolean'&&b==='java.lang.Boolean'?typed('boolean'):problem(token,'Boolean SpEL operators require Boolean operands.','jpa.spel.type','warning');}
        else if(['==','!=','eq','ne','<','>','<=','>=','lt','gt','le','ge'].includes(token.text)){const compatible=a==='null'||b==='null'||a===b||NUMERIC.includes(a)&&NUMERIC.includes(b);out=compatible?typed('boolean'):problem(token,'SpEL comparison operands have incompatible declared types.','jpa.spel.type','warning');}
        else if(token.text==='+'&&(a==='java.lang.String'||b==='java.lang.String'))out=typed('java.lang.String');
        else out=NUMERIC.includes(a)&&NUMERIC.includes(b)?numeric(out,right):problem(token,'SpEL arithmetic requires compatible numeric operands.','jpa.spel.type','warning');
      }
      if(min===0&&tokens[at]?.text==='?:'){at++;out=common(out,expression(0,depth+1));}
      else if(min===0&&tokens[at]?.text==='?'){const condition=out;at++;const yes=expression(0,depth+1);if(tokens[at++]?.text!==':')throw Error('Incomplete SpEL ternary expression.');const no=expression(0,depth+1);out=condition.javaType==='java.lang.Boolean'?common(yes,no):unresolved('SpEL ternary condition is not a known Boolean type.');}
      return out;
    }
    const result=expression(0,0);if(at!==tokens.length)reasons.push('Unsupported trailing SpEL syntax, invocation or side effect.');if(!result.javaType)reasons.push(result.reason||'SpEL result type is unresolved.');
    return{...result,state:reasons.length||diagnostics.some(d=>d.severity==='warning')?'unknown':'known',diagnostics,unknownReasons:[...new Set(reasons)]};
  }catch(error){const token=tokens?.[Math.min(at,tokens.length-1)]||{start:0,end:text.length};problem(token,error.message);return{...unresolved(error.message),diagnostics,unknownReasons:[...new Set(reasons)]};}
}

function resolveSpel(decoded,context={}){
  if(!decoded||typeof decoded.text!=='string')return decoded;const text=decoded.text,file=context.file;let cursor=0,out='',map=[],ends=[],sourceUris=[],count=0,queryQuote=null,nextParameter=0;const symbolicParameters=[],diagnostics=[],unknownReasons=[],reservedNames=new Set([...text.matchAll(/[:?]([\p{L}_$][\p{L}\p{N}_$]*)/gu)].map(m=>m[1]));
  const append=(start,end,replacement)=>{if(replacement===undefined){out+=text.slice(start,end);map.push(...decoded.map.slice(start,end));ends.push(...decoded.ends.slice(start,end));sourceUris.push(...(decoded.sourceUris||decoded.map.map(()=>file.uri)).slice(start,end));}else{out+=replacement;map.push(...Array(replacement.length).fill(decoded.map[start]));ends.push(...Array(replacement.length).fill(decoded.ends[end-1]));sourceUris.push(...Array(replacement.length).fill(decoded.sourceUris?.[start]||file.uri));}};
  while(cursor<text.length){let at=cursor;for(;at<text.length;at++){const c=text[at];if(queryQuote){if(c===queryQuote){if(text[at+1]===queryQuote)at++;else queryQuote=null;}continue;}if(c==="'"||c==='"'){queryQuote=c;continue;}if(text.startsWith('#{',at))break;}if(at>=text.length){append(cursor,text.length);break;}if(++count>32){unknownReasons.push('SpEL fragment count limit exceeded.');append(cursor,text.length);break;}
    let end=at+2,depth=1,quote=null;for(;end<text.length;end++){const c=text[end];if(quote){if(c===quote){if(text[end+1]===quote)end++;else quote=null;}}else if(c==="'"||c==='"')quote=c;else if(c==='{')depth++;else if(c==='}'&&!--depth)break;}
    if(depth){unknownReasons.push('Unterminated SpEL query fragment.');append(cursor,text.length);break;}
    const body=text.slice(at+2,end),prefix=text[at-1],start=[':', '?'].includes(prefix)?at-1:at;append(cursor,start);
    if(![':', '?'].includes(prefix)) {
      if(body.trim()==='#entityName'&&typeof context.entityName==='string'&&/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(context.entityName))append(start,end+1,context.entityName);
      else{unknownReasons.push('Only a known #entityName is substituted as an inline query template.');append(start,end+1);}
    } else {
      const result=analyzeExpression(body,context,at+2,decoded);let name;do{name='rb_spel_'+nextParameter++;}while(reservedNames.has(name));reservedNames.add(name);const uri=decoded.sourceUris?.[start]||file.uri,source=(context.model?.files||[]).find(f=>f.uri===uri)||file;
      const range=rangeAt(source.text,decoded.map[start]??start,decoded.ends[end]??end+1);
      symbolicParameters.push({name,expression:body,javaType:result.javaType,state:result.state,source:'spel',uri,range,nullable:result.nullable,originalPrefix:prefix,executed:false});diagnostics.push(...result.diagnostics);unknownReasons.push(...result.unknownReasons);append(start,end+1,':'+name);
    }
    cursor=end+1;
  }
  return{...decoded,text:out,map,ends,sourceUris,symbolicParameters,diagnostics,unknownReasons:[...new Set([...(decoded.unknownReasons||[]),...unknownReasons])],spelResolved:true,syntheticParameterNames:symbolicParameters.map(p=>p.name),executedUserCode:false};
}
module.exports={resolveSpel,analyzeExpression};
