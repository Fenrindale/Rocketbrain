'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

const q = String.fromCharCode(96), quote = name => q + name.replaceAll(q,q+q)+q;
const qualified = (schema,table) => quote(schema)+'.'+quote(table);
const json = async file => JSON.parse(await fs.readFile(file,'utf8'));
const comparable = file => process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);

function examples(local, remote, table) {
  return {
    inserted: 'INSERT INTO '+qualified(remote,table)+' (id,score,note) VALUES (?,?,?)',
    updated: 'UPDATE '+qualified(remote,table)+' AS d SET d.score = d.score + ? WHERE d.id = ?',
    deleted: 'DELETE FROM '+qualified(remote,table)+' WHERE score = ? AND id = ?',
    local: 'INSERT INTO '+qualified(local,table)+' (id,score,note) VALUES (12,99,\'score is literal\')',
    unsupported: 'UPDATE '+qualified(remote,table)+' a JOIN '+qualified(local,table)+' b ON a.id=b.id SET a.score=b.score'
  };
}

async function withDmlFixture(workspace, run) {
  const runtime=await json(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG), config=await json(runtime.dbConfigPath);
  const ownerFolder=path.dirname(await fs.realpath(runtime.dbConfigPath)), owner=await json(path.join(ownerFolder,'owner.json'));
  const cross=await json(path.join(ownerFolder,'cross-schema.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(owner.id,path.basename(ownerFolder));
  assert.equal(cross.fixtureId,owner.id);
  assert.deepEqual(cross.schemas,[config.database,'rocketbrain_related']);
  assert.equal(config.host,'127.0.0.1');
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const spring=await jdbcReadback(), [local,remote]=cross.schemas, table='rb_dml_'+randomBytes(5).toString('hex');
  const actor=await mysql.createConnection(config), created=[], statements=examples(local,remote,table);
  let directory, marker, identity, parent;
  try{
    const [[server]]=await actor.query('SELECT @@datadir AS datadir');
    assert.equal(comparable(path.dirname(await fs.realpath(server.datadir))),comparable(ownerFolder));
    for(const schema of [local,remote]){
      await actor.query('CREATE TABLE '+qualified(schema,table)+' (id INT PRIMARY KEY,score '+(schema===remote?'INT':'BIGINT')+
        ' NOT NULL,note VARCHAR(80) NULL) ENGINE=InnoDB');
      created.push(schema);
    }
    await actor.beginTransaction();
    try{
      assert.equal((await actor.execute(statements.inserted,[9,4,'score literal']))[0].affectedRows,1);
      assert.equal((await actor.execute(statements.updated,[3,9]))[0].affectedRows,1);
      const [[row]]=await actor.query('SELECT score FROM '+qualified(remote,table)+' WHERE id=9');
      assert.equal(row.score,7);
      assert.equal((await actor.execute(statements.deleted,[7,9]))[0].affectedRows,1);
      assert.equal((await actor.query(statements.local))[0].affectedRows,1);
    }finally{await actor.rollback();}
    for(const schema of [local,remote]){
      const [[{ count }]]=await actor.query('SELECT COUNT(*) AS count FROM '+qualified(schema,table));
      assert.equal(Number(count),0);
    }
    parent=await fs.realpath(workspace);
    directory=await fs.mkdtemp(path.join(parent,'rb-dml-usages-'));
    marker=path.join(directory,'owner.txt');
    identity=randomUUID();
    await fs.writeFile(marker,identity,{flag:'wx'});
    const javaRoot=path.join(directory,'java'), sqlRoot=path.join(directory,'sql');
    await Promise.all([fs.mkdir(javaRoot),fs.mkdir(sqlRoot)]);
    const sqlFile=path.join(sqlRoot,'mutations.sql'), javaFile=path.join(javaRoot,'Mutations.java'), unsupported=path.join(sqlRoot,'joined.sql');
    const sqlText=[statements.inserted,statements.updated,statements.deleted,statements.local].join(';\n')+';\n';
    const embedded='UPDATE '+qualified(remote,table)+' SET score = ? WHERE id = ?';
    const javaText='import org.springframework.jdbc.core.JdbcTemplate;\nclass Mutations {\n'+
      '  void write(JdbcTemplate jdbc) { jdbc.update("'+embedded+'", 42, 9); }\n}\n';
    await Promise.all([fs.writeFile(sqlFile,sqlText),fs.writeFile(javaFile,javaText),fs.writeFile(unsupported,statements.unsupported+';\n')]);
    const result=await run({runtime,config,actor,local,remote,table,sqlRoot,javaRoot,sqlFile,javaFile,sqlText,javaText,unsupported,statements});
    assert.deepEqual(await jdbcReadback(),spring);
    return {engine:runtime.dbEngine,spring,actualTransactionalInsertUpdateDelete:true,rolledBackFixture:true,...result};
  }finally{
    try{
      if(directory){
        assert.equal(await fs.readFile(marker,'utf8'),identity);
        assert.equal(comparable(path.dirname(await fs.realpath(directory))),comparable(parent));
        assert.ok(path.basename(directory).startsWith('rb-dml-usages-'));
        await fs.rm(directory,{recursive:true,force:true});
      }
    }finally{
      try{for(const schema of created)await actor.query('DROP TABLE IF EXISTS '+qualified(schema,table));}
      finally{await actor.end();}
    }
  }
}

function request(fixture, database=fixture.remote) {
  return {kind:'column',database,table:fixture.table,column:'score'};
}

async function checkProject(api,fixture) {
  const selected=await api.findCatalogReferences(request(fixture));
  assert.equal(selected.references.length,5);
  assert.deepEqual(selected.coverage.dml,{readReferences:2,writeReferences:3});
  assert.equal(selected.coverage.complete,false);
  assert.equal(selected.coverage.sourceRenameEligible,false);
  assert.equal(selected.executedSql,false);
  assert.ok(selected.coverage.unknownFiles.some(file=>file.uri&&comparable(fileURLToPath(file.uri))===comparable(fixture.unsupported)));
  for(const ref of selected.references){
    const source=ref.language==='java'?fixture.javaText:fixture.sqlText;
    assert.equal(source.slice(ref.start,ref.end),'score');
    assert.equal(ref.target.database,fixture.remote);
    assert.equal(ref.editEligible,false);
  }
  const local=await api.findCatalogReferences(request(fixture,fixture.local));
  assert.equal(local.references.length,1);
  assert.deepEqual(local.coverage.dml,{readReferences:0,writeReferences:1});
  await assert.rejects(api.planCatalogRename(request(fixture,fixture.local),'next_score'),{code:'SQL_PROJECT_INCOMPLETE'});
  return {remoteUsages:5,localUsages:1,embeddedWrite:true,exactRoles:true,rejectedJoinedMutation:true,renameGuard:true,executedSql:false};
}

async function runSqlSingleTableDmlChecks(api,vscode,checks) {
  return withDmlFixture(vscode.workspace.workspaceFolders[0].uri.fsPath,async fixture=>{
    const settings=vscode.workspace.getConfiguration('rocketbrain.sql.project'), keys=['roots','javaRoots'];
    const previous=Object.fromEntries(keys.map(key=>[key,settings.inspect(key)?.globalValue]));
    try{
      await settings.update('roots',[fixture.sqlRoot],vscode.ConfigurationTarget.Global);
      await settings.update('javaRoots',[fixture.javaRoot],vscode.ConfigurationTarget.Global);
      await api.connectMysql(fixture.config);
      await api.sqlAnalysis.refreshMetadata();
      const result=await checkProject(api.sqlAnalysis,fixture);
      const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.sqlFile));
      const java=await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.javaFile));
      const write=doc.positionAt(doc.getText().indexOf('d.score')+3), read=doc.positionAt(doc.getText().lastIndexOf('d.score')+3);
      const embedded=java.positionAt(java.getText().indexOf('SET score')+6);
      await vscode.window.showTextDocument(doc);
      for(const [file,at] of [[doc,write],[java,embedded]]){
        const refs=await vscode.commands.executeCommand('vscode.executeReferenceProvider',file.uri,at);
        const owned=refs.filter(ref=>ref.uri.scheme==='file'&&
          [fixture.sqlFile,fixture.javaFile].some(name=>comparable(name)===comparable(ref.uri.fsPath)));
        assert.equal(owned.length,5);
        for(const ref of owned)assert.equal((await vscode.workspace.openTextDocument(ref.uri)).getText(ref.range),'score');
      }
      for(const [at,role] of [[write,'write target'],[read,'read reference']]){
        const links=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',doc.uri,at);
        const found=links.find(link=>(link.uri||link.targetUri)?.scheme==='rocketbrain-object-source');
        assert.ok(found,role+' DDL reference missing');
        const ddl=await vscode.workspace.openTextDocument(found.uri||found.targetUri);
        assert.equal(ddl.getText(found.range||found.targetSelectionRange),quote('score'));
        const [[direct]]=await fixture.actor.query('SHOW CREATE TABLE '+qualified(fixture.remote,fixture.table));
        assert.equal(ddl.getText(),direct['Create Table']);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),doc.uri.toString());
        const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',doc.uri,at);
        const values=hovers.flatMap(h=>h.contents.map(value=>typeof value==='string'?value:value.value)).join('\n');
        const summary='UPDATE '+role+' · table column '+fixture.remote+'.'+fixture.table+'.score';
        assert.ok(values.includes(new vscode.MarkdownString().appendText(summary).value),
          summary+' absent from '+values.slice(0,600));
      }
      checks.push('Native SQL references distinguish exact INSERT/UPDATE writes from RHS/WHERE reads, navigate cross-schema DDL, and locate an embedded Java UPDATE target.');
      return {...result,nativeProviders:true,exactDdl:true,readWriteQuickInfo:true};
    }finally{
      try{for(const key of keys)await settings.update(key,previous[key],vscode.ConfigurationTarget.Global);}
      finally{await api.disconnectMysql();}
    }
  });
}

