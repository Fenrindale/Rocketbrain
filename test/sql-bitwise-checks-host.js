'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto'),mysql=require('mysql2/promise');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const warning=text=>['sql.bitwise.coercion',text,'warning'];
const mismatch=(symbol,severity='error')=>['sql.bitwise.binaryLength',symbol,severity];

async function verifySqlBitwiseChecks(runtime,adapter) {
  const config=await read(runtime.dbConfigPath),folder=path.dirname(await fs.realpath(runtime.dbConfigPath));
  const marker=await read(path.join(folder,'owner.json')),isMaria=runtime.dbEngine==='mariadb';
  assert.equal(marker.kind,isMaria?'RocketbrainDisposableMariaDbFixture-v1':'RocketbrainDisposableOracleMysqlFixture-v1');
  assert.equal(marker.id,path.basename(folder));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const actor=await mysql.createConnection({...config,supportBigNumbers:true,bigNumberStrings:true}),table='rb_bit_editor_'+randomBytes(5).toString('hex');
  const select=(expression,id=1)=>'SELECT '+expression+' AS value FROM '+table+' p WHERE p.id='+id;
  const integer={family:'integer',type:8},binary={family:'binary',type:253};
  const bytes=isMaria?integer:binary;
  const scope = [
    ["p.one_byte | X'01'",bytes,isMaria?5:'35',isMaria?[warning("X'01'")]:[]],
    ["_binary X'40' | X'01'",bytes,isMaria?0:'41',isMaria?[warning("_binary X'40'"),warning("X'01'")]:[]],
    ["X'40' | 0x01",integer,isMaria?1:65,isMaria?[warning("X'40'")]:[]],
    ["B'10000' ^ 0b01",integer,17,[]],
    ['p.one_byte | p.two_bytes',bytes,isMaria?13:null,isMaria?[]:[mismatch('|')],isMaria?null:3513],
    ['p.one_byte ^ p.maybe_width',bytes,null,isMaria?[]:[mismatch('^','warning')],null,0],
    ["CAST('5' AS BINARY(1)) | CAST('12' AS BINARY(2))",bytes,isMaria?13:null,isMaria?[]:[mismatch('|')],isMaria?null:3513],
    ["CAST(NULL AS BINARY(1)) | CAST('12' AS BINARY(2))",bytes,null,[]],
    ['p.one_byte | NULL',bytes,null,[]],
    ['~p.one_byte',bytes,isMaria?'18446744073709551610':'ca',[]],
    ['p.one_byte << 1',bytes,isMaria?10:'6a',[]],
    ["p.one_byte >> '2x'",bytes,isMaria?1:'0d',[warning("'2x'")]],
    ["BIT_COUNT(p.one_byte)",{...integer,type:isMaria?3:8},isMaria?2:4,[]],
    ["BIT_COUNT('text')",{...integer,type:isMaria?3:8},0,[warning("'text'")]],
    ["'12x' & 7",integer,4,[warning("'12x'")]],
    ["'12.5' & 7",integer,isMaria?5:4,isMaria?[]:[warning("'12.5'")]],
    ["'1e2' & 7",integer,isMaria?4:1,isMaria?[]:[warning("'1e2'")]],
    ["' 12 ' & 7",integer,4,isMaria?[warning("' 12 '")]:[]],
    ['p.flags | p.one_byte',integer,5,[]],
    ['p.id | p.flags & 1 << 2',integer,5,[]],
    ['p.id & 1 = 1',{family:'boolean',type:isMaria?3:8},1,[]],
    ['p.id | 2 ^ 7 * 3',integer,15,[]],
    ...(!isMaria?[["X'FFFFFFFFFFFFFFFFFFFFFF' | X'1A'",integer,26,[warning("X'FFFFFFFFFFFFFFFFFFFFFF'")]]]:[])
  ];
  const confirmed=[];
  try {
    const [[{datadir}]]=await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(),folder.toLowerCase());
    const spring=await adapter.probe();
    assert.equal(spring.people,2);
    await actor.query('CREATE TABLE '+table+' (id INT PRIMARY KEY, one_byte BINARY(1) NOT NULL, two_bytes BINARY(2) NOT NULL, maybe_width BINARY(2) NULL, var_width VARBINARY(16), flags BIT(8) NOT NULL) ENGINE=InnoDB');
    await actor.query('INSERT INTO '+table+" SELECT id, X'35', X'3132', NULL, IF(id=1,X'35',X'3132'), B'00000101' FROM rb_spring_person");
    await adapter.connect(config);
    for (const [expr,shape,value,expected,errno,noOfWarnings] of scope) {
      const sql=select(expr),report=await adapter.analyze(sql);
      const diagnostics=report.model.diagnostics.filter(item=>item.code.startsWith('sql.bitwise.'));
      assert.deepEqual(diagnostics.map(item=>[item.code,sql.slice(item.start,item.end),item.severity]),expected,sql);
      assert.equal(report.model.executedSql,false);
      assert.equal(report.model.projections[0].type.family,shape.family,sql);
      await adapter.assertDiagnostics?.(report.document,expected);
      if(errno) {
        await assert.rejects(actor.query(sql),error=>error.errno===errno,sql);
        confirmed.push({outcome:'error',errno});
      } else {
        const [[row],fields]=await actor.query(sql);
        const [warned]=await actor.query('SHOW WARNINGS');
        assert.equal(fields[0].columnType,shape.type,sql);
        const stored=Buffer.isBuffer(row.value)?row.value.toString('hex'):
          typeof value==='number'?Number(row.value):row.value;
        assert.equal(stored,value,sql);
        const count=noOfWarnings??expected.filter(item=>item[0]==='sql.bitwise.coercion').length;
        assert.deepEqual(warned.map(item=>Number(item.Code)),Array.from({length:count},()=>1292),sql);
        confirmed.push({outcome:count?'warning':'accepted',family:shape.family,providerFieldType:shape.type,warnings:count});
      }
    }
    const variable=select('p.one_byte | p.var_width');
    const checked=await adapter.analyze(variable);
    assert.deepEqual(checked.model.diagnostics,[]);
    assert.ok(checked.model.coverage.unknown.some(item=>item.reason.includes(isMaria?'numeric conversion':'byte lengths')));
    assert.equal(checked.model.projections[0].type.family,bytes.family);
    assert.equal((await actor.query(variable))[0].length,1);
    const longer=select('p.one_byte | p.var_width',2);
    assert.deepEqual((await adapter.analyze(longer)).model.diagnostics,[]);
    if (isMaria) assert.equal(Number((await actor.query(longer))[0][0].value),13);
    else await assert.rejects(actor.query(longer),{errno:3513});
    const invalidCount=select('BIT_COUNT()'), arity=await adapter.analyze(invalidCount);
    assert.equal(arity.model.diagnostics[0]?.code,'sql.bitwise.arity');
    await assert.rejects(actor.query(invalidCount),{errno:1582});
    await adapter.repair?.(select("'invalid' & 1"));
    assert.deepEqual(await adapter.probe(),spring);
    return {engine:runtime.dbEngine,confirmed,exactOperandAndOperatorRanges:true,unknownByteLengthsOrValuesRetained:true,
      binaryAndUnsignedFieldTypes:true,computedPrecedence:true,countArity:true,nativeEditRefresh:Boolean(adapter.repair),
      analysisExecutedSql:false,spring};
  } finally {
    try {await adapter.disconnect();await actor.query('DROP TABLE IF EXISTS '+table);}
    finally {await actor.end();}
  }
}

