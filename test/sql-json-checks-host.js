'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
const projectTypes = model => model.projections.map(column=>column.type.family);

async function verifySqlJsonChecks(runtime, adapter) {
  const config = await read(runtime.dbConfigPath), folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = await read(path.join(folder,'owner.json'));
  assert.equal(owner.kind,runtime.dbEngine === 'mysql' ? 'RocketbrainDisposableOracleMysqlFixture-v1' : 'RocketbrainDisposableMariaDbFixture-v1');
  assert.equal(owner.id,path.basename(folder));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const actor = await mysql.createConnection(config), table = 'rb_json_editor_' + randomBytes(5).toString('hex');
  const select = expressions=>'SELECT ' + expressions + ' FROM ' + table + ' d ORDER BY d.id LIMIT 1';
  const negative = [
    ["JSON_EXTRACT(d.document)",'sql.json.arity','JSON_EXTRACT'],
    ["JSON_SET(d.document,'$.name')",'sql.json.arity','JSON_SET'],
    ["JSON_EXTRACT(d.document,'items[0]')",'sql.json.path',"'items[0]'"],
    ["JSON_EXTRACT(d.document,'$.items[')",'sql.json.path',"'$.items['"],
    ["JSON_SET(d.document,'$.items[*]',1)",'sql.json.path.multiple',"'$.items[*]'"],
    ["JSON_CONTAINS_PATH(d.document,'some','$.name')",'sql.json.mode',"'some'"],
    ["JSON_TYPE('not JSON')",'sql.json.document',"'not JSON'"],
    ...(runtime.dbEngine === 'mysql' ? [["JSON_OBJECT(NULL,1)",'sql.json.key','NULL']] :
      [["JSON_LENGTH(d.document,'$.items[*]')",'sql.json.path.multiple',"'$.items[*]'"]])
  ];
  const parity = [];
  try {
    const [[datadir]] = await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir.datadir)).toLowerCase(),folder.toLowerCase());
    const spring = await adapter.probe();
    assert.equal(spring.people,2);
    await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, document JSON NOT NULL, runtime_path VARCHAR(32) NOT NULL) ENGINE=InnoDB');
    await actor.query('INSERT INTO ' + table + ' SELECT id, ?, ? FROM rb_spring_person',[
      JSON.stringify({name:'Seoul',items:[{name:'a'},{name:'b'}]}),'$.name'
    ]);
    await adapter.connect(config);
    const typed = select("JSON_LENGTH(d.document,'$.items') AS total, JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.name')) AS name, JSON_SET(d.document,'$.x',3) AS changed, JSON_CONTAINS_PATH(d.document,'all','$.name','$.items[*]') AS found");
    const typedReport = await adapter.analyze(typed);
    assert.deepEqual(projectTypes(typedReport.model),['integer','string','json','integer']);
    assert.deepEqual(typedReport.model.diagnostics,[]);
    assert.equal(typedReport.model.executedSql,false);
    assert.ok(typedReport.model.references.some(ref=>ref.name==='document'&&ref.kind==='column'));
    const [[row]] = await actor.query(typed);
    assert.equal(Number(row.total),2);
    assert.equal(row.name,'Seoul');
    assert.equal(Number(row.found),1);
    assert.equal((typeof row.changed==='string' ? JSON.parse(row.changed) : row.changed).x,3);

    for (const [expr,code,token] of negative) {
      const sql = select(expr), captured = await adapter.analyze(sql);
      const issues = captured.model.diagnostics.filter(item=>item.code.startsWith('sql.json.'));
      assert.deepEqual(issues.map(item=>[item.code,sql.slice(item.start,item.end)]),[[code,token]],sql);
      assert.equal(captured.model.executedSql,false);
      await adapter.assertDiagnostics?.(captured.document,[[code,token]]);
      let serverOutcome, failing;
      try { await actor.query(sql); }
      catch (error) { failing = error; }
      if (failing) {
        assert.ok(failing.errno && failing.sqlMessage,sql);
        serverOutcome = 'error';
      } else {
        const [warnings] = await actor.query('SHOW WARNINGS');
        assert.ok(warnings.some(item=>String(item.Level).toLowerCase()==='warning'),sql);
        serverOutcome = 'warning';
      }
      parity.push([code,serverOutcome]);
    }
    const dynamic = select('JSON_UNQUOTE(JSON_EXTRACT(d.document,d.runtime_path)) AS city');
    const retained = await adapter.analyze(dynamic);
    assert.deepEqual(retained.model.diagnostics,[]);
    assert.ok(retained.model.coverage.unknown.some(item=>item.reason.includes('path value or string decoding')));
    assert.equal((await actor.query(dynamic))[0][0].city,'Seoul');

    const dialectSql = runtime.dbEngine === 'mysql' ?
      select("d.document->>'$.name' AS city") : select("JSON_UNQUOTE(JSON_EXTRACT(d.document,'lax $.name')) AS city");
    const dialect = await adapter.analyze(dialectSql);
    assert.deepEqual(projectTypes(dialect.model),['string']);
    assert.deepEqual(dialect.model.diagnostics,[]);
    assert.equal((await actor.query(dialectSql))[0][0].city,'Seoul');
    const versionControl = runtime.dbEngine === 'mysql' ?
      select("JSON_LENGTH(d.document,'$.items[*]') AS count_value") : select('JSON_OBJECT(NULL,1) AS native_object');
    assert.deepEqual((await adapter.analyze(versionControl)).model.diagnostics,[]);
    const [[versionResult]] = await actor.query(versionControl);
    if (runtime.dbEngine === 'mysql') assert.equal(Number(versionResult.count_value),2);
    else assert.ok(versionResult.native_object!==null);
    const raw = select("JSON_VALID('not JSON') AS invalid");
    assert.deepEqual((await adapter.analyze(raw)).model.diagnostics,[]);
    assert.equal(Number((await actor.query(raw))[0][0].invalid),0);
    await adapter.repair?.(select("JSON_EXTRACT(d.document,'items[0]')"));
    assert.deepEqual(await adapter.probe(),spring);
    return { engine:runtime.dbEngine,typedResults:4,diagnosticServerParity:parity,
      exactArgumentRanges:true,dynamicPathRetainsUncertainty:true,dialectPathForm:true,engineSpecificPositiveControl:true,validityCheckAcceptsMalformedData:true,
      editorRepair:Boolean(adapter.repair),analysisExecutedSql:false,spring };
  } finally {
    try {
      await adapter.disconnect();
      await actor.query('DROP TABLE IF EXISTS ' + table);
    } finally { await actor.end(); }
  }
}

