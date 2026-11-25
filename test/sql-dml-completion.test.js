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

const joinedCatalog={...catalog,coverage:{tables:'loaded',columns:'loaded'}};
const remoteTable={schema:'other',name:'mirror',kind:'table',columns:[
  {name:'id',type:'bigint',extra:'auto_increment'},
  {name:'score_value',type:'decimal(18,2)',extra:''},
  {name:'note_txt',type:'varchar(20)',extra:''}
]};
const join='items localRow JOIN other.mirror remoteRow ON localRow.id=remoteRow.id';
const joinedAt=(sql, read, current) => scopedDmlColumns(withoutMarker(sql),sql.indexOf('|'),joinedCatalog,context,
  read ?? (async ()=>({tables:[remoteTable]})),current);

test('joined SET assigns exact observed owners, preserving replacement spans and RHS bindings',async()=>{
  const source='SELECT 1; UPDATE '+join+' SET localRow.score_value=?, remoteRow.no|_txt=localRow.score_value';
  const [item]=await joinedAt(source);
  assert.equal(item.label,'note_txt');
  assert.equal(item.detail,'Writable column · varchar(20) · remoteRow (other.mirror)');
  assert.equal(withoutMarker(source).slice(item.start,item.end),'no_txt');
  assert.equal(item.insertText,String.fromCharCode(96)+'note_txt'+String.fromCharCode(96));
  assert.deepEqual((await joinedAt('UPDATE '+join+' SET localRow.score_value=ABS(remoteRow.score_v|) - 0.20')).map(row=>row.detail),
    ['Value column · decimal(18,2) · remoteRow (other.mirror)']);
  const incomplete=await joinedAt('UPDATE '+join+' SET remoteRow.no|');
  assert.deepEqual(incomplete.map(row=>row.label),['note_txt']);
  for (const sql of [
    'UPDATE '+join+' SET score_v|=1',
    'UPDATE '+join+' SET localRow.score_g|=1',
    'UPDATE '+join+' SET localRow.id|=1',
    'UPDATE '+join+' SET localRow.score_value=1, localRow.score_v|=2',
    'UPDATE '+join+' SET remoteRow.no|=missing.score',
    'UPDATE '+join+' SET remoterow.no|=1',
    'UPDATE '+join+' SET remoteRow.no|=1 WHERE false ORDER BY localRow.id',
    "UPDATE "+join+" SET remoteRow.note_txt='no|'",
    'UPDATE '+join+' SET remoteRow.note_txt=NULL -- ty|'
  ]) assert.deepEqual(await joinedAt(sql),[],sql);
});

test('both explicit joined DELETE forms complete base aliases and disambiguate existing filter values',async()=>{
  for (const sql of ['DELETE localRow, remote|.* FROM '+join+' WHERE localRow.id=1',
    'DELETE FROM remote| USING '+join+' WHERE localRow.id=1']) {
    assert.deepEqual((await joinedAt(sql)).map(item=>[item.label,item.kind,item.detail]),
      [['remoteRow','table','DELETE target · other.mirror']]);
  }
  const result=await joinedAt('DELETE remoteRow FROM '+join+' WHERE remoteRow.score_v| > 2');
  assert.deepEqual(result.map(item=>[item.label,item.detail]),
    [['score_value','Filter column · decimal(18,2) · remoteRow (other.mirror)']]);
  assert.deepEqual((await joinedAt('UPDATE '+join+' SET remoteRow.note_txt=? WHERE localRow.score_g|'))
    .map(item=>item.label),['score_generated']);
  for (const sql of ['DELETE remoteRow, remote| FROM '+join, 'DELETE missing FROM '+join+' WHERE remoteRow.no|',
    'DELETE remoteRow FROM '+join+' WHERE score_v| > 2',
    'DELETE remoteRow FROM items localRow JOIN other.mirror localRow ON localRow.id=localRow.id WHERE localRow.no|']) {
    assert.deepEqual(await joinedAt(sql),[],sql);
  }
});

test('joined completions stop at missing, stale or more narrowly visible remote objects',async()=>{
  const sql='UPDATE '+join+' SET remoteRow.no|=1', seen=[];
  const read=async request=>{seen.push(request);return {tables:[remoteTable]};};
  assert.equal((await joinedAt(sql,read)).length,1);
  assert.deepEqual(seen,[{endpoints:[{schema:'other',table:'mirror'}],includeEdges:false}]);
  let current=true;
  assert.deepEqual(await joinedAt(sql,async request=>{current=false;return read(request);},()=>current),[]);
  assert.deepEqual(await joinedAt(sql,async()=>({tables:[]})),[]);
  const view={...remoteTable,kind:'view'};
  assert.deepEqual(await joinedAt(sql,async()=>({tables:[view]})),[]);
  assert.deepEqual(await joinedAt('DELETE remo| FROM '+join,async()=>({tables:[view]})),[]);
  assert.deepEqual(await scopedDmlColumns(withoutMarker(sql),sql.indexOf('|'),{...joinedCatalog,cachedMetadata:true},context,
    async()=>assert.fail('Cached metadata must not silently reconnect')),[]);
});
