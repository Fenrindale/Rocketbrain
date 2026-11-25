'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto'),mysql=require('mysql2/promise');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

async function verifySqlWindowChecks(runtime,adapter) {
  const config=await read(runtime.dbConfigPath),folder=path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner=await read(path.join(folder,'owner.json')),isMaria=runtime.dbEngine==='mariadb';
  assert.equal(owner.kind,isMaria?'RocketbrainDisposableMariaDbFixture-v1':'RocketbrainDisposableOracleMysqlFixture-v1');
  assert.equal(owner.id,path.basename(folder));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const actor=await mysql.createConnection(config),table='rb_window_editor_'+randomBytes(5).toString('hex');
  const from=' FROM '+table+' p', select=expressions=>'SELECT '+expressions+from;
  const cases=[
    [select('RANK() OVER missing'),'sql.window.name','missing',isMaria?4009:3579],
    [select('RANK() OVER dupe')+' WINDOW dupe AS (ORDER BY p.id), dupe AS ()','sql.window.name.duplicate','dupe',isMaria?4010:3591],
    [select('p.id')+' WHERE ROW_NUMBER() OVER (ORDER BY p.id)=1','sql.window.location','OVER',isMaria?4015:3593],
    [select('SUM(DISTINCT p.amount) OVER (ORDER BY p.id)'),'sql.window.distinct','DISTINCT',1235],
    [select('SUM(p.amount) OVER (ROWS 1.5 PRECEDING)'),'sql.window.frame.offset','1.5',isMaria?4020:3586],
    [select('SUM(p.amount) OVER (ROWS BETWEEN UNBOUNDED FOLLOWING AND UNBOUNDED FOLLOWING)'),
      'sql.window.frame.boundary','UNBOUNDED FOLLOWING',isMaria?4014:3584],
    [select('SUM(p.amount) OVER (ORDER BY p.id ROWS BETWEEN CURRENT ROW AND 1 PRECEDING)'),
      'sql.window.frame.boundary','1 PRECEDING',isMaria?4014:3586],
    [select('SUM(p.amount) OVER (RANGE 1 PRECEDING)'),'sql.window.frame.orderCount','RANGE',isMaria?4019:3587],
    [select('SUM(p.amount) OVER (ORDER BY p.id,p.label RANGE 1 PRECEDING)'),'sql.window.frame.orderCount','RANGE',isMaria?4019:3587],
    [select('SUM(p.amount) OVER (ORDER BY p.label RANGE 1 PRECEDING)'),'sql.window.frame.orderType','p.label',isMaria?4021:3587],
    [select('SUM(p.amount) OVER (ORDER BY p.moment RANGE 1 PRECEDING)'),'sql.window.frame.orderType','p.moment',isMaria?4021:3588],
    ...(isMaria?[
      [select('RANK() OVER ()'),'sql.window.order.required','OVER',4018],
      [select('ROW_NUMBER() OVER (ORDER BY p.id ROWS 1 PRECEDING)'),'sql.window.frame.function','ROWS',4017],
      [select('SUM(p.amount) OVER (ORDER BY p.moment RANGE INTERVAL 1 DAY PRECEDING)'),'sql.window.frame.interval','INTERVAL 1 DAY',1064]
    ]:[
      [select('SUM(p.amount) OVER (ORDER BY p.id RANGE INTERVAL 1 DAY PRECEDING)'),'sql.window.frame.orderType','p.id',3589],
      [select('LAG(p.label,-1) OVER (ORDER BY p.id)'),'sql.window.argument','-1',1064],
      [select('NTH_VALUE(p.label,0) OVER (ORDER BY p.id)'),'sql.window.argument','0',1210]
    ])
  ];
  try {
    const [[{datadir}]]=await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(),folder.toLowerCase());
    const spring=await adapter.probe();
    assert.equal(spring.people,2);
    await actor.query('CREATE TABLE '+table+' (id INT PRIMARY KEY, team INT NOT NULL, label VARCHAR(30) NOT NULL, amount DECIMAL(12,2) NOT NULL, moment DATE NOT NULL) ENGINE=InnoDB');
    await actor.query('INSERT INTO '+table+" SELECT id, 1, CONCAT('person-',id), 9.25+id, DATE_ADD('2020-01-01',INTERVAL id DAY) FROM rb_spring_person");
    await adapter.connect(config);
    const typed=select('p.id, RANK() OVER ranked AS row_rank, FIRST_VALUE(p.label) OVER ranked AS first_label, '+
      'SUM(p.amount) OVER (ranked ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS rolling, '+
      'CUME_DIST() OVER ranked AS distribution, LAG(p.label) OVER ranked AS previous')+
      ' WINDOW grouped AS (PARTITION BY p.team), ranked AS (grouped ORDER BY p.id) ORDER BY p.id';
    const valid=await adapter.analyze(typed);
    assert.equal(valid.model.state,'known',JSON.stringify(valid.model.coverage));
    assert.equal(valid.model.executedSql,false);
    assert.deepEqual(valid.model.projections.map(column=>column.type.family),['integer','integer','string','decimal','floating','string']);
    const body=valid.model.references.find(ref=>ref.kind==='window' && ref.start===typed.indexOf('OVER ranked')+5);
    assert.equal(body.definition.start,typed.indexOf('ranked AS (grouped'));
    assert.ok(valid.model.references.some(ref=>ref.kind==='column'&&ref.name==='team'));
    await adapter.assertDefinition?.(valid.document,body);
    const [rows]=await actor.query(typed);
    assert.deepEqual(rows.map(row=>[Number(row.id),Number(row.row_rank),row.first_label,Number(row.rolling),Number(row.distribution),row.previous]),[
      [1,1,'person-1',10.25,0.5,null],[2,2,'person-1',21.5,1,'person-1']
    ]);

    const parity=[];
    for(const [sql,code,anchor,errno] of cases) {
      const report=await adapter.analyze(sql),diagnostics=report.model.diagnostics.filter(item=>item.code.startsWith('sql.window.'));
      assert.deepEqual(diagnostics.map(item=>[item.code,sql.slice(item.start,item.end)]),[[code,anchor]],sql);
      assert.equal(report.model.executedSql,false);
      await adapter.assertDiagnostics?.(report.document,[[code,anchor]]);
      await assert.rejects(actor.query(sql),error=>error.errno===errno,sql);
      parity.push([code,errno]);
    }

    const distinctBehavior=isMaria?
      select('LAG(p.label,-1) OVER (ORDER BY p.id) AS next_label, NTH_VALUE(p.label,0) OVER (ORDER BY p.id) AS zero_value')+' ORDER BY p.id':
      select('RANK() OVER () AS shared_rank, SUM(p.amount) OVER (ORDER BY p.moment RANGE INTERVAL 1 DAY PRECEDING) AS day_sum')+' ORDER BY p.id';
    const distinctReport=await adapter.analyze(distinctBehavior);
    assert.deepEqual(distinctReport.model.diagnostics,[]);
    const [distinctRows]=await actor.query(distinctBehavior);
    if(isMaria) assert.deepEqual(distinctRows.map(row=>[row.next_label,row.zero_value]),[['person-2',null],[null,null]]);
    else assert.deepEqual(distinctRows.map(row=>[Number(row.shared_rank),Number(row.day_sum)]),[[1,10.25],[1,21.5]]);

    const empty=select('SUM(p.amount) OVER (ORDER BY p.id ROWS BETWEEN 1 PRECEDING AND 2 PRECEDING) AS empty_frame');
    assert.deepEqual((await adapter.analyze(empty)).model.diagnostics,[]);
    assert.equal((await actor.query(empty))[0][0].empty_frame,null);
    await adapter.repair?.(select('SUM(p.amount) OVER (ORDER BY p.label RANGE 1 PRECEDING)'));
    assert.deepEqual(await adapter.probe(),spring);
    return {engine:runtime.dbEngine,typedWindowResults:5,sourceDeclarationLinked:true,inheritedPartitionAndOrder:true,
      exactRanges:true,diagnosticServerParity:parity,dialectCasesPreserved:true,emptySameDirectionFrame:true,
      nativeDefinition:Boolean(adapter.assertDefinition),nativeEditRefresh:Boolean(adapter.repair),analysisExecutedSql:false,spring};
  } finally {
    try {await adapter.disconnect();await actor.query('DROP TABLE IF EXISTS '+table);}
    finally {await actor.end();}
  }
}

