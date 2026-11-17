'use strict';
const { parseJavaFile, lexJava } = require('../spring/java');

// This interpreter evaluates a deliberately small Java expression language. It
// never loads a class, invokes Java, evaluates JavaScript, or reads environment.
const NS='org.hibernate.boot.model.naming.';
const STANDARD=NS+'PhysicalNamingStrategyStandardImpl';
const SNAKE=NS+'CamelCaseToUnderscoresNamingStrategy';
const SNAKE_CURRENT=NS+'PhysicalNamingStrategySnakeCaseImpl';
const IMPLICIT=NS+'ImplicitNamingStrategyJpaCompliantImpl';
const KNOWN=new Set([STANDARD,SNAKE,SNAKE_CURRENT,IMPLICIT,NS+'PhysicalNamingStrategy',NS+'ImplicitNamingStrategy']);
class Unknown extends Error {}
const fail=message=>{throw new Unknown(message);};
const ident=(text,quoted=false)=>({kind:'identifier',text,quoted});
const symbol=name=>({kind:'symbol',name});
const valueObject=(kind,data)=>({kind,...data});
const snake=text=>text.replaceAll('.','_').replace(/([a-z0-9])([A-Z])(?=[a-z0-9])/g,'$1_$2').toLowerCase();
function unquote(name) {
  if(typeof name!=='string')return null;
  const m=name[0],quoted=name.length>2&&['"','`','['].includes(m)&&name.at(-1)===(m==='['?']':m);
  return ident(quoted?name.slice(1,-1):name,quoted);
}
function boundedString(text) {if(typeof text!=='string'||text.length>4096||text.includes('\0'))fail('Identifier/string exceeds the supported bounds.');return text;}
function tokensFor(text) {
  const scanned=lexJava(text);if(scanned.issues.length)fail('Strategy Java lexer limitation: '+scanned.issues.join('; '));
  const merged=[];
  for(let i=0;i<scanned.tokens.length;i++) {
    const token=scanned.tokens[i],next=scanned.tokens[i+1];
    if(next&&['==','!=','&&','||','<=','>='].includes(token.text+next.text)&&token.end===next.start){merged.push({...token,text:token.text+next.text,end:next.end});i++;}
    else merged.push(token);
  }
  return merged;
}
function close(tokens,index) {const begin=tokens[index]?.text,end={'(':')','{':'}','[':']'}[begin];let depth=0;for(let i=index;i<tokens.length;i++){if(tokens[i].text===begin)depth++;if(tokens[i].text===end&&!--depth)return i;}return -1;}
class Parser {
  constructor(tokens){this.tokens=tokens;this.i=0;}
  peek(t){return this.tokens[this.i]?.text===t;}
  take(t){if(!this.peek(t))fail('Unsupported Java naming expression near '+(this.tokens[this.i]?.text||'<end>')+'.');return this.tokens[this.i++];}
  expr(min=0){
    let left;
    const token=this.tokens[this.i++];if(!token)fail('Incomplete naming expression.');
    if(token.text==='('){left=this.expr();this.take(')');}
    else if(token.text==='!')left={op:'!',value:this.expr(8)};
    else if(['string','char'].includes(token.kind)){if(token.value===null||/\\(?![btnfr"'\\])/.test(token.text))fail('Unsupported Java string escape in naming strategy.');left={literal:token.value};}
    else if(token.kind==='number'&&/^\d+$/.test(token.text)&&Number(token.text)<=2147483647)left={literal:Number(token.text)};
    else if(['null','true','false'].includes(token.text))left={literal:{null:null,true:true,false:false}[token.text]};
    else if(token.kind==='id')left={id:token.text};
    else fail('Unsupported naming expression token '+token.text+'.');
    while(this.i<this.tokens.length){
      if(this.peek('.')){this.i++;const name=this.tokens[this.i++];if(name?.kind!=='id')fail('Invalid naming member access.');left={member:left,name:name.text};continue;}
      if(this.peek('(')){this.i++;const args=[];if(!this.peek(')')){do{if(args.length)this.take(',');args.push(this.expr());}while(this.peek(','));}this.take(')');left={call:left,args};continue;}
      const op=this.tokens[this.i]?.text,precedence={'||':1,'&&':2,'==':3,'!=':3,'<':4,'>':4,'<=':4,'>=':4,'+':5}[op];
      if(precedence===undefined||precedence<min)break;this.i++;left={op,left,right:this.expr(precedence+1)};
    }
    if(min===0&&this.peek('?')){this.i++;const yes=this.expr();this.take(':');left={condition:left,yes,no:this.expr()};}
    return left;
  }
  expression(tokens){const parser=new Parser(tokens),out=parser.expr();if(parser.i!==tokens.length)fail('Unsupported trailing naming expression.');return out;}
  statement(){
    if(this.peek('{')){this.i++;const body=[];while(!this.peek('}')){if(this.i>=this.tokens.length)fail('Unclosed naming block.');body.push(this.statement());}this.i++;return {block:body};}
    if(this.peek('if')){this.i++;this.take('(');const condition=this.expr();this.take(')');const yes=this.statement();let no;if(this.peek('else')){this.i++;no=this.statement();}return {if:condition,yes,no};}
    if(this.peek('return')){this.i++;const value=this.expr();this.take(';');return {return:value};}
    if(this.peek(';')){this.i++;return {block:[]};}
    const start=this.i;let depth=0;
    while(this.i<this.tokens.length){const t=this.tokens[this.i].text;if(!depth&&t===';')break;if(['(','['].includes(t))depth++;else if([')',']'].includes(t))depth--;this.i++;}
    const part=this.tokens.slice(start,this.i);this.take(';');
    const equals=part.findIndex(t=>t.text==='=');
    if(equals>0&&part[equals-1].kind==='id'&&part.slice(0,equals).every(t=>t.kind==='id'||t.text==='.')) {
      const name=part[equals-1].text,declared=equals>1;
      if(declared&&!['String','Identifier','boolean','int','long','var','java.lang.String',NS+'Identifier'].includes(part.slice(0,equals-1).filter(t=>t.text!=='final').map(t=>t.text).join('')))fail('Naming variables require a supported local type; field writes are excluded.');
      return {assign:name,declared,value:this.expression(part.slice(equals+1))};
    }
    // Calls whose value is discarded may have side effects and are never run.
    fail('Only local variable assignment, if and return statements are supported.');
  }
  body(){const out=[];while(this.i<this.tokens.length)out.push(this.statement());return {block:out};}
}
function compileFiles(files){
  const types=[];
  for(const input of files){let file;try{file=input.types?input:parseJavaFile(input);file={...file,tokens:tokensFor(file.text)};}catch(error){continue;}
    for(const type of file.types)types.push({type,file,methods:new Map(),constants:new Map()});
  }
  function resolve(raw,file){
    if(KNOWN.has(raw))return raw;
    const short=raw.split('.').at(-1);if(types.some(value=>value.type.fqn===raw))return raw;
    if(file.imports[short]&&(raw===file.imports[short]||raw===(file.packageName?file.packageName+'.':'')+short))return file.imports[short];
    if(raw===(file.packageName?file.packageName+'.':'')+short&&file.wildcards.includes(NS.slice(0,-1))&&KNOWN.has(NS+short))return NS+short;
    return raw;
  }
  for(const record of types){
    const {file,type}=record;record.parent=type.superTypes.length?resolve(type.superTypes[0],file):null;
    for(const method of type.methods.filter(m=>!m.constructor)){
      const index=file.tokens.findIndex(t=>t.start===method.start);let p=index;while(p<file.tokens.length&&file.tokens[p].text!=='(')p++;
      const endParams=close(file.tokens,p),start=endParams+1;let end=-1,ast,error;
      if(file.tokens[start]?.text==='{')end=close(file.tokens,start);
      try{if(end<0)fail('Method body is unavailable or declares unsupported throws.');ast=new Parser(file.tokens.slice(start+1,end)).body();}catch(e){error=e.message;}
      let begin=index;while(begin>0&&![';','{','}'].includes(file.tokens[begin-1].text))begin--;
      const modifiers=file.tokens.slice(begin,index).map(t=>t.text);
      const current=record.methods.get(method.name)||[];current.push({record,method,ast,error,lexicalDispatch:modifiers.includes('private')||modifiers.includes('static')});record.methods.set(method.name,current);
    }
    for(const field of type.fields){
      const index=file.tokens.findIndex(t=>t.start===field.start);let begin=index;while(begin>0&&![';','{','}'].includes(file.tokens[begin-1].text))begin--;
      let end=index;while(end<file.tokens.length&&file.tokens[end].text!==';')end++;
      const declaration=file.tokens.slice(begin,end),eq=declaration.findIndex(t=>t.text==='=');
      if(eq<0||!declaration.some(t=>t.text==='static')||!declaration.some(t=>t.text==='final'))continue;
      try{record.constants.set(field.name,new Parser([]).expression(declaration.slice(eq+1)));}catch(e){/* Nonconstant fields remain unavailable. */}
    }
  }
  return types;
}
function createNamingResolver(files,config={},fallback='unknown'){
  const types=compileFiles(files),profile=config.profile;
  const find=fqn=>{const found=types.filter(t=>t.type.fqn===fqn);return found.length===1?found[0]:null;};
  const lookup=(fqn,name,depth=0)=>{if(depth>12)fail('Naming inheritance is cyclic or too deep.');const rec=find(fqn);if(!rec)return {builtin:fqn};const list=rec.methods.get(name);if(list?.length)return list.length===1?list[0]:fail('Overloaded naming helper is ambiguous.');return rec.parent?lookup(rec.parent,name,depth+1):{builtin:null};};
  function evaluate(ast,env,frame){
    if(++frame.budget.steps>2000)fail('Naming evaluation step limit reached.');
    if(Object.hasOwn(ast,'literal'))return ast.literal;
    if(ast.id){if(env.has(ast.id))return env.get(ast.id);if(ast.id==='this')return valueObject('self',{fqn:frame.receiver||frame.fqn,lexical:frame.fqn});if(ast.id==='super')return valueObject('self',{fqn:find(frame.fqn)?.parent});
      let rec=find(frame.fqn),depth=0;while(rec&&depth++<12){if(rec.constants.has(ast.id)){const guard=rec.type.fqn+'.'+ast.id;if(frame.budget.constants.has(guard))fail('Cyclic naming constant.');frame.budget.constants.add(guard);try{return evaluate(rec.constants.get(ast.id),new Map(),{...frame,fqn:rec.type.fqn});}finally{frame.budget.constants.delete(guard);}}rec=find(rec.parent);}
      const file=find(frame.fqn)?.file,local=(file?.packageName?file.packageName+'.':'')+ast.id;
      if(find(local))return symbol(local);
      if(file?.imports[ast.id])return symbol(file.imports[ast.id]);
      if(ast.id==='Identifier'&&file?.wildcards.includes(NS.slice(0,-1)))return symbol(NS+'Identifier');
      if(ast.id==='Locale'&&file?.wildcards.includes('java.util'))return symbol('java.util.Locale');
      return symbol(ast.id);}
    if(ast.member){const object=evaluate(ast.member,env,frame);if(object?.kind==='symbol')return symbol(object.name+'.'+ast.name);return valueObject('member',{object,name:ast.name});}
    if(ast.call){const fn=evaluate(ast.call,env,frame),args=ast.args.map(a=>evaluate(a,env,frame));
      if(fn?.kind==='symbol'){
        if(fn.name===NS+'Identifier.toIdentifier'){
          if(args[0]===null)return null;if(typeof args[0]!=='string'||args.length<1||args.length>2||args.length===2&&typeof args[1]!=='boolean')fail('Identifier.toIdentifier requires a string and optional boolean.');
          const id=unquote(boundedString(args[0]).replace(/^[\x09-\x0d\x1c-\x20]+|[\x09-\x0d\x1c-\x20]+$/g,''));if(!id.text)return null;
          if(!id.quoted&&!args[1]&&/[^\x00-\x7f]/.test(id.text))fail('Non-ASCII Identifier autoquoting is outside the verified Java character subset.');
          return ident(id.text,Boolean(args[1])||id.quoted||!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(id.text));
        }
        if(!fn.name.includes('.')){const lexical=lookup(frame.fqn,fn.name);return invoke(lexical.lexicalDispatch?lexical.record.type.fqn:frame.receiver||frame.fqn,fn.name,args,frame);}
        fail('External/static Java call is outside the safe naming subset: '+fn.name);
      }
      if(fn?.kind!=='member')fail('Unsupported naming call target.');
      const {object,name}=fn;
      if(object?.kind==='self'){const lexical=object.lexical?lookup(object.lexical,name):null;return invoke(lexical?.lexicalDispatch?lexical.record.type.fqn:object.fqn,name,args,frame);}
      if(object?.kind==='identifier'&&args.length===0){if(name==='getText')return object.text;if(name==='isQuoted')return object.quoted;if(name==='quoted')return ident(object.text,true);}
      if(object?.kind==='source'){
        if(args.length)fail('Implicit naming source access must have no arguments.');const context=object.context;
        if(name==='getEntityNaming'||name==='getOwningEntityNaming')return valueObject('entityNaming',{context});
        if(['getAttributePath','getIdentifierAttributePath','getOwningAttributePath'].includes(name))return valueObject('attributePath',{context});
        if(name==='getBuildingContext')return valueObject('buildingContext',{});
      }
      if(object?.kind==='entityNaming'&&args.length===0){if(name==='getJpaEntityName'||name==='getEntityName')return object.context.entityName;if(name==='getClassName')return object.context.entityClassName;}
      if(object?.kind==='attributePath'&&args.length===0){if(name==='getProperty')return object.context.propertyPath?.split('.').at(-1);if(name==='getFullPath')return object.context.propertyPath;}
      if(typeof object==='string'){
        if(['toLowerCase','toUpperCase'].includes(name)&&args.length===1&&args[0]?.kind==='symbol'&&args[0].name==='java.util.Locale.ROOT'){
          if(/[^\x00-\x7f]/.test(object))fail('Non-ASCII Java case mapping is not assumed equivalent to this runtime.');
          return boundedString(name==='toLowerCase'?object.toLowerCase():object.toUpperCase());
        }
        if(name==='concat'&&args.length===1&&typeof args[0]==='string')return boundedString(object+args[0]);
        if(name==='replace'&&args.length===2&&args.every(a=>typeof a==='string')&&args[0].length)return boundedString(object.split(args[0]).join(args[1]));
        if(name==='replaceAll'&&args.length===2&&args.every(a=>typeof a==='string')){
          // No caller-controlled regex engine: only these fixed camel-case rules.
          if(args[0]==='([a-z0-9])([A-Z])'&&args[1]==='$1_$2')return boundedString(object.replace(/([a-z0-9])([A-Z])/g,'$1_$2'));
          if(args[0]==='([a-z])([A-Z])'&&args[1]==='$1_$2')return boundedString(object.replace(/([a-z])([A-Z])/g,'$1_$2'));
          if(args[0]==='([A-Z])([A-Z][a-z])'&&args[1]==='$1_$2')return boundedString(object.replace(/([A-Z])([A-Z][a-z])/g,'$1_$2'));
          fail('Only fixed documented camel-case replaceAll patterns are supported.');
        }
        if(['startsWith','endsWith','contains','equals'].includes(name)&&args.length===1&&typeof args[0]==='string')return {startsWith:()=>object.startsWith(args[0]),endsWith:()=>object.endsWith(args[0]),contains:()=>object.includes(args[0]),equals:()=>object===args[0]}[name]();
        if(name==='length'&&args.length===0)return object.length;
        if(name==='substring'&&args.length>=1&&args.length<=2&&args.every(Number.isInteger)&&args[0]>=0&&args[0]<=object.length&&(args.length===1||args[1]>=args[0]&&args[1]<=object.length))return object.slice(...args);
        if(name==='trim'&&args.length===0)return object.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g,'');
      }
      fail('Unsupported naming method or argument types: '+name);
    }
    if(ast.condition){const condition=evaluate(ast.condition,env,frame);if(typeof condition!=='boolean')fail('Naming condition is not known boolean.');return evaluate(condition?ast.yes:ast.no,env,frame);}
    if(ast.op==='!'){const value=evaluate(ast.value,env,frame);if(typeof value!=='boolean')fail('Naming negation requires boolean.');return !value;}
    const left=evaluate(ast.left,env,frame);
    if(['&&','||'].includes(ast.op)){if(typeof left!=='boolean')fail('Naming branch is not known.');if(ast.op==='&&'&&!left||ast.op==='||'&&left)return left;const right=evaluate(ast.right,env,frame);if(typeof right!=='boolean')fail('Naming branch is not known.');return right;}
    const right=evaluate(ast.right,env,frame);
    if(ast.op==='+'&&(['string','number'].includes(typeof left)&&['string','number'].includes(typeof right))&&(typeof left==='string'||typeof right==='string'))return boundedString(String(left)+right);
    if(['==','!='].includes(ast.op)&&![left,right].some(v=>v?.kind==='symbol')&&(left===null||right===null||typeof left==='boolean'&&typeof right==='boolean'||typeof left==='number'&&typeof right==='number'||left?.kind==='identifier'&&right?.kind==='identifier'))return ast.op==='=='?left===right:left!==right;
    if(['<','>','<=','>='].includes(ast.op)&&typeof left==='number'&&typeof right==='number')return {'<':left<right,'>':left>right,'<=':left<=right,'>=':left>=right}[ast.op];
    fail('Unsupported naming binary operation.');
  }
  function execute(statement,env,frame){
    if(++frame.budget.steps>2000)fail('Naming evaluation step limit reached.');
    if(statement.block){for(const child of statement.block){const result=execute(child,env,frame);if(result)return result;}return null;}
    if(statement.if){const condition=evaluate(statement.if,env,frame);if(typeof condition!=='boolean')fail('Naming condition is not known.');return condition?execute(statement.yes,env,frame):statement.no?execute(statement.no,env,frame):null;}
    if(Object.hasOwn(statement,'return'))return {value:evaluate(statement.return,env,frame)};
    if(statement.assign){if(!statement.declared&&!env.has(statement.assign))fail('Naming assignment may not mutate fields.');env.set(statement.assign,evaluate(statement.value,env,frame));return null;}
    fail('Unsupported naming statement.');
  }
  function invoke(fqn,name,args,previous){
    if(previous.depth>=12)fail('Naming helper recursion/depth limit reached.');
    const selected=lookup(fqn,name),frame={...previous,fqn,depth:previous.depth+1};
    if(selected.builtin){
      if(selected.builtin===STANDARD&&/^toPhysical(?:Table|Column|Schema|Catalog|Sequence)Name$/.test(name))return args[0];
      if([SNAKE,SNAKE_CURRENT].includes(selected.builtin)){
        const a=args[0];if(a===null)return null;
        if(/^toPhysical(?:Table|Column|Schema|Catalog|Sequence)Name$/.test(name))return invoke(previous.receiver||fqn,a.quoted?'quotedIdentifier':'unquotedIdentifier',args.slice(0,1),frame);
        if(name==='quotedIdentifier')return a;
        if(name==='unquotedIdentifier'){if(/[^\x00-\x7f]/.test(a.text))fail('Non-ASCII built-in case mapping is outside the verified subset.');return ident(snake(a.text),false);}
      }
      if(selected.builtin===IMPLICIT&&name==='toIdentifier'&&typeof args[0]==='string')return unquote(args[0]);
      fail('Naming superclass/method is not modeled: '+(selected.builtin||fqn)+'.'+name);
    }
    if(selected.error)fail(selected.error);if(!selected.ast||selected.method.parameters.length!==args.length)fail('Naming method unavailable or arity mismatch: '+name);
    const env=new Map(selected.method.parameters.map((p,i)=>[p.name,args[i]]));
    const result=execute(selected.ast,env,{...frame,fqn:selected.record.type.fqn,receiver:previous.receiver||fqn});if(!result)fail('Naming method has no proven return.');return result.value;
  }
  function run(fqn,name,args){return invoke(fqn,name,args,{fqn,depth:0,budget:{steps:0,constants:new Set()}});}
  function profiled(name,kind){
    if(!profile)return null;
    if(!['table','column'].includes(kind))return {error:'Explicit mapping profiles cover tables and columns; namespace mappings are unavailable.'};
    if(!['explicit','observed'].includes(profile.source))return {error:'Naming profile requires an explicit or observed provenance.'};
    const map=profile[kind==='table'?'tables':'columns'];if(!map||typeof map!=='object'||Array.isArray(map)||!Object.hasOwn(map,name))return {error:'This identifier is absent from the configured naming profile.'};
    const value=map[name];if(typeof value!=='string'||!value||value.length>256||/[\x00-\x1f]/.test(value))return {error:'Naming profile identifier is invalid.'};
    return {value:unquote(value),source:'mapping-profile:'+profile.source};
  }
  function implicit(name,kind,context={}){
    if(context.explicit!==false||!config.implicit)return {name,certainty:'configured'};
    const method=context.implicitMethod||(kind==='table'?'determinePrimaryTableName':'determineBasicColumnName');
    try{
      const selected=lookup(config.implicit,method);
      if(selected.builtin===IMPLICIT){
        if(method==='determinePrimaryKeyJoinColumnName')return {name,certainty:'configured',namingSource:config.implicit};
        const hook=kind==='table'?'transformEntityName':'transformAttributePath',custom=lookup(config.implicit,hook);
        if(!['determinePrimaryTableName','determineBasicColumnName','determineIdentifierColumnName'].includes(method)&&(!custom.builtin||!lookup(config.implicit,'transformEntityName').builtin))fail('The inherited implicit callback needs additional source context for custom transformation hooks.');
        if(!custom.builtin){const input=valueObject(kind==='table'?'entityNaming':'attributePath',{context});const value=run(config.implicit,hook,[input]);if(typeof value!=='string')fail('Implicit transformation did not return String.');return {name:value,certainty:'configured',namingSource:'local-source:'+config.implicit};}
        return {name,certainty:'configured',namingSource:config.implicit};
      }
      if(!context.entityName&&kind==='table'||!context.propertyPath&&kind!=='table')fail('Implicit strategy source context is unavailable for this mapping kind.');
      const value=run(config.implicit,method,[valueObject('source',{context})]);if(value?.kind!=='identifier')fail('Implicit naming did not return an Identifier.');
      return {name:value.quoted?'`'+value.text+'`':value.text,certainty:'configured',namingSource:'local-source:'+config.implicit};
    }catch(error){return {name:null,certainty:'unknown',reason:error.message,namingSource:config.implicit};}
  }
  function physical(name,kind='column',context={}){
    const logical=implicit(name,kind,context),input=unquote(logical.name);
    const unknown=reason=>({name,quoted:input?.quoted||false,physicalName:null,certainty:'unknown',namingSource:config.physical||config.implicit||fallback,reason});
    if(logical.certainty==='unknown')return unknown(logical.reason);if(!input)return unknown('Nonliteral logical identifier.');
    try{
      const mapped=profiled(logical.name,kind);if(mapped?.error)return unknown(mapped.error);
      let value=mapped?.value,source=mapped?.source;
      if(!value&&config.physical){value=run(config.physical,'toPhysical'+kind[0].toUpperCase()+kind.slice(1)+'Name',[input,valueObject('jdbcEnvironment',{})]);source='local-source-or-builtin:'+config.physical;}
      if(!value){if(fallback==='unknown')return {...unknown('Physical naming strategy is not configured.'),physicalName:input.text};value=ident(fallback==='snake_case'&&!input.quoted?input.text.replace(/([A-Z])([A-Z][a-z])/g,'$1_$2').replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase():input.text,input.quoted);source='configured:'+fallback;if(input.quoted&&fallback!=='standard')return {...unknown('Quoted handling for legacy snake_case mode is unverified.'),physicalName:input.text};}
      if(value?.kind!=='identifier'||typeof value.text!=='string'||!value.text)fail('Physical naming did not return a nonempty Identifier.');
      boundedString(value.text);return {name,logicalName:logical.name,quoted:value.quoted,physicalName:value.text,certainty:'configured',namingSource:source};
    }catch(error){return unknown(error.message);}
  }
  return {physical,implicit,describe:()=>({physical:config.physical||null,implicit:config.implicit||null,profile:profile?{source:profile.source}:null,analysis:'bounded-local-Java-naming; no arbitrary Java execution',sourceTypes:types.map(t=>t.type.fqn)})};
}
module.exports={createNamingResolver};