async function runSqlJsonChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const diagnostics = document => vscode.languages.getDiagnostics(document.uri)
    .filter(item=>String(item.code).startsWith('sql.json.'));
  const result = await verifySqlJsonChecks(runtime,{
    connect:api.connectMysql,disconnect:api.disconnectMysql,
    async analyze(text) {
      const document = await vscode.workspace.openTextDocument({language:'sql',content:text});
      const report = api.sqlAnalysis.analyzeDocument(document);
      return {document,model:report.statements[0].model};
    },
    assertDiagnostics(document,expected) {
      const observed = diagnostics(document);
      assert.deepEqual(observed.map(item=>[item.code,document.getText(item.range)]),expected);
      assert.ok(observed.every(item=>item.source==='Rocketbrain SQL (source model)'));
    },
    async repair(sql) {
      const document = await vscode.workspace.openTextDocument({language:'sql',content:sql});
      api.sqlAnalysis.analyzeDocument(document);
      const [problem] = diagnostics(document);
      assert.equal(problem.code,'sql.json.path');
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri,problem.range,"'$.items[0]'");
      assert.equal(await vscode.workspace.applyEdit(edit),true);
      api.sqlAnalysis.analyzeDocument(document);
      assert.deepEqual(diagnostics(document),[]);
    },
    async probe() {
      const response = await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000)});
      assert.ok(response.ok);
      return response.json();
    }
  });
  checks.push('The native SQL source model typed JSON expressions and diagnosed exact invalid arguments. Editing the path cleared its warning and server checks used only owned rows.');
  return result;
}

module.exports = { verifySqlJsonChecks, runSqlJsonChecks };
