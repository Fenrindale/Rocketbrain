'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseDelimited,planPaste,planImport,planDuplicate}=require('../src/db/grid-bulk');
const model={canEdit:true,insertable:true,rowIds:['one','two'],columns:[
 {name:'id',type:'bigint unsigned',kind:'integer',primaryKey:true,autoIncrement:true,editable:false,insertable:false,required:false,nullable:false},
 {name:'label',type:'varchar(100)',kind:'text',editable:true,insertable:true,required:true,nullable:false},
 {name:'amount',type:'decimal(24,8)',kind:'decimal',editable:true,insertable:true,required:false,nullable:false},
 {name:'note',type:'varchar(100)',kind:'text',editable:true,insertable:true,required:false,nullable:true},
 {name:'calculated',type:'int',kind:'integer',generated:true,editable:false,insertable:false,nullable:true}
]};
test('CSV preserves BOM, quotes, CRLF, multiline literal data, empty text and large exact numeric strings',()=>{
 const parsed=parseDelimited('\uFEFFlabel,amount,note\r\n"a,\"\"b\"\"",1234567890123456.12345678,"line1\nline2"\r\nempty,0,\r\n',{delimiter:',',hasHeader:true});
 assert.deepEqual(parsed.headers,['label','amount','note']);assert.deepEqual(parsed.rows,[['a,"b"','1234567890123456.12345678','line1\nline2'],['empty','0','']]);assert.equal(parsed.quoted[0][2],true);
 const changes=planImport(model,parsed);assert.equal(changes.inserts[0].values.amount.text,'1234567890123456.12345678');assert.deepEqual(changes.inserts[1].values.note,{kind:'value',text:''});
});
test('SQL NULL requires explicit unquoted token; quoted token and empty text remain literal',()=>{
 const parsed=parseDelimited('label,note\na,\\N\nb,"\\N"\nc,\n',{delimiter:',',hasHeader:true}),changes=planImport(model,parsed,{nullToken:'\\N'});
 assert.deepEqual(changes.inserts.map(r=>r.values.note),[{kind:'null'},{kind:'value',text:'\\N'},{kind:'value',text:''}]);assert.deepEqual(planImport(model,parsed).inserts[0].values.note,{kind:'value',text:'\\N'});
});
test('CSV rejects malformed quotes, duplicate/empty headers, nonrectangular and oversized input without truncation',()=>{
 for(const source of ['a,a\n1,2','a,\n1,2','a,b\n1','a,b\n"open,2','a,b\n"closed"x,2'])assert.throws(()=>parseDelimited(source,{delimiter:',',hasHeader:true}));
 assert.throws(()=>parseDelimited('x'.repeat(128*1024+1)));assert.throws(()=>parseDelimited(Array(501).fill('row').join('\n')));assert.throws(()=>parseDelimited('a\0b'));
});
test('paste stays rectangular on the loaded page and refuses read-only keys and type errors atomically',()=>{
 const parsed=parseDelimited('first\t1.00000001\nsecond\t2.00000002');const changes=planPaste(model,parsed,{anchorRowId:'one',anchorColumn:'label'});assert.equal(changes.updates.length,2);assert.equal(changes.updates[1].rowId,'two');
 assert.throws(()=>planPaste(model,parsed,{anchorRowId:'two',anchorColumn:'label'}),/rectangle/);assert.throws(()=>planPaste(model,parsed,{anchorRowId:'one',anchorColumn:'id'}),/read-only/);assert.throws(()=>planPaste(model,parseDelimited('first\tnot decimal'),{anchorRowId:'one',anchorColumn:'label'}));
});
test('column mapping is explicit, ignores only chosen sources and protects required/generated/auto columns',()=>{
 const parsed=parseDelimited('external,ignore\nA,data',{delimiter:',',hasHeader:true});assert.throws(()=>planImport(model,parsed),/explicitly ignore/);
 const changes=planImport(model,parsed,{mapping:[{source:0,target:'label'},{source:1,target:null}]});assert.deepEqual(changes.inserts[0].values,{label:{kind:'value',text:'A'}});
 for(const mapping of [[{source:0,target:'id'}],[{source:0,target:'calculated'}],[{source:0,target:'note'}],[{source:0,target:'label'},{source:1,target:'label'}],[{source:0,target:'label'},{source:0,target:'note'}]])assert.throws(()=>planImport(model,parsed,{mapping}));
});
test('row duplication never copies keys/generated fields; manual primary keys remain explicitly required',()=>{
 const result={rows:[['9007199254740993','Alpha','1.23456789',null,'3'],['2','Beta','0','','4']]};const changes=planDuplicate(model,result,'one');assert.deepEqual(Object.keys(changes.inserts[0].values),['label','amount','note']);assert.deepEqual(changes.inserts[0].values.note,{kind:'null'});assert.equal(changes.inserts[0].values.amount.text,'1.23456789');
 const manual={...model,columns:model.columns.map(c=>c.name==='id'?{...c,autoIncrement:false,insertable:true,required:true}:c)};assert.deepEqual(planDuplicate(manual,result,'one').requiredColumns,['id']);assert.throws(()=>planDuplicate(model,result,'forged'));
});
