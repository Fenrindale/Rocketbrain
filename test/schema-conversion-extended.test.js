'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/db/schema-conversion');
const col=type=>({name:'value',type,nullable:true});
const rule=(from,to,strategy,extra={})=>C.planConversions([col(from)],[col(to)],[{column:'value',strategy,...extra}])[0];
test('YEAR preserves four digit and zero sentinel meanings and refuses legacy pivot inference',()=>{
 assert.equal(C.typeSql('year(4)'),'YEAR');assert.throws(()=>C.typeSql('year(2)'),/Unsupported/);
 const d=rule('varchar(8)','year','text-year');for(const value of ['0000','1901','2000','2155'])assert.equal(C.canonicalExpected(value,d),value);
 for(const value of ['0','00','69','70','1900','2156','2024.0',' 2024'])assert.throws(()=>C.canonicalExpected(value,d),/YEAR/);
 assert.equal(C.canonicalExpected(null,d),null);assert.equal(C.canonicalExpected(0,rule('int','year','number-year')),'0000');
 assert.throws(()=>C.canonicalExpected(24,rule('int','year','number-year')),/YEAR/);assert.equal(C.canonicalExpected(0,rule('year','varchar(4)','year-text')),'0000');assert.equal(C.canonicalExpected('0000',rule('year','int','year-number')),'0');assert.equal(C.canonicalValue(2024,col('year')),'2024');
});
test('binary hex adapters preserve all bytes, empty bytes and NULL while rejecting ambiguous encodings',()=>{
 const decode=rule('varchar(100)','varbinary(50)','hex-decode'),encode=rule('varbinary(50)','varchar(100)','hex-encode');
 assert.equal(C.canonicalExpected('00ff8041',decode),'0x00ff8041');assert.equal(C.canonicalExpected(Buffer.from([0,255,128,65]),encode),'00FF8041');assert.equal(C.canonicalExpected('',decode),'0x');assert.equal(C.canonicalExpected(null,decode),null);
 for(const invalid of ['0','0xFF','FF FF','GG','ff\n'])assert.throws(()=>C.convertValue(invalid,decode),/Hex/);
 assert.throws(()=>C.convertValue('FFFF',rule('varchar(10)','varbinary(1)','hex-decode')),/width/);assert.throws(()=>C.convertValue(Buffer.alloc(8),rule('varbinary(8)','varchar(15)','hex-encode')),/width/);
 assert.equal(C.expression(decode,'`value`'),'UNHEX(`value`)');
});
test('base64 adapters require canonical pad bits and remove server line wrapping from encoded output',()=>{
 const decode=rule('text','blob','base64-decode'),encode=rule('blob','text','base64-encode'),bytes=Buffer.from(Array.from({length:120},(_,i)=>i));
 assert.equal(C.canonicalExpected(bytes,encode),bytes.toString('base64'));assert.equal(C.canonicalExpected(bytes.toString('base64'),decode),'0x'+bytes.toString('hex'));
 for(const invalid of ['Zg','Zh==','Zm9=','Zg===','Zg==\n','_w==','-w==','Z g=='])assert.throws(()=>C.convertValue(invalid,decode),/base64|Base64/);
 assert.equal(C.canonicalExpected('',decode),'0x');assert.equal(C.canonicalExpected(null,encode),null);assert.match(C.expression(encode,'`value`'),/REPLACE.*CHAR\(10\).*CHAR\(13\)/);
});
test('TIMESTAMP policies require explicit UTC and a strict Z literal with exact microseconds',()=>{
 assert.throws(()=>rule('varchar(50)','timestamp(6)','text-timestamp-utc'),/explicit timezone UTC/);
 assert.throws(()=>rule('varchar(50)','timestamp(6)','text-timestamp-utc',{timezone:'Asia/Seoul'}),/UTC/);
 assert.throws(()=>rule('varchar(50)','year','text-year',{timezone:'UTC'}),/Only reviewed UTC/);
 const d=rule('varchar(50)','timestamp(6)','text-timestamp-utc',{timezone:'UTC'});assert.equal(d.requiresUtcSession,true);assert.equal(d.timezone,'UTC');assert.equal(C.canonicalExpected('2024-02-29T12:34:56.123456Z',d),'2024-02-29 12:34:56.123456');
 for(const invalid of ['2024-02-29 12:34:56Z','2024-02-29T12:34:56+09:00','2024-02-29T12:34:56','2023-02-29T00:00:00Z','2024-02-29T12:34:60Z'])assert.throws(()=>C.convertValue(invalid,d),/UTC|calendar|exist|ISO/);
 assert.throws(()=>C.convertValue('2024-02-29T12:34:56.1234Z',rule('varchar(50)','timestamp(3)','text-timestamp-utc',{timezone:'UTC'})),/precision/);
});
test('UTC timestamp boundaries reject zero sentinel and dates outside the shared engine range',()=>{
 const d=rule('datetime(6)','timestamp(6)','calendar-timestamp-utc',{timezone:'UTC'});
 for(const value of ['1970-01-01 00:00:01','2038-01-19 03:14:07.499999'])assert.equal(C.canonicalExpected(value,d),value);
 for(const value of ['1970-01-01 00:00:00','1969-12-31 23:59:59','2038-01-19 03:14:07.5','2040-01-01 00:00:00'])assert.throws(()=>C.convertValue(value,d),/range/);
 const toDate=rule('timestamp(6)','date','timestamp-calendar-utc',{timezone:'UTC'});assert.equal(C.canonicalExpected('2024-02-29 00:00:00.000000',toDate),'2024-02-29');assert.throws(()=>C.convertValue('2024-02-29 00:00:00.000001',toDate),/Nonzero/);
});
test('UTC timestamp text renders declared precision exactly and its SQL uses explicit UTC formatting',()=>{
 for(const scale of [0,3,6]){const d=rule('timestamp('+scale+')','varchar(40)','timestamp-text-utc',{timezone:'UTC'}),expected='2024-02-29T12:34:56'+(scale?'.'+'12'.padEnd(scale,'0'):'')+'Z',source='2024-02-29 12:34:56'+(scale?'.12':'');assert.equal(C.canonicalExpected(source,d),expected);assert.match(C.expression(d,'`value`'),/CONCAT\(DATE_FORMAT/);assert.equal(C.canonicalExpected(null,d),null);}
 assert.throws(()=>C.planConversions([col('int')],[col('year')],[{column:'value',strategy:'number-year',sql:'NOW()'}]),/finite/);
});