async function runSqlWindowChecks(api,vscode,checks) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const diagnostics=document=>vscode.languages.getDiagnostics(document.uri).filter(item=>String(item.code).startsWith('sql.window.'));
  const result=await verifySqlWindowChecks(runtime,{
    connect:api.connectMysql,disconnect:api.disconnectMysql,
    async analyze(text) {
      const document=await vscode.workspace.openTextDocument({language:'sql',content:text});
      const report=api.sqlAnalysis.analyzeDocument(document);
      return {document,model:report.statements[0].model};
    },
    async assertDefinition(document,ref) {
      const position=document.positionAt(ref.start+2);
      const results=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,position);
      assert.ok(results.some(link=>{
        const uri=link.targetUri||link.uri,range=link.targetSelectionRange||link.range;
        return uri?.toString()===document.uri.toString() && range && document.offsetAt(range.start)===ref.definition.start;
      }));
    },
    assertDiagnostics(document,expected) {
      const actual=diagnostics(document);
      assert.deepEqual(actual.map(item=>[item.code,document.getText(item.range)]),expected);
      assert.ok(actual.every(item=>item.source==='Rocketbrain SQL (source model)'));
    },
    async repair(text) {
      const document=await vscode.workspace.openTextDocument({language:'sql',content:text});
      api.sqlAnalysis.analyzeDocument(document);
      const [problem]=diagnostics(document);
      assert.equal(problem.code,'sql.window.frame.orderType');
      const edit=new vscode.WorkspaceEdit();
      edit.replace(document.uri,problem.range,'p.id');
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
  checks.push('The installed SQL editor bound named and inherited windows and matched frame diagnostics to actual DB errors. Go to Definition and editing used exact source ranges.');
  return result;
}

module.exports={verifySqlWindowChecks,runSqlWindowChecks};
