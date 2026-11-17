'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {analyzeScript,bindScript,typedParameter,publicScript,LIMITS}=require('../src/db/sql-script');
const {MysqlService}=require('../src/db/mysql');
const options={sqlMode:[],readOnly:true},text=value=>({kind:'text',value});

test('script splitting and named binding preserve quoted/comment text and repeated values',()=>{
 const sql="SELECT '; :hidden ?' AS s,:id; -- ignored :comment ?\nSELECT :id,:label /* :ignored */;",parsed=analyzeScript(sql,options),bound=bindScript(parsed,{id:{kind:'integer',value:'9007199254740993'},label:text("'; DROP TABLE data; --")});
 assert.equal(parsed.statements.length,2);assert.deepEqual(parsed.parameterDefinitions,[{key:'id',kind:'named',name:'id',occurrences:2},{key:'label',kind:'named',name:'label',occurrences:1}]);
 assert.equal(bound.statements[0].values[0],'9007199254740993');assert.deepEqual(bound.statements[1].values,['9007199254740993',"'; DROP TABLE data; --"]);assert.ok(bound.statements[0].preparedSql.includes("'; :hidden ?'"));assert.ok(!bound.statements[1].preparedSql.includes('DROP TABLE'));
 assert.equal(parsed.statements[1].sql,sql.slice(parsed.statements[1].start,parsed.statements[1].end));
});
test('observed quote modes delimit strings correctly and refuse unsupported dialect modes',()=>{
 assert.equal(analyzeScript(String.raw`SELECT 'a\';still-string';SELECT 2;`,options).statements.length,2);
 assert.throws(()=>analyzeScript(String.raw`SELECT 'a\';still-string';SELECT 2;`,{...options,sqlMode:['NO_BACKSLASH_ESCAPES']}),/closed|supported/i);
 assert.equal(analyzeScript('SELECT "semi;colon"; SELECT 2;',options).statements.length,2);
 assert.equal(analyzeScript('SELECT "semi;colon"; SELECT 2;',{...options,sqlMode:['ANSI_QUOTES']}).statements.length,2);
 assert.throws(()=>analyzeScript('SELECT 1',{...options,sqlMode:['ORACLE']}),/SQL mode/);assert.throws(()=>analyzeScript('SELECT 1',{readOnly:true}),/observed/);
});
test('all boundaries and execution policy are checked before any script can be reviewed',()=>{
 for(const sql of ['SELECT 1; DELIMITER $$','SELECT 1; CALL mutate()','SELECT 1; SET @@sql_mode=\'\'','SELECT 1; BEGIN','SELECT 1; COMMIT','SELECT 1; /*!50000 DELETE FROM data */','SELECT 1; /*M! DELETE FROM data */','SELECT 1; SELECT \'unclosed','SELECT 1; /* unclosed'])assert.throws(()=>analyzeScript(sql,{...options,readOnly:false}),sql);
 assert.throws(()=>analyzeScript('SELECT 1;DELETE FROM data',options),{code:'ROCKETBRAIN_READ_ONLY'});assert.throws(()=>analyzeScript('SELECT 1;'.repeat(101),options),/100 statements/);
 assert.throws(()=>analyzeScript('SELECT '+"'"+'x'.repeat(LIMITS.sqlBytes)+"'",options),/128KiB/);
});
test('typed parameters preserve precision, explicit null, JSON text, calendar text and binary bytes',()=>{
 assert.equal(typedParameter({kind:'integer',value:'18446744073709551615'}).bound,'18446744073709551615');assert.equal(typedParameter({kind:'decimal',value:'1234567890123456.12345678'}).bound,'1234567890123456.12345678');
 assert.equal(typedParameter({kind:'null'}).bound,null);assert.equal(typedParameter({kind:'json',value:'null'}).bound,'null');assert.equal(typedParameter(text('')).bound,'');assert.equal(typedParameter({kind:'boolean',value:false}).bound,false);assert.equal(typedParameter({kind:'date',value:'2024-02-29 12:30:59.123456'}).bound,'2024-02-29 12:30:59.123456');assert.deepEqual(typedParameter({kind:'binary',value:'0x00ff'}).bound,Buffer.from([0,255]));
 for(const input of [{kind:'number',value:9007199254740992},{kind:'number',value:Infinity},{kind:'integer',value:'2;DROP'},{kind:'boolean',value:'false'},{kind:'null',value:'null'},{kind:'json',value:'{'},{kind:'date',value:'2023-02-29'},{kind:'date',value:'2024-01-01T00:00:00Z'},{kind:'binary',value:'0xf'}])assert.throws(()=>typedParameter(input));
});
test('binding rejects missing, extra, mixed, custom or oversized parameter values',()=>{
 const named=analyzeScript('SELECT :a,:a',options),positional=analyzeScript('SELECT ?,?',options);
 for(const input of [undefined,{}, {a:text('x'),extra:text('y')},{a:{kind:'text',value:'x',toSqlString(){return 'DROP';}}}])assert.throws(()=>bindScript(named,input));
 assert.throws(()=>bindScript(positional,[text('a')]));assert.throws(()=>bindScript(positional,{a:text('a'),b:text('b')}));assert.throws(()=>analyzeScript('SELECT ?, :named',options));assert.throws(()=>analyzeScript('SELECT ??',options));assert.throws(()=>analyzeScript('SELECT x::int',options));
 const extra=[text('a'),text('b')];extra.toSqlString=()=>assert.fail('Array hook was invoked');assert.throws(()=>bindScript(positional,extra),/indexed values/);const noParameters=analyzeScript('SELECT 1',options),empty=[];empty.extra=text('unused');assert.throws(()=>bindScript(noParameters,empty),/indexed values/);
 const getter={};Object.defineProperty(getter,'a',{get(){assert.fail('Getter was invoked');},enumerable:true});assert.throws(()=>bindScript(named,getter),/getters/);
 assert.throws(()=>typedParameter(text('x'.repeat(LIMITS.parameterValueBytes+1))),/128KiB/);
 const repeated=analyzeScript('SELECT '+Array(9).fill(':p').join(','),options);assert.throws(()=>bindScript(repeated,{p:text('x'.repeat(LIMITS.parameterValueBytes))}),/1MiB/);
});
test('public script metadata has no bindings and cannot mutate private plan arrays',()=>{
 const bound=bindScript(analyzeScript('SELECT :secret',options),{secret:text('never-persist-this-binding')}),shown=publicScript(bound);assert.ok(!JSON.stringify(shown).includes('never-persist'));shown.parameterDefinitions[0].key='changed';shown.statements[0].sql='DELETE';shown.sqlMode.push('ORACLE');assert.equal(bound.parameterDefinitions[0].key,'secret');assert.equal(bound.statements[0].preparedSql,'SELECT ?');assert.deepEqual(bound.sqlMode,[]);
});
test('reserved words used as parameter names are values rather than execution-policy tokens',()=>{
 const bound=bindScript(analyzeScript('SELECT :delete,:set,:insert',options),{delete:text('a'),set:text('b'),insert:text('c')});assert.equal(bound.hasWrites,false);assert.equal(bound.statements[0].preparedSql,'SELECT ?,?,?');assert.deepEqual(bound.statements[0].values,['a','b','c']);
});

