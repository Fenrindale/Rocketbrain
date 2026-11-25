'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const { createQualityFixture }=require('./helpers/java-quality-fixture');
const { openMcp,legacy,modern }=require('./helpers/ide-mcp-fixture');
const { jdbcReadback }=require('./java-source-analysis-host');

async function runIdeMcpChecks(_api,vscode,checks) {
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  const cli=path.join(extension.extensionPath,'dist','ide-mcp-server.js');
  const [folder]=vscode.workspace.workspaceFolders;
  assert.equal(folder.uri.scheme,'file');
  const root=folder.uri.fsPath;
  const first=openMcp('node',cli,root,['project_inventory','sql_structure']);
  let springInventory;
  try {
    assert.equal((await first.initialize()).result.protocolVersion,legacy);
    const list=(await first.request('tools/list')).result.tools.map(tool=>tool.name);
    assert.deepEqual(list,['project_inventory','sql_structure']);
    springInventory=(await first.request('tools/call',{name:'project_inventory'})).result.structuredContent;
    assert.ok(springInventory.sourceFiles.java>0);
    assert.ok(springInventory.buildFiles.includes('build.gradle'));
    const pathDenied=await first.request('tools/call',{name:'project_inventory',arguments:{folder:'../outside'}});
    const toolDenied=await first.request('tools/call',{name:'java_quality'});
    assert.equal(pathDenied.error.code,-32602);
    assert.equal(toolDenied.error.code,-32602);
    const sql=(await first.request('tools/call',{name:'sql_structure',arguments:{sql:'SELECT id FROM rb_spring_person'}})).result.structuredContent;
    assert.equal(sql.executedSql,false);
    assert.ok(sql.relations.some(relation=>relation.name==='rb_spring_person'));
  } finally { assert.deepEqual(await first.close(),{code:0,stderr:'',malformed:null}); }

  const fixture=await createQualityFixture(root);
  const second=openMcp('node',cli,fixture.root,['java_quality']);
  try {
    const discover=(await second.modern('server/discover')).result;
    assert.ok(discover.supportedVersions.includes(modern));
    const reply=(await second.modern('tools/call',{name:'java_quality',arguments:{revision:fixture.current,
      baselineRevision:fixture.baseline}})).result;
    const {summary}=reply.structuredContent;
    assert.equal(summary.revision,fixture.current);
    assert.deepEqual([summary.new,summary.unchanged,summary.fixed],[1,1,1]);
  } finally {
    const ended=await second.close();
    await fixture.cleanup();
    assert.deepEqual(ended,{code:0,stderr:'',malformed:null});
  }
  const jdbc=await jdbcReadback();
  checks.push('Bundled Rocketbrain stdio MCP was launched as a separate process. Legacy initialize/list/call inventoried the actual Spring workspace and parsed SQL without execution.');
  checks.push('Per-request MCP discovery and call analyzed an immutable Git baseline while the allowlist rejected an unapproved tool and a path beyond the workspace.');
  return {successful:true,protocols:[legacy,modern],tools:['project_inventory','sql_structure','java_quality'],
    inventoryJava:springInventory.sourceFiles.java,workspaceBoundary:true,toolAllowlist:true,sqlExecuted:false,exactGitBaseline:true,jdbc};
}

module.exports={runIdeMcpChecks};