function host(fixture,db,metadata) {
  const {registerSQLAnalysis}=require('../src/db/sql-vscode');
  const some=()=>({dispose(){}});
  const uri=file=>({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});
  const docs=new Map();
  const vscode={
    EventEmitter:class{event=()=>some();fire(){}dispose(){}},
    RelativePattern:class{constructor(base,pattern){Object.assign(this,{base,pattern});}},
    languages:{createDiagnosticCollection:()=>({clear(){},dispose(){}})},
    commands:{registerCommand:some},
    workspace:{
      isTrusted:true,workspaceFolders:[{uri:uri(path.dirname(fixture.sqlRoot))}],
      getConfiguration:()=>({get:(key,fallback)=>key==='roots'?[fixture.sqlRoot]:key==='javaRoots'?[fixture.javaRoot]:fallback}),
      onDidChangeTextDocument:some,onDidCloseTextDocument:some,onDidChangeConfiguration:some,
      async findFiles(pattern){return (await fs.readdir(pattern.base)).map(name=>uri(path.join(pattern.base,name)));},
      async openTextDocument(value){
        if(!docs.has(value.fsPath)){
          const text=await fs.readFile(value.fsPath,'utf8');
          docs.set(value.fsPath,{uri:value,version:1,getText:()=>text});
        }
        return docs.get(value.fsPath);
      }
    }
  };
  for(const key of ['CompletionItem','Definition','Hover'])vscode.languages['register'+key+'Provider']=some;
  return registerSQLAnalysis({},vscode,{catalogSnapshot:()=>metadata,joinCatalog:input=>db.joinCompletionCatalog(input)});
}

