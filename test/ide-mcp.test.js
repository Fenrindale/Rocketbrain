'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const { setTimeout:delay }=require('node:timers/promises');
const { createQualityFixture }=require('./helpers/java-quality-fixture');
const { openMcp,legacy,modern,meta }=require('./helpers/ide-mcp-fixture');

const cli=path.resolve(__dirname,'../scripts/ide-mcp-server.js');

test('legacy MCP subprocess discovers and calls only approved workspace tools',async t=>{
  const fixture=await createQualityFixture(os.tmpdir());
  const mcp=openMcp(process.execPath,cli,fixture.root,['project_inventory','sql_structure']);
  t.after(async()=>{await mcp.close();await fixture.cleanup();});
  await fs.writeFile(path.join(fixture.root,'pom.xml'),'<do not read>');
  await fs.writeFile(path.join(fixture.root,'.env'),'PASSWORD=fixture-only-credential');
  await fs.mkdir(path.join(fixture.root,'build'));
  await fs.writeFile(path.join(fixture.root,'build','Unapproved.java'),'ignored');
  await fs.symlink(path.dirname(fixture.root),path.join(fixture.root,'linked'),process.platform==='win32'?'junction':'dir');
  const before=await mcp.request('tools/list');
  assert.equal(before.error.code,-32600);
  const init=await mcp.initialize();
  assert.equal(init.result.protocolVersion,legacy);
  assert.deepEqual(init.result.capabilities,{tools:{}});
  const list=await mcp.request('tools/list');
  assert.deepEqual(list.result.tools.map(tool=>tool.name),['project_inventory','sql_structure']);
  assert.ok(list.result.tools.every(tool=>tool.annotations.readOnlyHint));
  const inventory=await mcp.request('tools/call',{name:'project_inventory'});
  assert.equal(inventory.result.structuredContent.sourceFiles.java,3);
  assert.deepEqual(inventory.result.structuredContent.buildFiles,['pom.xml']);
  assert.ok(!JSON.stringify(inventory).includes('credential') && !JSON.stringify(inventory).includes(fixture.root));
  const allowed=await mcp.request('tools/call',{name:'project_inventory',arguments:{folder:'src/main'}});
  assert.equal(allowed.result.structuredContent.sourceFiles.java,3);
  for (const folder of ['..','.git',fixture.root]) {
    assert.equal((await mcp.request('tools/call',{name:'project_inventory',arguments:{folder}})).error.code,-32602);
  }
  const linked=await mcp.request('tools/call',{name:'project_inventory',arguments:{folder:'linked'}});
  assert.equal(linked.result.isError,true);
  const denied=await mcp.request('tools/call',{name:'java_quality'});
  assert.equal(denied.error.code,-32602);
  const sql=await mcp.request('tools/call',{name:'sql_structure',arguments:{sql:'WITH x AS (SELECT 3 AS value) SELECT value FROM x;',dialect:'mariadb'}});
  assert.equal(sql.result.structuredContent.executedSql,false);
  assert.equal(sql.result.structuredContent.projections[0].type,'integer');
  const invalid=await mcp.request('tools/call',{name:'sql_structure',arguments:{sql:'SELECT 1',command:'anything'}});
  assert.equal(invalid.error.code,-32602);
  const ended=await mcp.close();
  assert.deepEqual(ended,{code:0,stderr:'',malformed:null});
});

test('current MCP subprocess supports discovery, exact Git findings, cancellation and ordered stdio frames',async t=>{
  const fixture=await createQualityFixture(os.tmpdir());
  const mcp=openMcp(process.execPath,cli,fixture.root,['java_quality','project_inventory']);
  t.after(async()=>{await mcp.close();await fixture.cleanup();});
  const discovery=await mcp.modern('server/discover');
  assert.equal(discovery.result.resultType,'complete');
  assert.ok(discovery.result.supportedVersions.includes(modern));
  assert.equal(discovery.result._meta['io.modelcontextprotocol/serverInfo'].name,'rocketbrain');
  assert.deepEqual([discovery.result.ttlMs,discovery.result.cacheScope],[0,'private']);
  const refused=await mcp.request('tools/list',{_meta:{'io.modelcontextprotocol/protocolVersion':'1900-01-01'}});
  assert.equal(refused.error.code,-32022);
  assert.equal((await mcp.modern('ping')).error.code,-32601);
  await fixture.write(fixture.stable,'package sample; // Unsaved Git change');
  const args={name:'java_quality',arguments:{revision:fixture.current,baselineRevision:fixture.baseline,profile:'application-sources'}};
  const call=await mcp.modern('tools/call',args);
  assert.equal(call.result.resultType,'complete');
  const {summary,findings}=call.result.structuredContent;
  assert.equal(summary.revision,fixture.current);
  assert.deepEqual([summary.new,summary.unchanged,summary.fixed],[1,1,1]);
  assert.equal(findings.find(item=>item.state==='new').rule,'emptyCatch');
  assert.ok(!JSON.stringify(call).includes('Unsaved Git change'));
  const cancelled='cancel-before-git';
  mcp.write(mcp.frame(cancelled,'tools/call',{...args,_meta:meta})+
    mcp.frame(undefined,'notifications/cancelled',{requestId:cancelled,_meta:meta}));
  assert.equal((await mcp.modern('tools/list')).result.tools.length,2);
  await delay(80);
  assert.equal(mcp.received.some(frame=>frame.id===cancelled),false);
  mcp.write('x'.repeat(256*1024+1)+'\n');
  assert.equal((await mcp.modern('tools/list')).result.tools.length,2);
  assert.equal(mcp.received.find(frame=>frame.id===null).error.code,-32700);
  const ended=await mcp.close();
  assert.deepEqual(ended,{code:0,stderr:'',malformed:null});
});
