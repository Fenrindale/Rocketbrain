'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { agentProgram, runAgent } = require('../src/ai/acp-process');
const { agentProfiles } = require('./helpers/acp-peer-fixture');

test('ACP process validates literal executable arguments and rejects invalid version replies',async () => {
  await assert.rejects(agentProgram({ label:'agent',executable:'relative' }),/absolute path/);
  const executable = process.execPath;
  await assert.rejects(agentProgram({ label:'agent',executable,args:['invalid\nargument'] }),/literal ACP arguments/);
  await assert.rejects(runAgent({ label:'invalid peer',executable,args:['-e',
    'process.stdin.once("data",()=>console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:2}})))'] },
  { cwd:os.tmpdir(),text:'Compare a reply' }),/stable ACP version 1/);
});

test('two official ACP v1 SDK peers answer in parallel and reject editor capability requests',
  {skip:!process.env.ROCKETBRAIN_ACP_SDK},async () => {
    const fixture = await agentProfiles(os.tmpdir(),process.execPath,process.env.ROCKETBRAIN_ACP_SDK);
    try {
      const text = 'Review a Java Integer return value.';
      const results = await Promise.all(fixture.profiles.map(profile=>runAgent(profile,{cwd:fixture.directory,text})));
      assert.deepEqual(results.map(({ output,denied,stopReason })=>[output,denied,stopReason]),
        [['First Peer · '+text,1,'end_turn'],['Second Peer · '+text,1,'end_turn']]);
      const controller = new AbortController();
      await assert.rejects(runAgent(fixture.solo,{cwd:fixture.directory,text:'hold for cancellation',
        signal:controller.signal,onUpdate:bytes=>{if(bytes>25)controller.abort();}}),{code:'ACP_CANCELLED'});
      assert.match(await fs.readFile(path.join(fixture.directory,'cancelled'),'utf8'),/^[a-f0-9-]{36}$/);
    } finally { await fixture.close(); }
  });
