'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {jdbcReadback}=require('./java-source-analysis-host');
const {owned}=require('./schema-stored-diff-host');
const {gitWorktreeFixture}=require('./helpers/git-worktree-fixture');

async function runGitWorktreeContextChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const fixture=await gitWorktreeFixture(workspace),profiles=[],sessions=[];
  const service=api.gitWorktrees,imported=[];
  let database;
  try {
    await api.java.start();
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.gitWorktree.context'));
    for(const project of [fixture.main,fixture.linked]){
      const projectUri=pathToFileURL(project).href;
      imported.push(projectUri);
      await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    }
    const before=await service.review(fixture.main),other=await service.review(fixture.linked);
    assert.equal(before.worktrees.length,2);
    assert.deepEqual([before.branch,other.branch],['rb-main','rb-linked']);
    assert.notEqual(before.head,other.head);
    database=await owned(runtime.dbConfigPath);
    assert.equal(/mariadb/i.test(database.version),runtime.dbEngine==='mariadb');
    const active=api.activeConnectionProfile()?.id;
    for(const name of ['Main','Linked']){
      const config=database.config;
      const saved=await api.dbConnections.save({profile:{id:randomUUID(),name:'Worktree '+name+' '+randomUUID().slice(0,8),
        group:'Worktree context fixture',host:config.host,port:config.port,user:config.user,database:config.database,tls:{mode:'disabled'}},
        password:config.password,rememberPassword:true});
      profiles.push(saved);
    }
    const spring=runtime.baseUrl+'/actuator';
    const db=(item)=>({id:item.id,revision:item.revision});
    const main=await service.save(before,{project:'.',spring,database:db(profiles[0])});
    const linked=await service.save(other,{project:'.',database:db(profiles[1])});
    assert.deepEqual((await Promise.all([service.project(main),service.project(linked)])).map(item=>item.root),[fixture.main,fixture.linked]);
    assert.equal((await service.spring(main)).health.status,'UP');
    await assert.rejects(service.spring(linked),/Pin/);
    for(const [review,profile] of [[main,profiles[0]],[linked,profiles[1]]]){
      const opened=await service.openDatabase(review);
      const target={profileId:profile.id,sessionId:opened.sessionId};
      sessions.push(target);
      assert.equal(opened.profile.id,profile.id);
      const catalog=await api.inspectProfileSessionCatalog(target);
      assert.equal(catalog.catalog.database,database.config.database);
      const editor=vscode.window.activeTextEditor,source=editor.document.getText();
      assert.equal(editor.document.uri.toString(),opened.uri);
      const marker=source.indexOf('SELECT DATABASE()');
      assert.ok(marker>=0);
      editor.selection=new vscode.Selection(editor.document.positionAt(marker),editor.document.positionAt(source.length));
      const resultId=await vscode.commands.executeCommand('rocketbrain.runQuery');
      const result=api.results().find(item=>item.id===resultId);
      assert.equal(result?.result?.rows?.[0]?.[0],database.config.database);
    }
    assert.notEqual(sessions[0].sessionId,sessions[1].sessionId);
    assert.equal(api.activeConnectionProfile()?.id,active);
    await api.closeProfileSession(sessions[1],()=>true);
    const replacement=await api.dbConnections.save({profile:{...profiles[1].profile,name:profiles[1].profile.name+' edited'},
      password:database.config.password,rememberPassword:true,expectedRevision:profiles[1].revision});
    profiles[1]=replacement;
    await assert.rejects(service.openDatabase(linked),/saved database profile changed/);
    await assert.rejects(service.save(before,{project:'.'}),/changed after review/);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Use the owned JDBC Spring fixture.');
    checks.push('The installed worktree context resolved two real Git/JDT projects, read the selected Spring Actuator and opened each worktree’s distinct database profile in its own SQL session.');
    return {springRuntime:true,jdbc,gitWorktrees:2,javaProjects:2,actuatorHealth:'UP',databaseSessions:2,
      activeConnectionPreserved:true,staleProfileRefused:true,staleContextRefused:true,dbEngine:runtime.dbEngine};
  }finally{
    try {
      for(const session of sessions)if(api.profileSessionList().some(item=>item.id===session.sessionId))await api.closeProfileSession(session,()=>true);
      for(const profile of profiles)await api.dbConnections.remove({id:profile.id,expectedRevision:profile.revision});
    }finally{
      try {
        for(const root of [fixture.main,fixture.linked]){
          const reviewed=await service.review(root);
          if(reviewed.revision)await service.clear(reviewed);
        }
      }finally{
        if(imported.length)await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],imported).catch(()=>{});
        await database?.actor.end();
        await fixture.close();
      }
    }
  }
}

module.exports={runGitWorktreeContextChecks};
