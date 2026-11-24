'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

async function runSqlResolutionScopeChecks(api,vscode,checks){
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const config=JSON.parse(await fs.readFile(runtime.dbConfigPath,'utf8'));
  assert.equal(config.host,'127.0.0.1');
  const folder=vscode.workspace.workspaceFolders[0].uri;
  const directory=await fs.mkdtemp(path.join(folder.fsPath,'rb-scope-'));
  const relative=path.basename(directory);
  const settings=vscode.workspace.getConfiguration('rocketbrain.sql.analysis',folder);
  const target=vscode.ConfigurationTarget.Workspace;
  const previous=settings.inspect('resolutionScopes')?.workspaceValue;
  const content={
    'folder.sql':'CREATE TABLE example (from_folder INT);',
    'custom.sql':'CREATE TABLE example (per_file VARCHAR(12));',
    'first.sql':'SELECT e.from_folder FROM example e;',
    'specific.sql':'SELECT e.per_file FROM example e;',
    'missing.sql':'SELECT p.id FROM rb_spring_person p;'
  };
  const uri=name=>vscode.Uri.file(path.join(directory,name));
  const doc=async name=>vscode.workspace.openTextDocument(uri(name));
  const context=(source,ddl,database)=>({source,ddl:relative+'/'+ddl,database,dialect:runtime.dbEngine});
  try{
    for(const [name,text]of Object.entries(content))await fs.writeFile(uri(name).fsPath,text,{flag:'wx'});
    await settings.update('resolutionScopes',[
      context(relative+'/','folder.sql','folder_scope'),
      context(relative+'/specific.sql','custom.sql','exact_scope'),
      context(relative+'/missing.sql','not-found.sql','invalid_scope')
    ],target);
    await api.connectMysql(config);
    const first=await doc('first.sql'),specific=await doc('specific.sql'),missing=await doc('missing.sql');
    const tools=api.sqlAnalysis;
    const report=tools.analyzeDocument(first),exact=tools.analyzeDocument(specific),invalid=tools.analyzeDocument(missing);
    assert.equal(report.state,'known');
    assert.equal(report.configuredScope,relative+'/');
    assert.equal(report.statements[0].model.database,'folder_scope');
    assert.equal(exact.state,'known');
    assert.equal(exact.configuredScope,relative+'/specific.sql');
    assert.equal(exact.statements[0].model.database,'exact_scope');
    assert.equal(invalid.reason,'configured-catalog-unavailable');
    assert.equal(tools.catalogTargetAt(first,first.positionAt(9)),null);
    assert.throws(()=>tools.prepareRename(first,first.positionAt(9)),/virtual DDL preview/);
    const location=specific.positionAt(specific.getText().indexOf('e.per_file')+3);
    const completion=async()=>vscode.commands.executeCommand('vscode.executeCompletionItemProvider',specific.uri,location);
    assert.ok((await completion()).items.some(value=>(value.label.label||value.label)==='per_file'));
    await fs.writeFile(uri('custom.sql').fsPath,'CREATE TABLE example (per_file INT, newly_saved DATE);');
    const refreshed=tools.analyzeDocument(specific);
    assert.equal(refreshed.statements[0].model.projections[0].type.dbType.toLowerCase(),'int');
    await api.disconnectMysql();
    assert.equal(tools.analyzeDocument(first).state,'known');
    const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(10000)});
    const jdbc={people:2,departments:1,rolledBackNames:0};
    assert.equal(response.ok,true);
    assert.deepEqual(await response.json(),jdbc);
    checks.push('A configured folder resolved against one DDL catalog and a specific SQL file resolved against another. Native completion followed the exact file mapping, reread a saved schema modification, and refused to substitute the live catalog if its configured file was absent.');
    return {folderScope:true,exactFilePrecedence:true,nativeCompletion:true,savedCatalogRefresh:true,missingCatalogRefused:true,
      physicalRenameRefused:true,offlineAfterDisconnect:true,jdbc};
  }finally{
    await settings.update('resolutionScopes',previous,target);
    for(const name of Object.keys(content))await fs.unlink(uri(name).fsPath).catch(error=>{if(error.code!=='ENOENT')throw error;});
    const until=Date.now()+5000;
    for(;;){
      try{await fs.rmdir(directory);break;}
      catch(error){if(!['EBUSY','EPERM'].includes(error.code)||Date.now()>=until)throw error;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    await api.disconnectMysql();
  }
}

module.exports={runSqlResolutionScopeChecks};
