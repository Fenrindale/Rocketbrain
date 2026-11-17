'use strict';
const {decodeExpression}=require('./literals');
const {lexJava}=require('../spring/java');
const cache=new WeakMap();
const LIMITS={tokens:4096,steps:16000,depth:32,alternatives:8,characters:16384,statements:512};
const unknown=reason=>({kind:'unknown',reason});
function matching(tokens,index){const close={'(':')','{':'}','[':']'}[tokens[index]?.text];let n=0;for(let i=index;i<tokens.length;i++){if(tokens[i].text===tokens[index].text)n++;else if(tokens[i].text===close&&!--n)return i;}return-1;}
function split(tokens,delimiter=','){const result=[];let begin=0,depth=0;for(let i=0;i<tokens.length;i++){if(['(','[','{'].includes(tokens[i].text))depth++;else if([')',']','}'].includes(tokens[i].text))depth--;else if(!depth&&tokens[i].text===delimiter){result.push(tokens.slice(begin,i));begin=i+1;}}result.push(tokens.slice(begin));return result;}
function indexFor(parsedFiles){
  if(cache.has(parsedFiles))return cache.get(parsedFiles);
  const types=new Map(),fields=new Map(),methods=[],staticImports=new Map();
  for(const file of parsedFiles){file.tokens||=lexJava(file.text).tokens;const tokens=file.tokens;
    const imports=[];for(let i=0;i<tokens.length;i++)if(tokens[i].text==='import'&&tokens[i+1]?.text==='static'){let end=i+2;while(end<tokens.length&&tokens[end].text!==';')end++;imports.push(tokens.slice(i+2,end).map(t=>t.text).join(''));}staticImports.set(file,imports);
    for(const type of file.types||[]){if(!types.has(type.fqn))types.set(type.fqn,[]);types.get(type.fqn).push({type,file});
      for(const field of type.fields){const at=tokens.findIndex(t=>t.start===field.start);let begin=at-1;while(begin>=0&&![';','{','}'].includes(tokens[begin].text))begin--;const header=tokens.slice(begin+1,at),isFinal=header.some(t=>t.text==='final'),isStatic=header.some(t=>t.text==='static');let end=at+2,depth=0;while(end<tokens.length){const s=tokens[end].text;if(!depth&&s===';')break;if(['(','{','['].includes(s))depth++;else if([')','}',']'].includes(s))depth--;end++;}
        const item={field,type,file,isFinal,isStatic,public:header.some(t=>t.text==='public'),private:header.some(t=>t.text==='private'),parts:tokens[at+1]?.text==='='?tokens.slice(at+2,end):[]};const key=type.fqn+'.'+field.name;if(!fields.has(key))fields.set(key,[]);fields.get(key).push(item);
      }
      for(const method of type.methods){const at=tokens.findIndex(t=>t.start===method.start);if(tokens[at+1]?.text!=='(')continue;let end=matching(tokens,at+1)+1;while(end>0&&end<tokens.length&&!['{',';'].includes(tokens[end].text))end++;if(tokens[end]?.text==='{'){const close=matching(tokens,end);if(close>0)methods.push({type,file,method,start:end+1,end:close,startOffset:tokens[end].end,endOffset:tokens[close].start});}}
    }
  }
  const result={types,fields,methods,staticImports};cache.set(parsedFiles,result);return result;
}
function value(kind,value,origin){return{kind,value,origin};}
function decodedValue(decoded,file){return{kind:'string',variants:[{...decoded,sourceUris:decoded.map.map(()=>file.uri)}]};}
function empty(file,at=0){return decodedValue({text:'',map:[],ends:[],literalKinds:[]},file);}
function variants(values){const out=[];for(const v of values){if(v.kind==='unknown')return v;for(const item of v.kind==='string'?v.variants:[]){if(!out.some(other=>other.text===item.text&&other.map.every((v,i)=>v===item.map[i]&&other.ends[i]===item.ends[i]&&other.sourceUris[i]===item.sourceUris[i])))out.push(item);if(out.length>LIMITS.alternatives)return unknown('Finite Java query alternatives exceed the bounded limit.');}}return{kind:'string',variants:out};}
function asString(v,file,token){if(v.kind==='string')return v;if(['boolean','number','char','null'].includes(v.kind)){const text=v.kind==='null'?'null':String(v.value),origin=v.origin||{uri:file.uri,start:token.start,end:token.end};return{kind:'string',variants:[{text,map:Array(text.length).fill(origin.start),ends:Array(text.length).fill(origin.end),sourceUris:Array(text.length).fill(origin.uri),literalKinds:['primitive-constant']}]};}return unknown(v.reason||'Only bounded string/primitive concatenation is resolved.');}
function concatenate(a,b,file,token){const left=asString(a,file,token),right=asString(b,file,token);if(left.kind==='unknown'||right.kind==='unknown')return left.kind==='unknown'?left:right;const list=[];for(const x of left.variants)for(const y of right.variants){if(x.text.length+y.text.length>LIMITS.characters)return unknown('Resolved Java query exceeds the length limit.');list.push({text:x.text+y.text,map:[...x.map,...y.map],ends:[...x.ends,...y.ends],sourceUris:[...x.sourceUris,...y.sourceUris],literalKinds:[...(x.literalKinds||[]),...(y.literalKinds||[])]});}return variants([{kind:'string',variants:list}]);}
function mergeValue(a,b){if(a.kind==='unknown'||b.kind==='unknown')return unknown(a.reason||b.reason);if(a.kind==='builder'&&b.kind==='builder'){const merged=mergeValue(a.contents,b.contents);return merged.kind==='unknown'?merged:{kind:'builder',contents:merged};}if(a.kind==='string'&&b.kind==='string')return variants([a,b]);if(a.kind===b.kind&&Object.is(a.value,b.value))return a;return unknown('A Java branch leaves an unresolved non-string value.');}
function cloneEnv(env){return new Map([...env].map(([name,binding])=>[name,{...binding,value:binding.value.kind==='builder'?{...binding.value}:binding.value}]));}