async function verifySqlDmlBackend() {
  const {MysqlService}=require('../src/db/mysql');
  const {liveNavigation}=require('../src/db/sql-live-navigation');
  const {contextOf,loadSource}=require('../src/db/object-source');
  const {ddlDefinitionLocation}=require('../src/db/sql-ddl-location');
  const runtime=await json(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  return withDmlFixture(runtime.projectPath,async fixture=>{
    const db=new MysqlService(fixture.config);
    let api;
    try{
      const catalog=await db.metadata(), options={dialect:catalog.dialect,sqlMode:catalog.sqlMode,tableNameCaseSensitive:catalog.tableNameCaseSensitive};
      api=host(fixture,db,catalog);
      const proof=await checkProject(api,fixture);
      const text=fixture.statements.updated, offset=text.indexOf('d.score')+3;
      const pending=liveNavigation(text,offset,catalog,options);
      const scoped=await db.joinCompletionCatalog({endpoints:pending.endpoints,includeEdges:false});
      const target=liveNavigation(text,offset,catalog,options,scoped.tables);
      assert.equal(target.usage,'write');
      assert.equal(target.object.schema,fixture.remote);
      const query=(sql,values)=>db._metadataQuery(sql,values);
      const loaded=await loadSource(query,await contextOf(query),target.object);
      const span=ddlDefinitionLocation(loaded,target.member,options.sqlMode);
      assert.equal(loaded.source.slice(span.start,span.end),quote('score'));
      return {...proof,nativeProviders:false,exactDdl:true};
    }finally{api?.dispose();await db.dispose();}
  });
}

if(require.main===module)verifySqlDmlBackend().then(result=>console.log(JSON.stringify(result)),error=>{
  console.error(error.stack);process.exitCode=1;
});
module.exports={runSqlSingleTableDmlChecks,verifySqlDmlBackend};
