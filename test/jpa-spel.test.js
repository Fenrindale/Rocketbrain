'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {parseJavaFile,lexJava}=require('../src/spring/java');
const {decodeExpression}=require('../src/jpa/literals');const {resolveSpel,analyzeExpression}=require('../src/jpa/spel');
const parsed=(name,text)=>parseJavaFile({uri:'file:///'+name+'.java',text});
const dto=parsed('Filter','package demo; public class Filter { private String name; private String city; public String getName(){return name;} public String getCity(){return city;} }');
function resolve(query,parameters='@Param("filter") Filter filter',extra={}){
  const text='package demo; import java.util.*; import org.springframework.data.repository.query.Param; import org.springframework.data.jpa.repository.Query; interface Repository { @Query('+JSON.stringify(query)+') List<String> names('+parameters+'); }';
  const file=parsed('Repository',text),method=file.types[0].methods[0],decoded=decodeExpression(method.annotations[0].attributes.value);
  return{file,method,result:resolveSpel(decoded,{file,method,model:{files:[dto,file]},entityName:'Person',...extra})};
}
test('entity template and named parameter properties become typed symbolic parameters with source maps',()=>{
  const {file,result}=resolve('select p from #{#entityName} p where p.name=:#{#filter.name}');
  assert.equal(result.text,'select p from Person p where p.name=:rb_spel_0');assert.equal(result.symbolicParameters[0].javaType,'java.lang.String');assert.equal(result.symbolicParameters[0].state,'known');assert.deepEqual(result.unknownReasons,[]);assert.equal(result.executedUserCode,false);
  assert.equal(result.map.length,result.text.length);assert.equal(result.ends.length,result.text.length);assert.equal(result.sourceUris.length,result.text.length);const p=result.symbolicParameters[0];assert.equal(p.uri,file.uri);assert.equal(file.text.split('\n')[p.range.start.line].slice(p.range.start.character,p.range.end.character),':#{#filter.name}');
  const collision=resolve('select p from Person p where p.name=:rb_spel_0 or p.name=:#{#filter.name}').result;assert.equal(collision.symbolicParameters[0].name,'rb_spel_1');assert.ok(collision.text.includes('=:rb_spel_0 or p.name=:rb_spel_1'));
});
test('safe navigation, elvis, indexed argument, root argument and ternary infer declared value types',()=>{
  for(const expression of ["#filter?.name ?: 'Alex'",'[0].city','#root[0].city',"#filter.city != null ? #filter.city : 'Seoul'"]){
    const {result}=resolve('select p from Person p where p.name=?#{'+expression+'}');assert.equal(result.symbolicParameters[0].state,'known',expression);assert.equal(result.symbolicParameters[0].javaType,'java.lang.String',expression);assert.equal(result.symbolicParameters[0].originalPrefix,'?');assert.equal(result.text,'select p from Person p where p.name=:rb_spel_0');
  }
  const numeric=resolve('select p from Person p where p.id>=:#{#minimum + 1}','@Param("minimum") Long minimum').result;assert.equal(numeric.symbolicParameters[0].javaType,'java.lang.Long');assert.equal(numeric.symbolicParameters[0].state,'known');
});
test('missing properties and incompatible operators diagnose the original fragment',()=>{
  const {file,result}=resolve('select p from Person p where p.name=:#{#filter.missing}');const diagnostic=result.diagnostics.find(d=>d.code==='jpa.spel.property.missing');assert.ok(diagnostic);assert.equal(result.symbolicParameters[0].state,'unknown');assert.equal(file.text.slice(diagnostic.range.start.character,diagnostic.range.end.character),'missing');
  const invalid=resolve('select p from Person p where p.name=:#{#filter.name - 1}').result;assert.equal(invalid.symbolicParameters[0].state,'unknown');assert.ok(invalid.diagnostics.some(d=>d.code==='jpa.spel.type'));
  const outOfRange=resolve('select p from Person p where p.name=:#{[3].name}').result;assert.equal(outOfRange.symbolicParameters[0].state,'unknown');assert.ok(outOfRange.diagnostics.some(d=>d.code==='jpa.spel.index'));
});
test('beans, method calls, type references, reflection and unbound context aliases stay unknown without execution',()=>{
  for(const expression of ['@unapprovedBean.lookup()','#filter.getName()','T(java.lang.Runtime).getRuntime()','#filter.class','#unknown.name','#args[0].name']){
    const result=resolve('select p from Person p where p.name=:#{'+expression+'}').result;assert.equal(result.symbolicParameters[0].state,'unknown',expression);assert.ok(result.unknownReasons.length||result.diagnostics.length,expression);assert.equal(result.executedUserCode,false);
  }
});
test('array, typed collections and maps use declared generic element types',()=>{
  for(const [expression,parameters] of [['#names[0]','@Param("names") List<String> names'],['#names[0]','@Param("names") String[] names'],["#names['a']",'@Param("names") Map<String,String> names']]){
    const result=resolve('select p from Person p where p.name=:#{'+expression+'}',parameters).result;assert.equal(result.symbolicParameters[0].state,'known',parameters);assert.equal(result.symbolicParameters[0].javaType,'java.lang.String',parameters);
  }
});
test('unsupported templates, incomplete fragments and bounded expressions never gain query certainty',()=>{
  assert.ok(resolve('select p from #{#unknown} p').result.unknownReasons.length);assert.ok(resolve('select p from Person p where p.name=:#{#filter.name').result.unknownReasons.length);
  const result=resolve('select p from Person p where p.id=:#{'+Array(600).fill('1').join('+')+'}').result;assert.equal(result.symbolicParameters[0].state,'unknown');assert.ok(result.unknownReasons.some(s=>s.includes('limit')));
});
test('quoted JPQL text containing a SpEL-like fragment is preserved as literal text',()=>{
  const text="select ':#{@bean.run()}' from Person p where p.name=:#{#filter.name}";const result=resolve(text).result;assert.equal(result.text,"select ':#{@bean.run()}' from Person p where p.name=:rb_spel_0");assert.equal(result.symbolicParameters.length,1);assert.deepEqual(result.unknownReasons,[]);
});
test('private fields without a public reader and malformed number tokens cannot establish property or value types',()=>{
  const hidden=parsed('Hidden','package demo; public class Hidden { private String secret; }');const result=resolve('select p from Person p where p.name=:#{#filter.secret}','@Param("filter") Hidden filter',{model:{files:[hidden]}}).result;assert.equal(result.symbolicParameters[0].state,'unknown');assert.ok(result.diagnostics.some(d=>d.code==='jpa.spel.property.missing'));
  assert.equal(resolve('select p from Person p where p.id=:#{1.2.3}').result.symbolicParameters[0].state,'unknown');
});
test('fixed String method signatures infer types without invoking code and reject bad arguments or arbitrary receivers',()=>{
  for(const [expression,javaType]of [['#filter.name.toLowerCase()','java.lang.String'],['#filter.name.toUpperCase().trim()','java.lang.String'],['#filter.name.length()','java.lang.Integer'],['#filter.name.isEmpty()','java.lang.Boolean'],['#filter.name.substring(1, 2)','java.lang.String']]){const result=resolve('select p from Person p where p.name=:#{'+expression+'}').result;assert.equal(result.symbolicParameters[0].state,'known',expression);assert.equal(result.symbolicParameters[0].javaType,javaType);assert.equal(result.executedUserCode,false);}
  for(const expression of ['#filter.name.toLowerCase(1)',"#filter.name.substring('x')",'#filter.name.substring(1L)','#filter.toLowerCase()','#filter.name.delete()']){const result=resolve('select p from Person p where p.name=:#{'+expression+'}').result;assert.equal(result.symbolicParameters[0].state,'unknown',expression);assert.ok(result.unknownReasons.length||result.diagnostics.length);assert.equal(result.executedUserCode,false);}
});
