'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const mysql=require('mysql2/promise');
const {verifyPackageWorkflow}=require('./routine-oracle-package-host');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const marker={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
const decimal=value=>({kind:'decimal',value});

async function verifyPackageOutputWorkflow(runtime,adapter) {
  const owner=await read(path.join(path.dirname(runtime.dbConfigPath),'owner.json'));
  assert.equal(owner.kind,marker[runtime.dbEngine]);
  if(runtime.dbEngine==='mysql')return verifyPackageWorkflow(runtime,adapter);
  const config=await read(runtime.dbConfigPath);
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  assert.ok(Number.isInteger(config.port)&&config.port>=1024&&config.port<=65535);

  const connection=await mysql.createConnection(config),suffix=randomBytes(5).toString('hex');
  const name='rb_fnout_'+suffix,audit='rb_fn_log_'+suffix;
  const object={kind:'package',name,schema:config.database};
  const member=value=>({kind:'package-function',schema:config.database,package:name,name:value});
  const signature='FUNCTION advance(v IN NUMBER(32,6), amount IN OUT NUMBER(32,6), note OUT VARCHAR2(20)) RETURN NUMBER(32,6)';
  const outOnly='FUNCTION output_only(answer OUT BIGINT) RETURN NUMBER(32,6)';
  const write='FUNCTION write_attempt(answer OUT INTEGER) RETURN INTEGER';
  const body=step=>'CREATE PACKAGE BODY '+name+' AS '+signature+' IS n INTEGER; BEGIN '+
    'SELECT COUNT(*) INTO n FROM rb_spring_person; amount := amount + v; note := NULL; IF n = 2 THEN RETURN amount + '+step+
    '; END IF; RETURN NULL; END; '+outOnly+' IS BEGIN answer := 9007199254740993; RETURN NULL; END; '+
    write+' IS BEGIN INSERT INTO '+audit+' VALUES (1); answer := 0; RETURN 1; END; '+
    'FUNCTION private_member(answer OUT INTEGER) RETURN INTEGER IS BEGIN answer:=3; RETURN 2; END; END '+name;
  const value=decimal('1234567890123456789.123456'),increment=decimal('0.000001');
  try {
    const spring=await adapter.probe();
    assert.equal(spring.people,2);
    const [[{sqlMode}]]=await connection.query('SELECT @@SESSION.sql_mode sqlMode');
    const [[{version}]]=await connection.query('SELECT VERSION() version');
    await connection.query('CREATE TABLE '+audit+' (id INT) ENGINE=InnoDB');
    await connection.query('SET SESSION sql_mode=ORACLE');
    await connection.query('CREATE PACKAGE '+name+' SQL SECURITY INVOKER AS '+[signature,outOnly,write].join('; ')+'; END '+name);
    await connection.query(body('0.000001'));
    await connection.query('SET SESSION sql_mode=?',[sqlMode]);
    await adapter.connect(config);
    const {calls,reviewDocument,openResult}=adapter;
    const listing=await calls.inspectPackage(object);
    assert.equal(listing.syntax,'oracle');
    assert.deepEqual(listing.members.map(item=>[item.name,item.supported,item.parameters.map(parameter=>parameter.mode)]),[
      ['advance',true,['IN','INOUT','OUT']],['output_only',true,['OUT']],['write_attempt',true,['OUT']]
    ]);
    await assert.rejects(calls.inspect(member('private_member')),/unambiguous public function/);

    const draft=await calls.inspect(member('advance'));
    assert.throws(()=>calls.prepare(draft.id,[increment,value,{kind:'null'}]),/one typed value/);
    assert.throws(()=>calls.prepare(draft.id,[increment,{kind:'text',value:value.value}]),/requires decimal/);
    const planned=calls.prepare(draft.id,[increment,value]);
    assert.match(planned.sql,/^SET @rb_proc_[0-9a-f]{24}_0 = /u);
    assert.match(planned.sql,/\(\?, @rb_proc_[0-9a-f]{24}_2, @rb_proc_[0-9a-f]{24}_3\)$/u);
    const document=await reviewDocument(planned.uri);
    assert.match(document,/Oracle PL\/SQL/);
    assert.match(document,/OUT and INOUT values share the isolated invocation session/);
    assert.match(document,/read-only server transaction/);
    assert.ok(!document.includes(value.value));
    await assert.rejects(calls.run(planned.id),/Approve the exact/);
    const result=await calls.run(planned.id,{approved:true});
    assert.deepEqual(result.resultSets[0].rows,[['1234567890123456789.123458']]);
    assert.deepEqual(result.outputParameters.map(({name,mode,type,value})=>[name,mode,type,value]),[
      ['amount','INOUT','NUMBER(32,6)','1234567890123456789.123457'],
      ['note','OUT','VARCHAR2(20)',null]
    ]);
    assert.deepEqual([result.readOnlyInvocation,result.callerTransactionCommitted,result.definitionCheck],[true,false,'before-and-after']);
    const scalar=await openResult({resultId:result.resultId,index:0});
    const outputs=await openResult({resultId:result.resultId,index:1});
    assert.equal(scalar.executedSql,false);
    assert.equal(outputs.executedSql,false);
    assert.equal(outputs.outputParameters,true);
    await assert.rejects(calls.run(planned.id,{approved:true}),/expired or the connection changed/);
    const invoke=async target=>calls.run(calls.prepare((await calls.inspect(member(target))).id,[]).id,{approved:true});
    const out=await invoke('output_only');
    assert.deepEqual(out.resultSets[0].rows,[[null]]);
    assert.equal(out.outputParameters[0].value,'9007199254740993');
    await assert.rejects(invoke('write_attempt'),{causeCode:'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION'});
    assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM '+audit))[0][0].n),0);

    const stale=calls.prepare((await calls.inspect(member('advance'))).id,[increment,value]);
    await connection.query('SET SESSION sql_mode=ORACLE');
    await connection.query('DROP PACKAGE BODY '+name);
    await connection.query(body('0.000002'));
    await connection.query('SET SESSION sql_mode=?',[sqlMode]);
    await assert.rejects(calls.run(stale.id,{approved:true}),/definition or input signature changed/);
    assert.deepEqual(await adapter.probe(),spring);
    return {engine:runtime.dbEngine,version,exactDecimalScalarAndInOut:true,nullableOut:true,exactBigIntOutWithoutInputs:true,
      privateMemberRefused:true,typedInputsAndReview:true,singleApprovalAndNoReplay:true,readOnlyWriteRejected:true,
      staleBodyRejected:true,capturedResultsDoNotExecuteSql:true,spring};
  } finally {
    try {await connection.query('DROP PACKAGE IF EXISTS '+name);await connection.query('DROP TABLE IF EXISTS '+audit);}
    finally {await connection.end();}
  }
}

async function runPackageFunctionOutputChecks(api,vscode,checks) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.ok((await vscode.commands.getCommands()).includes('rocketbrain.db.reviewPackageCall'));
  const result=await verifyPackageOutputWorkflow(runtime,{
    connect:options=>api.connectMysql(options),calls:api.routineCalls,
    async probe(){
      const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000)});
      assert.ok(response.ok);
      return response.json();
    },
    async reviewDocument(uri){
      const doc=await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc,{preview:false});
      return doc.getText();
    },
    openResult:target=>vscode.commands.executeCommand('rocketbrain.db.openProcedureResult',target)
  });
  checks.push('The installed routine flow verified the selected engine’s reviewed package-function output or ordinary typed procedure boundary.');
  return {...result,nativePackageOutputReview:true};
}

module.exports={verifyPackageOutputWorkflow,runPackageFunctionOutputChecks};
