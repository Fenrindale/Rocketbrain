'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),c=require('../src/db/schema-conversion');
const col=(type,extra={})=>({name:'value',type,nullable:true,...extra});
const rule=(from,to,strategy)=>c.planConversions([col(from)],[col(to)],strategy?[{column:'value',strategy}]:[])[0];
test('cross-category conversion is explicit and only finite non-SQL rules are accepted',()=>{
 assert.throws(()=>rule('varchar(40)','bigint'),/Cross-category/);assert.throws(()=>rule('varchar(40)','int','CAST(value AS SIGNED)'),/finite/);
 const d=rule('varchar(40)','bigint','text-number');assert.equal(d.explicit,true);assert.equal(c.expression(d,'`value`'),'CAST(`value` AS SIGNED)');assert.throws(()=>c.expression(d,'value;DROP TABLE x'),/quoted/);
 assert.throws(()=>c.planConversions([col('int')],[col('int')],[{column:'value',strategy:'exact',sql:'1'}]),/finite/);
});
test('exact decimal and integer transformations keep significant digits and reject overflow, rounding and whitespace',()=>{
 const d=rule('varchar(50)','bigint unsigned','text-number');assert.equal(c.canonicalExpected('18446744073709551615',d),'18446744073709551615');assert.throws(()=>c.convertValue('18446744073709551616',d),/range/);assert.throws(()=>c.convertValue('-1',d),/unsigned/);assert.throws(()=>c.convertValue(' 1',d),/literal/);
 const decimal=rule('varchar(40)','decimal(20,8)','text-number');assert.equal(c.canonicalExpected('0001.23000000',decimal),'1.23');assert.throws(()=>c.convertValue('1.000000001',decimal),/lose digits/);assert.throws(()=>c.convertValue('1.1',rule('varchar(30)','int','text-number')),/Fractional/);
 assert.equal(c.canonicalExpected('1.250',rule('decimal(8,3)','varchar(30)','number-text')),'1.250');
});
test('calendar conversion is locale-free, validates leap days and refuses loss of time or fractional digits',()=>{
 assert.equal(c.canonicalExpected('2024-02-29',rule('varchar(40)','date','text-calendar')),'2024-02-29');assert.throws(()=>c.convertValue('2023-02-29',rule('varchar(40)','date','text-calendar')),/does not exist/);assert.throws(()=>c.convertValue('02/03/2024',rule('varchar(40)','date','text-calendar')),/ISO/);
 assert.equal(c.canonicalExpected('2024-02-29',rule('date','datetime(6)','calendar-exact')),'2024-02-29 00:00:00');assert.throws(()=>c.convertValue('2024-02-29 01:00:00',rule('datetime','date','calendar-exact')),/Nonzero/);assert.throws(()=>c.convertValue('2024-02-29 00:00:00.1234',rule('varchar(50)','datetime(3)','text-calendar')),/precision/);assert.equal(c.canonicalExpected('-838:59:59.1',rule('varchar(50)','time(6)','text-calendar')),'-838:59:59.1');
});
test('Boolean and BIT strategies distinguish false, null and exact unsigned bit values',()=>{
 const d=rule('varchar(10)','tinyint(1)','text-boolean');assert.equal(c.canonicalExpected('FALSE',d),'0');assert.equal(c.canonicalExpected(null,d),null);assert.throws(()=>c.convertValue('yes',d),/Boolean/);assert.equal(c.canonicalExpected(1,rule('tinyint(1)','varchar(5)','boolean-text')),'true');assert.throws(()=>c.convertValue(2,rule('tinyint(1)','varchar(5)','boolean-text')),/0\/1/);
 assert.equal(c.canonicalExpected('255',rule('varchar(20)','bit(8)','text-bit')),'255');assert.throws(()=>c.convertValue('256',rule('varchar(20)','bit(8)','text-bit')),/width/);assert.equal(c.canonicalExpected('0xffffffffffffffff',rule('bit(64)','decimal(20,0)','bit-number')),'18446744073709551615');
});
test('UTF-8 binary/text conversions are explicit and invalid bytes cannot silently replace data',()=>{
 const d=rule('varbinary(50)','varchar(50)','utf8-decode');assert.equal(c.canonicalExpected('0xed959ceab880',d),'한글');assert.throws(()=>c.convertValue('0xff',d),/UTF-8/);assert.throws(()=>c.convertValue('0x00',d),/NUL/);assert.equal(c.canonicalExpected('한글',rule('varchar(50)','varbinary(50)','utf8-encode')),'0xed959ceab880');assert.throws(()=>c.convertValue('abc',rule('varchar(50)','varbinary(2)','utf8-encode')),/width/);
});
test('JSON canonicalization preserves large numeric tokens, validates Unicode and refuses duplicate object keys',()=>{
 const d=rule('longtext','json','json-parse');assert.equal(c.canonicalExpected('{"z":9007199254740993,"a":1.2300}',d),'{"a":1.23,"z":9007199254740993}');assert.throws(()=>c.convertValue('{"a":1,"\\u0061":2}',d),/Duplicate/);assert.throws(()=>c.convertValue('{"a":NaN}',d),/Invalid/);assert.throws(()=>c.convertValue('"\\ud800"',d),/Unicode/);assert.throws(()=>c.convertValue('[1,]',d),/Invalid/);
});
test('enum/set labels are validated and SET normalization is an explicit semantic strategy',()=>{
 const e=rule('varchar(20)',"enum('red','green','')",'text-enum');assert.equal(c.canonicalExpected('red',e),'red');assert.throws(()=>c.convertValue('RED',e),/ENUM/);assert.equal(c.canonicalExpected('b,a',rule('varchar(20)',"set('a','b','c')",'text-set')),'a,b');assert.throws(()=>c.convertValue('a,a',rule('varchar(20)',"set('a','b')",'text-set')),/duplicate/);assert.throws(()=>c.typeSql("enum('a');DROP TABLE x;--"),/Unsupported/);
});
test('floating conversions require deliberate exact representation and reject rounding/nonfinite values',()=>{
 const d=rule('varchar(40)','double','text-float');assert.equal(c.convertValue('0.5',d),0.5);assert.throws(()=>c.convertValue('0.1',d),/round/);assert.throws(()=>c.convertValue('NaN',d),/literal/);assert.throws(()=>c.convertValue('Infinity',d),/literal/);assert.equal(c.canonicalExpected(0.5,rule('double','decimal(8,3)','float-exact')),'0.5');assert.throws(()=>c.convertValue(0.1,rule('double','decimal(8,3)','float-exact')),/exact/);assert.throws(()=>c.convertValue(1.0000000000001,rule('double','float','float-exact')),/precision/);assert.equal(c.convertValue(Math.fround(0.1),rule('float','double','float-exact')),Math.fround(0.1));
});
test('decimal digit reduction requires an explicit policy and reports changed values without exposing them',()=>{
 const build=onLoss=>c.planConversions([col('decimal(20,6)')],[col('decimal(20,2)')],[{column:'value',strategy:'decimal-quantize',onLoss}])[0];
 assert.throws(()=>rule('decimal(20,6)','decimal(20,2)','decimal-quantize'),/explicit onLoss/);
 const even=build('half-even');assert.equal(even.lossy,true);assert.equal(c.canonicalExpected('1.235',even),'1.24');assert.equal(c.canonicalExpected('1.245',even),'1.24');assert.equal(c.canonicalExpected('-1.235',even),'-1.24');assert.equal(c.canonicalExpected('9.995',even),'10');assert.equal(c.canonicalExpected('-1.239',build('truncate')),'-1.23');assert.deepEqual(c.diagnostic('1.235',even),{column:'value',strategy:'decimal-quantize',onLoss:'half-even',changed:true});assert.equal(JSON.stringify(c.diagnostic('1.235',even)).includes('1.235'),false);assert.equal(c.diagnostic('1.2300',even).changed,false);
 assert.match(c.expression(even,'`value`'),/^CASE WHEN/);assert.match(c.expression(build('truncate'),'`value`'),/^TRUNCATE/);
});
test('timezone-dependent cross-type TIMESTAMP inference and oversized binary cells are refused',()=>{
 assert.throws(()=>rule('varchar(40)','timestamp','text-calendar'),/Cross-category/);assert.throws(()=>rule('datetime','timestamp','calendar-exact'),/Cross-category/);
 assert.throws(()=>c.canonicalValue(Buffer.alloc(128*1024+1),col('longblob')),/128 KiB/);
});