function resolveQuery(parts,context={}){
  const file=context.file,parsedFiles=context.parsedFiles||[file];if(!file||!parts?.length)return null;
  const index=indexFor(parsedFiles),tokens=context.tokens||file.tokens||lexJava(file.text).tokens,offset=parts[0].start;
  const enclosing=index.methods.find(m=>m.file===file&&offset>=m.startOffset&&offset<=m.endOffset),type=context.type||enclosing?.type||(file.types||[]).find(t=>t.methods.includes(context.method))||(file.types||[])[0];
  const budget={steps:0,statements:0},visiting=new Set();
  function tick(){if(++budget.steps>LIMITS.steps)throw Error('Java construction analysis reached its bounded work limit.');}
  function fieldValue(path,currentFile,currentType,depth){
    if(depth>LIMITS.depth)return unknown('Java constant dependency depth exceeded.');
    let keys=[];const imported=index.staticImports.get(currentFile)||[];
    if(!path.includes('.')){if(currentType)keys.push(currentType.fqn+'.'+path);for(const item of imported)if(item.endsWith('.*'))keys.push(item.slice(0,-1)+path);else if(item.endsWith('.'+path))keys.push(item);}
    else {let name=path;if(name.startsWith('this.'))name=(currentType?.fqn||'')+name.slice(4);else{const first=name.split('.')[0];if(currentFile.imports[first])name=currentFile.imports[first]+name.slice(first.length);else if(!index.fields.has(name))name=(currentFile.packageName?currentFile.packageName+'.':'')+name;}keys=[name];}
    const choices=keys.flatMap(key=>index.fields.get(key)||[]);if(choices.length!==1)return unknown('Java constant is external, shadowed or ambiguous: '+path);
    const found=choices[0];if(!found.isFinal||(!found.isStatic&&found.type!==currentType))return unknown('Only final local/field constants and static final cross-file constants are resolved: '+path);
    if(found.file!==currentFile&&(found.private||!found.public&&found.file.packageName!==currentFile.packageName))return unknown('Java constant visibility is not established: '+path);
    const key=found.type.fqn+'.'+found.field.name;if(visiting.has(key))return unknown('Cyclic Java constant dependency: '+key);visiting.add(key);
    const result=evaluate(found.parts,new Map(),found.file,found.type,depth+1);visiting.delete(key);return result.kind==='builder'?unknown('A final StringBuilder field remains mutable and is not a Java constant.'):result;
  }
  const precedence={'||':1,'&&':2,'==':3,'!=':3,'<':4,'>':4,'<=':4,'>=':4,'+':5,'-':5,'*':6,'/':6,'%':6};
  function evaluate(input,env,currentFile=file,currentType=type,depth=0){
    tick();if(!input.length||input.length>LIMITS.tokens||depth>LIMITS.depth)return unknown('Java expression is empty or exceeds a bound.');
    const literal=decodeExpression(input);if(literal)return decodedValue(literal,currentFile);
    let at=0;
    const text=i=>input[i]?.text;
    function op(){const pair=(text(at)||'')+(text(at+1)||'');return Object.hasOwn(precedence,pair)?pair:text(at);}
    function primary(){tick();const token=input[at++];if(!token)return unknown('Incomplete Java expression.');let result,receiver;
      if(token.text==='('){result=expression(0);if(text(at++)!==')')return unknown('Unbalanced Java expression.');}
      else if(['string','text-block'].includes(token.kind)){const d=decodeExpression([token]);result=d?decodedValue(d,currentFile):unknown('Invalid or structurally unsupported Java literal.');}
      else if(token.kind==='char'){const d=decodeExpression([{...token,kind:'string',text:'"'+token.text.slice(1,-1).replaceAll('"','\\"')+'"'}]);result=d&&d.text.length===1?value('char',d.text):unknown('Unsupported Java character literal.');}
      else if(token.kind==='number'&&/^\d+[lL]?$/.test(token.text)){const number=Number(token.text.replace(/[lL]$/,''));result=Number.isSafeInteger(number)&&number<=2147483647?value('number',number,{uri:currentFile.uri,start:token.start,end:token.end}):unknown('Numeric Java constants outside the safe int subset are unresolved.');}
      else if(['true','false'].includes(token.text))result=value('boolean',token.text==='true',{uri:currentFile.uri,start:token.start,end:token.end});else if(token.text==='null')result=value('null',null,{uri:currentFile.uri,start:token.start,end:token.end});
      else if(['!','-','+'].includes(token.text)){result=primary();if(token.text==='!'&&result.kind==='boolean')result=value('boolean',!result.value);else if(result.kind==='number'&&token.text!=='!')result=value('number',token.text==='-'?-result.value:result.value);else result=unknown('Unresolved Java unary expression.');}
      else if(token.text==='new'){
        let name='';while(input[at]?.kind==='id'||text(at)==='.'){name+=input[at++].text;}
        const shadow=name==='StringBuilder'&&(currentFile.imports.StringBuilder&&currentFile.imports.StringBuilder!=='java.lang.StringBuilder'||index.types.has((currentFile.packageName?currentFile.packageName+'.':'')+'StringBuilder'));
        if(!['StringBuilder','java.lang.StringBuilder'].includes(name)||shadow||text(at)!=='(')return unknown('Only the standard StringBuilder construction is modeled.');
        const close=matching(input,at);if(close<0)return unknown('Unbalanced StringBuilder constructor.');const args=split(input.slice(at+1,close));at=close+1;
        const contents=args.length===1&&!args[0].length?empty(currentFile):args.length===1?evaluate(args[0],env,currentFile,currentType,depth+1):unknown('Unsupported StringBuilder constructor.');result=contents.kind==='string'?{kind:'builder',contents}:unknown('StringBuilder requires a known string or empty constructor.');
      } else if(token.kind==='id'){
        let name=token.text;while(text(at)==='.'&&input[at+1]?.kind==='id'&&text(at+2)!=='('){name+='.'+input[at+1].text;at+=2;}
        result=env.has(name)?env.get(name).value:fieldValue(name,currentFile,currentType,depth+1);if(result.kind==='builder'&&env.has(name))receiver=name;
        if(text(at)==='(')return unknown('Arbitrary Java method calls are never executed.');
      } else return unknown('Unsupported Java expression token: '+token.text);
      while(text(at)==='.'&&input[at+1]?.kind==='id'&&text(at+2)==='('){const method=input[at+1].text,open=at+2,close=matching(input,open);if(close<0)return unknown('Unbalanced Java builder chain.');const args=split(input.slice(open+1,close));at=close+1;
        if(result.kind==='builder'&&method==='append'&&args.length===1){const append=evaluate(args[0],env,currentFile,currentType,depth+1);const contents=concatenate(result.contents,append,currentFile,input[open]);result=contents.kind==='unknown'?contents:{kind:'builder',contents};if(receiver)env.set(receiver,{...env.get(receiver),value:result});}
        else if(result.kind==='builder'&&method==='toString'&&args.length===1&&!args[0].length)result=result.contents;
        else return unknown('Only StringBuilder.append/toString calls are modeled; arbitrary Java calls remain unknown.');
      }
      return result;
    }
    function expression(min){let result=primary();while(at<input.length){const operator=op(),level=precedence[operator];if(level===undefined||level<min)break;const token=input[at];at+=operator.length===2?2:1;const right=expression(level+1);
        if(result.kind==='unknown'||right.kind==='unknown'){result=unknown(result.reason||right.reason);continue;}
        if(operator==='+'&&(result.kind==='string'||right.kind==='string'))result=concatenate(result,right,currentFile,token);
        else if(['&&','||'].includes(operator)&&result.kind==='boolean'&&right.kind==='boolean')result=value('boolean',operator==='&&'?result.value&&right.value:result.value||right.value);
        else if(['==','!=','<','>','<=','>='].includes(operator)&&['number','boolean','char','null'].includes(result.kind)&&result.kind===right.kind){const a=result.value,b=right.value;result=value('boolean',operator==='=='?a===b:operator==='!='?a!==b:operator==='<'?a<b:operator==='>'?a>b:operator==='<='?a<=b:a>=b);}
        else if(result.kind==='number'&&right.kind==='number'){const a=result.value,b=right.value,number=operator==='+'?a+b:operator==='-'?a-b:operator==='*'?a*b:operator==='/'?Math.trunc(a/b):operator==='%'?a%b:NaN;result=Number.isSafeInteger(number)&&number>=-2147483648&&number<=2147483647?value('number',number):unknown('Java numeric overflow or unsupported arithmetic remains unresolved.');}
        else result=unknown('Java operand types or operator semantics remain unresolved.');
      }
      if(min===0&&text(at)==='?'){at++;const yes=expression(0);if(text(at++)!==':')return unknown('Incomplete Java conditional expression.');const no=expression(0);return result.kind==='boolean'?(result.value?yes:no):mergeValue(yes,no);}
      return result;
    }
    const result=expression(0);return at===input.length?result:unknown('Unsupported Java expression tail.');
  }
  function statementEnd(start,end){let depth=0;for(let i=start;i<end;i++){const t=tokens[i].text;if(!depth&&t===';')return i;if(['(','[','{'].includes(t))depth++;else if([')',']','}'].includes(t))depth--;}return end;}
  function body(start,end){return tokens[start]?.text==='{'?{start:start+1,end:matching(tokens,start),next:matching(tokens,start)+1,block:true}:{start,end:statementEnd(start,end),next:statementEnd(start,end)+1,block:false};}
  function execute(start,end,env,stop=offset){
    for(let i=start;i<end&&tokens[i]?.start<stop;){tick();if(++budget.statements>LIMITS.statements)return new Map([...env].map(([n,b])=>[n,{...b,value:unknown('Java statement bound reached.')} ]));
      if(tokens[i].text===';'){i++;continue;}
      if(tokens[i].text==='if'&&tokens[i+1]?.text==='('){const close=matching(tokens,i+1),then=body(close+1,end);let other,next=then.next;if(tokens[next]?.text==='else'){other=body(next+1,end);next=other.next;}
        const condition=evaluate(tokens.slice(i+2,close),env);const branches=[then,other].filter(Boolean);const current=branches.find(b=>tokens[b.start]?.start<=stop&&tokens[b.end]?.start>=stop);if(current)return execute(current.start,current.end,cloneEnv(env),stop);
        const yes=execute(then.start,then.end,cloneEnv(env),Infinity),no=other?execute(other.start,other.end,cloneEnv(env),Infinity):cloneEnv(env);
        for(const [name,binding]of env){const a=yes.get(name),b=no.get(name);if(a?.id===binding.id&&b?.id===binding.id)env.set(name,{...binding,value:condition.kind==='boolean'?(condition.value?a.value:b.value):mergeValue(a.value,b.value)});}
        i=next;continue;
      }
      if(tokens[i].text==='{'){const close=matching(tokens,i);if(tokens[close]?.start>=stop)return execute(i+1,close,cloneEnv(env),stop);const inside=execute(i+1,close,cloneEnv(env),Infinity);for(const [name,binding]of env)if(inside.get(name)?.id===binding.id)env.set(name,inside.get(name));i=close+1;continue;}
      if(['for','while','do','switch','try','synchronized'].includes(tokens[i].text)){
        let open=i+1;while(open<end&&!['(','{'].includes(tokens[open].text))open++;
        const start=tokens[open]?.text==='('?matching(tokens,open)+1:open,region=body(start,end);
        for(const [name,binding]of env)env.set(name,{...binding,value:unknown('Loop/exception/synchronization control flow is outside the bounded Java construction subset.')});
        if(tokens[region.end]?.start>=stop)return env;i=Math.max(region.next,i+1);continue;
      }
      const endAt=statementEnd(i,end),statement=tokens.slice(i,endAt);if(tokens[endAt]?.start>=stop)break;
      for(const [name,binding]of env)if(binding.value.kind==='builder'&&statement.some((t,j)=>t.text===name&&statement[j+1]?.text!=='.'))env.set(name,{...binding,value:unknown('A StringBuilder escapes to an unsupported operation or alias.')});
      const eq=statement.findIndex(t=>t.text==='='),plusEq=eq>0&&statement[eq-1].text==='+';
      if(eq>0){const name=statement[eq-(plusEq?2:1)],header=statement.slice(0,eq-(plusEq?2:1));if(name?.kind==='id'&&!statement.slice(0,eq).some(t=>['(',')','.'].includes(t.text))){const declaration=header.length>0,previous=env.get(name.text);let resolved=evaluate(statement.slice(eq+1),env);
          if(plusEq)resolved=previous?concatenate(previous.value,resolved,file,name):unknown('Unknown Java append assignment.');
          if(resolved.kind==='builder'&&statement.slice(eq+1).length===1&&env.get(statement[eq+1].text)?.value.kind==='builder'){env.set(statement[eq+1].text,{...env.get(statement[eq+1].text),value:unknown('StringBuilder aliases are not tracked.')});resolved=unknown('StringBuilder aliases are not tracked.');}
          env.set(name.text,{id:declaration?name.start:previous?.id||name.start,value:resolved});i=endAt+1;continue;
        }}
      if(statement[0]?.kind==='id'&&statement[1]?.text==='.'&&env.get(statement[0].text)?.value.kind==='builder')env.set(statement[0].text,{...env.get(statement[0].text),value:evaluate(statement,env)});
      else for(const [name,binding]of env)if(binding.value.kind==='builder'&&statement.some(t=>t.text===name))env.set(name,{...binding,value:unknown('A StringBuilder escapes to an unsupported operation.')});
      i=endAt+1;
    }return env;
  }
  try{
    let env=new Map();if(enclosing){for(const p of enclosing.method.parameters)env.set(p.name,{id:p.start,value:unknown('Java method parameter value is unresolved: '+p.name)});env=execute(enclosing.start,enclosing.end,env);}
    const result=evaluate(parts,env);const resolved=result.kind==='string'?result:result.kind==='builder'?unknown('A StringBuilder must be converted with toString().'):unknown(result.reason||'The Java query expression is not a known String.');
    if(resolved.kind==='unknown')return{text:null,map:[],ends:[],sourceUris:[],alternatives:[],resolution:'unknown',unknownReasons:[resolved.reason],executedUserCode:false};
    const alternatives=resolved.variants.map(d=>({...d,segments:segments(d)}));if(!alternatives.length)return null;
    return{...alternatives[0],alternatives,resolution:alternatives.length===1?'known':'finite',unknownReasons:[],executedUserCode:false};
  }catch(error){return{text:null,map:[],ends:[],sourceUris:[],alternatives:[],resolution:'unknown',unknownReasons:[error.message],executedUserCode:false};}
}
function segments(decoded){const out=[];let start=0;for(let i=1;i<=decoded.text.length;i++)if(i===decoded.text.length||decoded.sourceUris[i]!==decoded.sourceUris[start]||decoded.map[i]!==decoded.ends[i-1]){out.push({decodedStart:start,decodedEnd:i,uri:decoded.sourceUris[start],start:decoded.map[start],end:decoded.ends[i-1],kind:'java-source'});start=i;}return out;}
module.exports={resolveQuery,LIMITS};
