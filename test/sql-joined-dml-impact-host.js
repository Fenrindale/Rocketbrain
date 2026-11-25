'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');
const { MysqlService } = require('../src/db/mysql');
const { analyzeProjectDocument, referencesInDocument } = require('../src/db/sql-project');

const baseline = { people: 2, departments: 1, rolledBackNames: 0 };
const quote = name => '`' + name.replaceAll('`', '``') + '`';

async function fixture(run) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const { actor,config,version } = await owned(runtime.dbConfigPath);
  const suffix = randomBytes(5).toString('hex'), left='rb_impact_l_'+suffix, right='rb_impact_r_'+suffix, target='rb_impact_t_'+suffix;
  const [l,r,t] = [left,right,target].map(quote);
  const statements = [
    `INSERT INTO ${t}(id,score) SELECT a.id,a.score FROM ${l} a JOIN ${r} b ON a.id=b.id WHERE a.id=1`,
    `UPDATE ${l} a JOIN ${r} b ON a.id=b.id SET a.score=b.score+1,b.note='checked' WHERE a.id=1`,
    `DELETE a,b FROM ${l} a JOIN ${r} b ON a.id=b.id WHERE a.id=1`
  ];
  const source = statements.join(';\n') + ';\n';
  try {
    for (const table of [l,r,t]) await actor.query(`CREATE TABLE ${table}(id BIGINT PRIMARY KEY,score BIGINT NOT NULL,note VARCHAR(20)) ENGINE=InnoDB`);
    await actor.query(`INSERT INTO ${l} VALUES (1,10,NULL),(2,20,NULL)`);
    await actor.query(`INSERT INTO ${r} VALUES (1,100,NULL),(2,200,NULL)`);
    const parsed = await run({ runtime,config,left,right,target,source });
    await actor.beginTransaction();
    try {
      assert.equal((await actor.query(statements[0]))[0].affectedRows,1);
      assert.equal((await actor.query(statements[1]))[0].affectedRows,2);
      const [[updated]] = await actor.query(`SELECT CAST(a.score AS CHAR) AS left_score,b.note AS right_note FROM ${l} a JOIN ${r} b ON a.id=b.id WHERE a.id=1`);
      assert.deepEqual([updated.left_score,updated.right_note],['101','checked']);
      const [[copied]] = await actor.query(`SELECT CAST(score AS CHAR) AS score FROM ${t} WHERE id=1`);
      assert.equal(copied.score,'10');
      assert.equal((await actor.query(statements[2]))[0].affectedRows,2);
    } finally { await actor.rollback(); }
    const [[counts]]=await actor.query(`SELECT (SELECT COUNT(*) FROM ${l}) l,(SELECT COUNT(*) FROM ${r}) r,(SELECT COUNT(*) FROM ${t}) t`);
    assert.deepEqual([counts.l,counts.r,counts.t].map(Number),[2,2,0]);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc,baseline);
    return { ...parsed, engine:runtime.dbEngine,version,actualInsertSelection:true,actualWriteToTwoTargets:true,
      actualJoinedDelete:true,rollbackPreserved:true,jdbc };
  } finally {
    try { for (const table of [l,r,t]) await actor.query('DROP TABLE IF EXISTS '+table); }
    finally { await actor.end(); }
  }
}

function verifyReferences(rows, source) {
  assert.deepEqual(rows.map(row=>[row.command,row.usage]),[['INSERT','read'],['UPDATE','write']]);
  assert.ok(rows.every(row=>source.slice(row.start,row.end)==='score'&&row.editEligible===false));
}

async function runJoinedDmlImpactChecks(api,vscode,checks) {
  return fixture(async ({config,left,right,target,source})=>{
    const parent=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
    const file=path.join(parent,'rb-joined-impact-'+randomBytes(6).toString('hex')+'.sql');
    const settings=vscode.workspace.getConfiguration('rocketbrain.sql.project');
    const previous=settings.inspect('roots')?.globalValue;
    const configuration=vscode.ConfigurationTarget.Global;
    try {
      await fs.writeFile(file,source,{flag:'wx'});
      await settings.update('roots',[parent],configuration);
      await api.connectMysql(config);
      await api.sqlAnalysis.refreshMetadata();
      const report=await api.sqlAnalysis.findCatalogReferences({ kind:'column',database:config.database,table:left,column:'score' });
      assert.equal(report.executedSql,false);
      verifyReferences(report.references,source);
      const output=await api.sqlAnalysis.findCatalogReferences({kind:'table',database:config.database,table:target});
      assert.ok(output.references.some(row=>row.command==='INSERT'&&row.usage==='write'));
      const deleted=await api.sqlAnalysis.findCatalogReferences({kind:'table',database:config.database,table:right});
      assert.ok(deleted.references.some(row=>row.command==='DELETE'&&row.usage==='write'&&source.slice(row.start,row.end)==='b'));
      const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document,{preview:false});
      const position=document.positionAt(source.indexOf('a.score=b')+3);
      const locations=await vscode.commands.executeCommand('vscode.executeReferenceProvider',document.uri,position);
      const local=locations.filter(location=>location.uri.toString()===document.uri.toString());
      assert.equal(local.length,2);
      assert.ok(local.every(location=>document.getText(location.range)==='score'));
      checks.push('The installed reference provider distinguished INSERT SELECT reads, joined SET writes and explicit DELETE aliases. The separately executed owned transaction rolled back.');
      return {nativeJoinedReferences:true,physicalRoles:true,exactSourceRanges:true,analysisExecutedSql:false};
    } finally {
      try { await settings.update('roots',previous,configuration); await api.disconnectMysql(); }
      finally { await fs.unlink(file); }
    }
  });
}

async function verifyJoinedDmlImpact() {
  return fixture(async ({config,left,source})=>{
    const db=new MysqlService(config);
    try {
      const catalog=await db.metadata();
      const options={database:config.database,dmlUsages:true,catalogComplete:true,dialect:catalog.dialect};
      const report=analyzeProjectDocument(source,catalog,options);
      assert.equal(report.state,'known');
      const refs=referencesInDocument(report,{kind:'column',database:config.database,table:left,column:'score'},options);
      verifyReferences(refs,source);
      return {physicalRoles:true,exactSourceRanges:true,analysisExecutedSql:false};
    } finally { await db.dispose(); }
  });
}

module.exports={runJoinedDmlImpactChecks,verifyJoinedDmlImpact};
if(require.main===module)verifyJoinedDmlImpact().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
