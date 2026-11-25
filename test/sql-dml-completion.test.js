'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const { scopedDmlColumns } = require('../src/db/sql-dml-completion');

const columns = [
  {name:'id',type:'bigint',extra:'auto_increment'},
  {name:'score_value',type:'decimal(14,4)',extra:''},
  {name:'score_generated',type:'decimal(14,4)',extra:'STORED GENERATED'},
  {name:'label',type:'varchar(40)',extra:''}
];
const catalog = {database:'app',tables:[{schema:'app',name:'items',kind:'table',columns}]};
const context = {database:'app',catalogComplete:true,sqlMode:[],tableNameCaseSensitive:true};
const withoutMarker = value => value.replace('|','');
const at = (sql, options=context, read, current) => scopedDmlColumns(withoutMarker(sql),sql.indexOf('|'),catalog,options,read,current);

test('writable column suggestions replace the exact partial name and omit generated or already assigned fields',async()=>{
 const source='SELECT 1; INSERT INTO items (score_value, la|)';
 const [picked]=await at(source);
 const result=withoutMarker(source);
 assert.deepEqual(picked,{label:'label',kind:'column',detail:'Writable column · varchar(40)',
  insertText:'`label`',start:result.indexOf('la)'),end:result.indexOf('la)')+2});
 assert.deepEqual((await at('INSERT INTO items (sc|')).map(row=>row.label),['score_value']);
 assert.deepEqual((await at("UPDATE items AS i SET score_value=ABS(2), i.la| = ?")).map(row=>row.label),['label']);
 assert.deepEqual((await at('UPDATE items SET label=?, la|=?')),[]);
});

test('qualified filter suggestions use the target alias and actual generated-column type',async()=>{
 const result=await at('DELETE FROM items AS i WHERE i.sc|');
 assert.deepEqual(result.map(row=>row.label),['score_value','score_generated']);
 assert.equal(result[1].detail,'Filter column · decimal(14,4)');
 for(const source of ['DELETE FROM items AS i WHERE wrong.sc|',
   'UPDATE items SET score_value=ABS(sc|)',
   'UPDATE items JOIN second ON items.id=second.id SET sc|=1',
   "DELETE FROM items WHERE label='sc|'",
   'DELETE FROM items WHERE -- comm sc|']) assert.deepEqual(await at(source),[],source);
});

test('explicit remote tables read only the observed endpoint and check staleness before publishing',async()=>{
 let valid=true;
 const seen=[];
 const read=async request=>{
  seen.push(request);
  return {tables:[{schema:'other',name:'items',kind:'table',columns:[{name:'remote_only',type:'char(3)',extra:''}]}]};
 };
 const sql='INSERT INTO other.items (re|)';
 assert.deepEqual((await at(sql,context,read,()=>valid)).map(row=>row.label),['remote_only']);
 assert.deepEqual(seen,[{endpoints:[{schema:'other',table:'items'}],includeEdges:false}]);
 assert.deepEqual(await at(sql,context,async request=>{valid=false;return read(request);},()=>valid),[]);
 assert.deepEqual(await at(sql,context,async()=>{throw Error('permission denied');}),[]);
});
