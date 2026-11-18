'use strict';
// Interpret a finite declarative dependency language, never Gradle/Groovy code.
// Every branch is retained, including combinations that may be infeasible.
const LIMITS=Object.freeze({constants:32,branches:4,variants:16,tokens:12000});
function tokens(text){const result=[];let i=0;while(i<text.length){if(/\s/.test(text[i])){i++;continue;}if(text.startsWith('//',i)){const end=text.indexOf('\n',i);i=end<0?text.length:end;continue;}if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)throw Error('Unterminated Gradle contract comment.');i=end+2;continue;}const start=i,quote=text[i];if(quote==='\''||quote==='"'){i++;let value='';while(i<text.length&&text[i]!==quote){if(text[i]==='\\'||text[i]==='\r'||text[i]==='\n')throw Error('Escaped or multiline Gradle contract strings require separate review.');value+=text[i++];}if(text[i++]!==quote)throw Error('Unterminated Gradle contract string.');result.push({text:text.slice(start,i),value,quote,start,end:i,kind:'string'});}else {const match=/^[A-Za-z_$][\w$]*|^(?:==|!=|&&|\|\|)|^./s.exec(text.slice(i))[0];i+=match.length;result.push({text:match,start,end:i,kind:/^[A-Za-z_$]/.test(match)?'id':'punctuation'});}if(result.length>LIMITS.tokens)throw Error('Gradle contract token budget exceeded.');}return result;}
const quoted=value=>{if(!/^[A-Za-z0-9_$:./-]+$/.test(value))throw Error('Gradle contract string leaves the reviewed literal alphabet.');return "'"+value+"'";};
// The condition is checked for purity, not evaluated. Keeping every syntactic
// branch also covers property overrides from outside this source tree.
function propertyCondition(values) {
 const atoms=[];
 let cursor=0;
 function take(text) {
  if(values[cursor]?.text!==text)return false;
  cursor++;
  return true;
 }
 function requireToken(text) {
  if(!take(text))throw Error('Only bounded pure Gradle property equality branches are reviewed.');
 }
 function literal(pattern) {
  const token=values[cursor++];
  if(token?.kind!=='string'||!pattern.test(token.value))throw Error('Gradle property conditions require plain literal names and values.');
  return token.value;
 }
 function atom(depth) {
  if(depth>8)throw Error('Gradle property condition nesting budget exceeded.');
  if(take('!'))return atom(depth+1);
  if(take('(')){
   booleanExpression(depth+1);
   requireToken(')');
   return;
  }
  for(const token of ['providers','.','gradleProperty','('])requireToken(token);
  const property=literal(/^[A-Za-z_][\w.-]*$/);
  for(const token of [')','.','getOrElse','('])requireToken(token);
  const defaultValue=literal(/^[\w.-]+$/);
  requireToken(')');
  const operator=take('==')?'==':take('!=')?'!=':null;
  if(!operator)throw Error('Only bounded pure Gradle property equality branches are reviewed.');
  const equals=literal(/^[\w.-]+$/);
  atoms.push({property,defaultValue,equals,operator});
  if(atoms.length>8)throw Error('Gradle property condition atom budget exceeded.');
 }
 function and(depth) {
  atom(depth);
  while(take('&&'))atom(depth);
 }
 function booleanExpression(depth) {
  and(depth);
  while(take('||'))and(depth);
 }
 booleanExpression(0);
 if(cursor!==values.length)throw Error('Only bounded pure Gradle property equality branches are reviewed.');
 return {...(atoms.length===1?atoms[0]:{}),atoms,coverage:'all syntactic branches, independent conservative combinations'};
}
function expression(values,constants,declarations,origin=0){let index=0,value='';const constant=(name,at)=>{if(!constants.has(name))throw Error('Unresolved Gradle string contract constant.');if(!declarations.has(name)||declarations.get(name).end>origin+at)throw Error('Gradle local constants must be declared before every use; forward project-property or local-variable lookup requires separate review.');return constants.get(name);};const atom=()=>{const token=values[index++];if(token?.kind==='string'){if(token.quote==='\'')return token.value;return token.value.replace(/\$\{([A-Za-z_$][\w$]*)\}|\$([A-Za-z_$][\w$]*)/g,(all,a,b,offset)=>{if(b&&['.','[','('].includes(token.value[offset+all.length]))throw Error('Groovy interpolated properties require separate review.');const name=a||b;return constant(name,token.start+1+offset);});}if(token?.kind==='id'&&constants.has(token.text))return constant(token.text,token.start);throw Error('Only immutable local String constants are reviewed in Gradle dependencies.');};value=atom();while(index<values.length){if(values[index++].text!=='+')throw Error('Unreviewed Gradle constant expression.');value+=atom();}if(value.includes('$'))throw Error('Unresolved Gradle interpolation requires separate review.');quoted(value);return value;}
function normalizeGradleContracts(source){
 if(typeof source!=='string'||source.length>256*1024)throw Error('Gradle contract source budget exceeded.');
 const constants=new Map(),declarations=new Map(),predicates=[];let text=source;
 // Blank declarations without shifting offsets so later dependency uses can
 // be checked against their original lexical declaration positions.
 text=text.replace(/^[ \t]*def[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*([^\r\n]+)[ \t]*$/gm,(_line,name,body,offset)=>{const depth=tokens(source.slice(0,offset)).reduce((n,token)=>n+(token.text==='{'?1:token.text==='}'?-1:0),0);if(depth!==0||['providers','project','platform','dependencies','group','version','implementation','api','runtimeOnly','testImplementation','testRuntimeOnly','class','def','if','else','return','new','true','false','null','String','void','public','private','package','interface','enum','while','for','switch','throw','try','catch','finally','this','super','static','final','import','as','in','assert','break','continue','case','default','do','instanceof','extends','implements','trait','int','long','boolean','byte','short','char','float','double','abstract','protected','native','synchronized','transient','volatile','throws','const','goto','strictfp'].includes(name))throw Error('Gradle contract constants must be top-level and cannot shadow build APIs or keywords.');if(constants.size>=LIMITS.constants||constants.has(name))throw Error('Duplicate or excessive Gradle contract constants.');const value=expression(tokens(body.replace(/;\s*$/,'')),constants,declarations,offset+_line.indexOf(body,_line.indexOf('=')+1));constants.set(name,value);declarations.set(name,{start:offset,end:offset+_line.length});return _line.replace(/[^\r\n]/g,' ');});
 const all=tokens(text),replacements=[];
 function close(values,index,open,shut){if(values[index]?.text!==open)throw Error('Missing Gradle contract delimiter.');let depth=0;for(let i=index;i<values.length;i++){if(values[i].text===open)depth++;if(values[i].text===shut&&!--depth)return i;}throw Error('Unterminated Gradle dependency contract.');}
 function parseBranch(values,start){
  if(predicates.length>=LIMITS.branches)throw Error('Gradle property branch budget exceeded.');
  const end=close(values,start+1,'(',')');
  predicates.push(propertyCondition(values.slice(start+2,end)));
  const thenEnd=close(values,end+1,'{','}');
  const thenVariants=parseBody(values.slice(end+2,thenEnd));
  if(values[thenEnd+1]?.text!=='else')throw Error('Gradle property contracts require an explicit exhaustive else branch.');
  const other=thenEnd+2;
  if(values[other]?.text==='if'){
   const next=parseBranch(values,other);
   return {end:next.end,variants:[...thenVariants,...next.variants]};
  }
  const elseEnd=close(values,other,'{','}');
  return {end:elseEnd+1,variants:[...thenVariants,...parseBody(values.slice(other+1,elseEnd))]};
 }
 function parseBody(values){let cursor=0,variants=[''];while(cursor<values.length){if(values[cursor].text===';'){cursor++;continue;}if(values[cursor].text==='if'){
   const branch=parseBranch(values,cursor);
   variants=variants.flatMap(prefix=>branch.variants.map(alternative=>prefix+alternative));
   cursor=branch.end;
  }else{
   const configuration=values[cursor++].text;if(!['implementation','api','runtimeOnly','testImplementation','testRuntimeOnly'].includes(configuration))throw Error('Unreviewed Gradle dependency contract statement.');let argument;
   if(['project','platform'].includes(values[cursor]?.text)){const kind=values[cursor++].text,end=close(values,cursor,'(',')'),value=expression(values.slice(cursor+1,end),constants,declarations);if(kind==='project'&&!/^:[A-Za-z_$][\w$-]*$/.test(value))throw Error('Gradle project constants require a literal sibling identity.');argument=kind+'('+quoted(value)+')';cursor=end+1;}
   else {const from=cursor;cursor++;while(values[cursor]?.text==='+')cursor+=2;argument=quoted(expression(values.slice(from,cursor),constants,declarations));}
   variants=variants.map(prefix=>prefix+configuration+' '+argument+';');
  }if(variants.length>LIMITS.variants)throw Error('Gradle contract branch combination budget exceeded.');}return variants;}
 for(let i=0;i<all.length;i++){if(all[i].text!=='dependencies'||all[i+1]?.text!=='{')continue;const end=close(all,i+1,'{','}'),variants=parseBody(all.slice(i+2,end));replacements.push({start:all[i].start,end:all[end].end,variants:variants.map(body=>'dependencies {'+body+'}')});i=end;}
 for(const token of all){if(replacements.some(span=>token.start>=span.start&&token.end<=span.end))continue;if(token.kind==='id'&&constants.has(token.text)||token.kind==='string'&&token.quote==='"'&&[...constants.keys()].some(name=>token.value.includes('${'+name+'}')||new RegExp('\\$'+name.replace(/\$/g,'\\$')+'(?![\\w$])').test(token.value)))throw Error('Gradle constants may only be consumed by the reviewed dependency expressions.');}
 let variants=[text];for(const replacement of replacements.reverse()){variants=variants.flatMap(value=>replacement.variants.map(body=>value.slice(0,replacement.start)+body+value.slice(replacement.end)));if(variants.length>LIMITS.variants)throw Error('Gradle dependency variant budget exceeded.');}
 return {variants:[...new Set(variants)],contract:{mode:'finite-source-only-gradle-dependencies',constants:[...constants].map(([name,value])=>({name,value})),predicates,allBranchesReviewed:true,executedBuildCode:false,limits:LIMITS}};
}
module.exports={normalizeGradleContracts,LIMITS};
