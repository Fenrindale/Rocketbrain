'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {parseJavaFile,lexJava}=require('../src/spring/java');const {resolveQuery}=require('../src/jpa/dynamic');
const file=(name,text)=>({...parseJavaFile({uri:'file:///'+name+'.java',text}),tokens:lexJava(text).tokens});
function resolve(source,others=[]){const f=file('Service',source),files=[...others,f],tokens=f.tokens,index=tokens.findIndex(t=>t.text==='createQuery');let end=index+2,depth=0;while(end<tokens.length){if(!depth&&[',',')'].includes(tokens[end].text))break;if(tokens[end].text==='(')depth++;else if(tokens[end].text===')')depth--;end++;}return{file:f,result:resolveQuery(tokens.slice(index+2,end),{file:f,tokens,parsedFiles:files,callIndex:index})};}
test('cross-file static finals and local concatenation retain original per-character provenance',()=>{
  const constants=file('Parts','package demo; public class Parts { public static final String BASE="select p from Person p"; }');
  const {result}=resolve('package demo; class Service { void query(){ final String sql=Parts.BASE+" where p.name=:name"; em.createQuery(sql); } }',[constants]);
  assert.equal(result.resolution,'known');assert.equal(result.text,'select p from Person p where p.name=:name');assert.equal(result.sourceUris[0],constants.uri);assert.equal(constants.text.slice(result.map[0],result.ends[0]),'s');assert.ok(result.segments.some(s=>s.uri==='file:///Service.java'));assert.equal(result.executedUserCode,false);
});
test('standard StringBuilder chained and sequential appends resolve without executing Java methods',()=>{
  for(const build of ['StringBuilder b=new StringBuilder("select p"); b.append(" from Person p"); String sql=b.toString();','String sql=new StringBuilder().append("select p").append(" from Person p").toString();']){
    const {result}=resolve('package demo; class Service { void query(){ '+build+' em.createQuery(sql); } }');assert.equal(result.text,'select p from Person p');assert.equal(result.resolution,'known');
  }
  const updated=resolve('package demo; class Service { void query(){ StringBuilder b=new StringBuilder("select p"); String ignored=b.append(" from Person p").toString(); em.createQuery(b.toString()); } }').result;assert.equal(updated.text,'select p from Person p');
});
test('known and finite unknown conditionals produce selected or independent query alternatives',()=>{
  const known=resolve('package demo; class Service { static final boolean PICK=true; void query(){ String sql=PICK?"select p from Person p":"select d from Department d"; em.createQuery(sql); } }').result;assert.equal(known.resolution,'known');assert.equal(known.text,'select p from Person p');
  const finite=resolve('package demo; class Service { void query(boolean pick){ String sql=pick?"select p from Person p":"select d from Department d"; em.createQuery(sql); } }').result;assert.equal(finite.resolution,'finite');assert.deepEqual(finite.alternatives.map(v=>v.text),['select p from Person p','select d from Department d']);
  const branches=resolve('package demo; class Service { void query(boolean pick){ String sql=""; if(pick){sql="select p from Person p";}else{sql="select d from Department d";} em.createQuery(sql); } }').result;assert.equal(branches.resolution,'finite');assert.equal(branches.alternatives.length,2);
  const repeated=resolve('package demo; class Service { void query(boolean pick){ String sql=pick?"select p from Person p":"select p from Person p"; em.createQuery(sql); } }').result;assert.equal(repeated.alternatives.length,2);assert.notEqual(repeated.alternatives[0].map[0],repeated.alternatives[1].map[0]);
});
test('dynamic parameters, cycles, non-final fields, loops, aliases and arbitrary methods stay tainted',()=>{
  const bodies=['String sql="select p from "+name;','String sql=loadQuery();','StringBuilder b=new StringBuilder("select p"); unknown(b); String sql=b.toString();','StringBuilder b=new StringBuilder("select p"); String ignored=unknown(b); String sql=b.toString();','StringBuilder b=new StringBuilder("select p"); StringBuilder alias=b; alias.append(" from Person p"); String sql=b.toString();','String sql="select p from Person p"; for(int i=0;i<2;i++){sql += name;}'];
  for(const body of bodies){const {result}=resolve('package demo; class Service { void query(String name){ '+body+' em.createQuery(sql); } }');assert.equal(result.resolution,'unknown',body);assert.equal(result.text,null);assert.ok(result.unknownReasons.length);}
  assert.equal(resolve('package demo; class Service { String BASE="select p from Person p"; void query(){ em.createQuery(BASE); } }').result.resolution,'unknown');
  assert.equal(resolve('package demo; class Service { static final String A=B; static final String B=A; void query(){ em.createQuery(A); } }').result.resolution,'unknown');
  assert.equal(resolve('package demo; class Service { static final StringBuilder BASE=new StringBuilder("select p from Person p"); void query(){ em.createQuery(BASE.toString()); } }').result.resolution,'unknown');
});
test('block shadowing and static imports obey the bounded local symbol scope',()=>{
  const constants=file('Parts','package demo; public class Parts { public static final String BASE="select p from Person p"; }');
  const {result}=resolve('package demo; import static demo.Parts.BASE; class Service { void query(){ String sql=BASE; {String sql="not a query";} em.createQuery(sql); } }',[constants]);assert.equal(result.text,'select p from Person p');
  const shadow=resolve('package demo; class Service { static final String BASE="select p from Person p"; void query(String BASE){ em.createQuery(BASE); } }').result;assert.equal(shadow.resolution,'unknown');
});
test('primitive concatenation retains its declaring constant origin and excludes unsupported decimal formatting',()=>{
  const constants=file('Parts','package demo; public class Parts { public static final int ID=12; }');const {result}=resolve('package demo; class Service { void query(){ em.createQuery("select p from Person p where p.id="+Parts.ID); } }',[constants]);const at=result.text.indexOf('12');assert.equal(result.sourceUris[at],constants.uri);assert.equal(constants.text.slice(result.map[at],result.ends[at]),'12');
  assert.equal(resolve('package demo; class Service { void query(){ em.createQuery("select p from Person p where p.id="+1.0); } }').result.resolution,'unknown');
});
