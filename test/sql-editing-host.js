'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');

async function runSqlEditingChecks(api,vscode,checks) {
  const fixture=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(fixture.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const db=JSON.parse(fs.readFileSync(fixture.dbConfigPath,'utf8'));
  assert.equal(db.host,'127.0.0.1');
  const open=async text=>vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language:'sql',content:text}),{preview:false});
  async function query(editor){
    editor.selection=new vscode.Selection(0,0,0,0);
    const id=await vscode.commands.executeCommand('rocketbrain.runQuery');
    const result=api.results().find(item=>item.id===id);
    assert.equal(result.state,'done',result.error);
    return result;
  }
  await api.connectMysql(db);
  try{
    const editor=await open("SELECT COUNT(*) AS total FROM rb_spring_person p JOIN rb_spring_department d ON p.department_id = d.id WHERE p.display_name <> 'not; a person';");
    const baseline=await query(editor);
    assert.equal(Number(baseline.result.rows[0][0]),2);
    assert.equal(await vscode.commands.executeCommand('rocketbrain.sql.format'),true);
    assert.match(editor.document.getText(),/\r?\nFROM rb_spring_person p\r?\nJOIN rb_spring_department d\r?\n\s+ON/);
    assert.deepEqual((await query(editor)).result.rows,baseline.result.rows);
    const draft=await open('');
    assert.equal(await api.sqlEditing.insert(draft,{prefix:'rb-select',table:'rb_spring_person'}),true);
    assert.match(draft.document.getText(),/FROM `.+`\.`rb_spring_person`\r?\nLIMIT 100;/);
    await vscode.commands.executeCommand('leaveSnippet');
    const generated=await query(draft);
    assert.equal(generated.result.rowCount,2);
    assert.ok(generated.result.columns.includes('department_id'));
    const typo=await open('SELECT COUNT(p.department_ix) AS total FROM rb_spring_person AS p;');
    const start=typo.document.positionAt(typo.document.getText().indexOf('department_ix'));
    const fixes=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',typo.document.uri,
      new vscode.Range(start,start),'quickfix');
    const correction=fixes.find(item=>item.title==='Use `department_id`');
    assert.ok(correction);
    assert.equal(await vscode.commands.executeCommand(correction.command.command,...correction.command.arguments),true);
    assert.equal(Number((await query(typo)).result.rows[0][0]),2);
    const response=await fetch(fixture.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(8000)});
    assert.equal(response.status,200);
    const jdbc=await response.json();
    assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
    checks.push('The native SQL formatter preserved execution of a real Spring JOIN and its quoted semicolon. The catalog template inserted editable placeholders and queried two rows with the observed columns.');
    return { formattingRan:true, unchangedRows:2, templateRows:2, observedColumns:true, quickFixRows:2,jdbc };
  }finally{
    await api.disconnectMysql();
  }
}

module.exports={runSqlEditingChecks};
