'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{browseQuery}=require('../src/db/grid');
const definition={name:'odd`table',columns:[{name:'id',kind:'integer',type:'bigint unsigned',nullable:false,primaryKey:true},{name:'label',kind:'text',type:'varchar(100)',nullable:true},{name:'amount',kind:'decimal',type:'decimal(24,8)',nullable:false},{name:'payload',kind:'binary',type:'blob',nullable:true},{name:'json',kind:'json',type:'json',nullable:true}]};
test('catalog-backed paging appends primary key tiebreakers and binds exact typed filters',()=>{
 const plan=browseQuery(definition,{page:2,pageSize:25,sort:[{column:'label',direction:'desc'},{column:'amount',direction:'asc'}],filters:[{column:'id',operator:'gte',value:{kind:'value',text:'9007199254740993'}},{column:'amount',operator:'lte',value:{kind:'value',text:'1234567890123456.12345678'}}]},'app');
 assert.match(plan.sql,/FROM `app`.`odd``table`/);assert.match(plan.sql,/WHERE `id` >= \? AND `amount` <= \?/);assert.match(plan.sql,/ORDER BY `label` DESC,`amount` ASC,`id` ASC LIMIT 26 OFFSET 50$/);
 assert.deepEqual(plan.parameters,['9007199254740993','1234567890123456.12345678']);assert.equal(plan.pageable,true);assert.match(plan.consistency,/Concurrent/);assert.equal(plan.query.sort.length,2);
});
test('literal text filters escape LIKE wildcards independently of backslash mode and support explicit NULL',()=>{
 const hostile="x%_=\\'; DROP TABLE t; --";
 const plan=browseQuery(definition,{filters:[{column:'label',operator:'contains',value:{kind:'value',text:hostile}},{column:'payload',operator:'isNull'},{column:'id',operator:'eq',value:{kind:'null'}}]},'app');
 assert.ok(!plan.sql.includes(hostile));assert.match(plan.sql,/LIKE \? ESCAPE '='/);assert.deepEqual(plan.parameters,["%x=%=_==\\'; DROP TABLE t; --%"]);assert.match(plan.sql,/`payload` IS NULL AND `id` IS NULL/);
});
test('browse options reject injected identifiers, raw SQL, duplicate sort, invalid types, oversized filters and unstable pages',()=>{
 const bad=[{sort:[{column:'label;DROP TABLE t',direction:'asc'}]},{sort:[{column:'id',direction:'ASC'}]},{sort:[{column:'id',direction:'asc'},{column:'id',direction:'desc'}]},{where:'1=1'},{page:-1},{page:2001},{pageSize:501},{filters:[{column:'missing',operator:'eq',value:'x'}]},{filters:[{column:'id',operator:'contains',value:'3'}]},{filters:[{column:'id',operator:'eq',value:'18446744073709551616'}]},{filters:[{column:'amount',operator:'eq',value:'0.000000001'}]},{filters:[{column:'label',operator:'eq',value:'x'.repeat(8193)}]},{filters:[{column:'payload',operator:'eq',value:'0xff'}]},{filters:[{column:'json',operator:'eq',value:'{}'}]}];
 for(const input of bad)assert.throws(()=>browseQuery(definition,input,'app'));
 const noPk={...definition,columns:definition.columns.map(c=>({...c,primaryKey:false}))};assert.throws(()=>browseQuery(noPk,{page:1},'app'),/primary key/);assert.equal(browseQuery(noPk,{},'app').pageable,false);
});
const {TableEditor}=require('../src/table-editor');
function fakeHost(){
 const state={readOnly:true,inTransaction:false,transactionState:'idle',connected:true};let calls=0;
 const results={history:[{id:1,readOnly:true,state:'done',result:{edit:{modelId:'old'},state}}],finish(id,result){Object.assign(this.history[0],{result});},editState(id,patch){Object.assign(this.history[0],patch);}};
 const db={getSessionState:()=>state,previewTable:async(table,query)=>{calls++;return{edit:{modelId:'new'+calls,query},browse:{sql:'SELECT ...'},state};},retainTableSnapshot(){},releaseTableSnapshot(){}};
 const connection={mysql:true,db,epoch:1};const controller=new TableEditor({results,connection:()=>connection,trusted:()=>true,withSession:async(id,action)=>action()});controller.contexts.set(1,{db,epoch:1,sessionId:'grid',table:'t',query:{page:0,pageSize:200,sort:[],filters:[]}});
 return{controller,results,state,calls:()=>calls};
}
test('host refuses browse while drafts, reviewed changes, active transactions or unknown outcomes remain',async()=>{
 const h=fakeHost(),record=h.results.history[0],query={page:1,pageSize:25,sort:[],filters:[]};
 for(const patch of [{hasDraft:true},{review:{reviewId:'r'}},{session:{inTransaction:true}},{session:{outcomeUnknown:true}},{session:{needsReconnect:true}}]){
  record.hasDraft=false;record.review=undefined;Object.assign(h.state,{inTransaction:false,outcomeUnknown:false,needsReconnect:false});if(patch.session)Object.assign(h.state,patch.session);else Object.assign(record,patch);
  await h.controller.handle(1,{type:'browseTable',query});assert.match(record.editError,/commit or roll back|drafts/i);assert.equal(h.calls(),0);
 }
 record.hasDraft=false;record.review=undefined;Object.assign(h.state,{inTransaction:false,outcomeUnknown:false,needsReconnect:false});await h.controller.handle(1,{type:'browseTable',query});assert.equal(h.calls(),1);assert.equal(h.controller.contexts.get(1).query.page,1);
});