function fakeServer({delay=0,wide=false}={}){
 const connections=[];
 function createConnection(){
  const c=new EventEmitter();Object.assign(c,{calls:[],threadId:100+connections.length,status:2,mode:'',destroyed:false});
  c.connect=callback=>queueMicrotask(()=>callback());c.destroy=()=>{c.destroyed=true;};
  function stream(request,protocol){
   c.calls.push({sql:request.sql,values:request.values,protocol});const emitter=new EventEmitter(),sql=request.sql.trim();
   const send=()=>{if(c.destroyed)return;if(sql.includes('SLEEP'))return;if(sql.includes('BROKEN')){emitter.emit('error',{code:'ER_BAD_FIELD_ERROR'});return;}
    if(sql.startsWith('SELECT @@SESSION.sql_mode')){emitter.emit('fields',['mode','version','database','connectionId'].map(name=>({name})));emitter.emit('result',[c.mode,'8.4.13','fixture',c.threadId]);}
    else if(/^(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/.test(sql)){if(/^(?:INSERT|UPDATE|DELETE)/.test(sql)&&!(c.status&2))c.status|=1;if(/^(?:CREATE|ALTER|DROP)/.test(sql))c.status&=~1;emitter.emit('result',{affectedRows:1,serverStatus:c.status});}
    else{emitter.emit('fields',[{name:'value'}]);emitter.emit('result',wide&&sql.includes('wide')?['x'.repeat(2500000)]:[request.values?.[0]??1]);}
    emitter.emit('end');};
   if(delay&&sql.includes('slow'))setTimeout(send,delay);else queueMicrotask(send);return emitter;
  }
  c.query=(request,callback)=>{if(typeof request!=='string')return stream(request,'query');c.calls.push({sql:request,protocol:'control'});if(request.startsWith('START TRANSACTION'))c.status|=1;if(request==='ROLLBACK'||request==='COMMIT')c.status&=~1;if(request==='SET SESSION autocommit = 0')c.status&=~2;if(request==='SET SESSION autocommit = 1')c.status|=2;queueMicrotask(()=>callback(null,{serverStatus:c.status,affectedRows:0}));};c.execute=request=>stream(request,'execute');connections.push(c);return c;
 }
 return {createConnection,connections};
}
const config={host:'127.0.0.1',user:'fixture',database:'fixture',password:'never-log'};
async function fixture(options,action){const server=fakeServer(options),db=new MysqlService(config,server);try{await action(db,server);}finally{await db.dispose();}}
const userCalls=server=>server.connections.flatMap(c=>c.calls).filter(c=>c.protocol!=='control'&&!c.sql.trim().startsWith('SELECT @@SESSION.sql_mode'));
test('a reviewed script uses binary values, immutable metadata and one-shot application',()=>fixture({},async(db,server)=>{
 const original={kind:'text',value:"'; DELETE FROM data; --"},plan=await db.previewScript('SELECT :value;SELECT :value',{parameters:{value:original}});assert.equal(plan.parameterDefinitions[0].occurrences,2);assert.equal(plan.executedSql,false);assert.equal(userCalls(server).length,0);
 original.value='changed';plan.state.readOnly=false;plan.sqlMode.push('ORACLE');plan.statements[0].sql='DELETE FROM data';
 const result=await db.runScript({reviewId:plan.reviewId});assert.equal(result.state,'completed');assert.equal(result.completed,2);assert.deepEqual(result.statements[0].result.rows,[["'; DELETE FROM data; --"]]);assert.ok(userCalls(server).every(call=>call.protocol==='execute'));assert.equal(result.parameterBindingsIncluded,false);await assert.rejects(db.runScript({reviewId:plan.reviewId}),/expired|consumed/);
}));
test('script preflight rejects a later unsupported statement or missing binding without effects',()=>fixture({},async(db,server)=>{
 await db.setReadOnly(false);await assert.rejects(db.previewScript('INSERT INTO data VALUES(1);COMMIT'),/controls/);await assert.rejects(db.previewScript('INSERT INTO data VALUES(1);SELECT :missing'),/plain object/);assert.equal(userCalls(server).length,0);
}));
test('one queue holds an entire script without a same-console query interleaving',()=>fixture({delay:25},async(db,server)=>{
 const plan=await db.previewScript('SELECT 1 AS slow;SELECT 2;'),run=db.runScript({reviewId:plan.reviewId}),outside=db.query('SELECT outside');await Promise.all([run,outside]);assert.deepEqual(userCalls(server).map(c=>c.sql.trim()),['SELECT 1 AS slow;','SELECT 2;','SELECT outside']);
}));
test('a runtime SQL error stops later statements without claiming rollback of acknowledged work',()=>fixture({},async(db,server)=>{
 await db.setReadOnly(false);const plan=await db.previewScript('INSERT INTO data VALUES(1);SELECT BROKEN;INSERT INTO data VALUES(2);'),result=await db.runScript({reviewId:plan.reviewId});assert.equal(result.state,'failed');assert.equal(result.completed,1);assert.equal(result.failed,1);assert.equal(result.notRun,1);assert.equal(result.atomic,false);assert.equal(userCalls(server).length,2);assert.equal(result.statements[1].error.code,'ER_BAD_FIELD_ERROR');
}));
test('DDL requires explicit acknowledgment and never commits a pre-existing transaction',()=>fixture({},async(db,server)=>{
 await db.setReadOnly(false);await db.begin();await assert.rejects(db.previewScript('CREATE TABLE test(id INT)'),/existing transaction/);assert.equal(db.getSessionState().inTransaction,true);await db.rollback();const plan=await db.previewScript('CREATE TABLE test(id INT);SELECT 1;');await assert.rejects(db.runScript({reviewId:plan.reviewId}),/acknowledge/);assert.equal(userCalls(server).length,0);const result=await db.runScript({reviewId:plan.reviewId,allowImplicitCommit:true});assert.equal(result.completed,2);
}));
test('SQL mode or connection changes invalidate a reviewed script before effects',()=>fixture({},async(db,server)=>{
 const plan=await db.previewScript('SELECT 1');server.connections[0].mode='NO_BACKSLASH_ESCAPES';await assert.rejects(db.runScript({reviewId:plan.reviewId}),/SQL mode changed/);assert.equal(userCalls(server).length,0);
}));
test('cancel closes only the active script console and executes no following statement',()=>fixture({},async(db,server)=>{
 const plan=await db.previewScript('SELECT SLEEP(5);SELECT after_cancel;'),running=db.runScript({reviewId:plan.reviewId});for(let i=0;i<100&&!userCalls(server).length;i++)await new Promise(resolve=>setImmediate(resolve));await db.cancel();const result=await running;assert.equal(result.state,'cancelled');assert.equal(result.notRun,1);assert.equal(db.getSessionState().needsReconnect,true);assert.equal(userCalls(server).length,1);
}));
test('script aggregate result cap stops after a drained result and does not drop its healthy session',()=>fixture({wide:true},async(db,server)=>{
 const plan=await db.previewScript('SELECT wide;SELECT wide;SELECT never;'),result=await db.runScript({reviewId:plan.reviewId});assert.equal(result.state,'stopped');assert.equal(result.stopReason,'script-result-limit');assert.equal(result.completed,2);assert.equal(result.notRun,1);assert.equal(result.statements[1].result.resultOmitted,true);assert.ok(result.resultBytes<=LIMITS.resultBytes);assert.equal(db.getSessionState().needsReconnect,false);assert.equal(userCalls(server).length,2);
}));