async function runSqlBitwiseChecks(api,vscode,checks) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const diagnostics=document=>vscode.languages.getDiagnostics(document.uri).filter(item=>String(item.code).startsWith('sql.bitwise.'));
  const result=await verifySqlBitwiseChecks(runtime,{
    connect:api.connectMysql,disconnect:api.disconnectMysql,
    async analyze(text) {
      const document=await vscode.workspace.openTextDocument({language:'sql',content:text});
      const report=api.sqlAnalysis.analyzeDocument(document);
      return {document,model:report.statements[0].model};
    },
    assertDiagnostics(document,expected) {
      const observed=diagnostics(document);
      assert.deepEqual(observed.map(item=>[item.code,document.getText(item.range),
        item.severity===vscode.DiagnosticSeverity.Warning?'warning':'error']),expected);
      assert.ok(observed.every(item=>item.source==='Rocketbrain SQL (source model)'));
    },
    async repair(text) {
      const document=await vscode.workspace.openTextDocument({language:'sql',content:text});
      api.sqlAnalysis.analyzeDocument(document);
      const [problem]=diagnostics(document);
      assert.equal(problem.code,'sql.bitwise.coercion');
      const edit=new vscode.WorkspaceEdit();
      edit.replace(document.uri,problem.range,'1');
      assert.equal(await vscode.workspace.applyEdit(edit),true);
      api.sqlAnalysis.analyzeDocument(document);
      assert.deepEqual(diagnostics(document),[]);
    },
    async probe() {
      const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000)});
      assert.ok(response.ok);
      return response.json();
    }
  });
  checks.push('Native SQL diagnostics distinguished bitwise binary and numeric modes, highlighted exact operands and updated after an edit. The fixture confirmed server types and outcomes.');
  return result;
}

module.exports={verifySqlBitwiseChecks,runSqlBitwiseChecks};
