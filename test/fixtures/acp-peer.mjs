import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const [sdkFile, label, directory, ownFile, otherFile] = process.argv.slice(2);
const sdk = await import(pathToFileURL(sdkFile).href);
const { agent, methods, ndJsonStream } = sdk;
const sessionId = randomUUID();
let cancel;
agent({ name:'rocketbrain-owned-acp-peer' })
  .onRequest(methods.agent.initialize,({ params }) => {
    assert.equal(params.protocolVersion,1);
    assert.equal(params.clientCapabilities.terminal,false);
    assert.deepEqual(params.clientCapabilities.fs,{ readTextFile:false,writeTextFile:false });
    return { protocolVersion:1,agentCapabilities:{},authMethods:[] };
  })
  .onRequest(methods.agent.session.new,({ params }) => {
    assert.deepEqual(params.mcpServers,[]);
    return { sessionId };
  })
  .onRequest(methods.agent.session.prompt,async ({ params, client }) => {
    assert.equal(params.sessionId,sessionId);
    assert.equal(params.prompt[0].type,'text');
    const permission = await client.request(methods.client.session.requestPermission,{ sessionId,
      toolCall:{ toolCallId:'example-approval',title:'Editor access probe' },
      options:[{ optionId:'allow',name:'Allow',kind:'allow_once' },{ optionId:'deny',name:'Reject',kind:'reject_once' }] });
    assert.deepEqual(permission.outcome,{ outcome:'cancelled' });
    await assert.rejects(client.request(methods.client.fs.readTextFile,{ sessionId,path:join(directory,'never-read.txt') }));
    await writeFile(join(directory,ownFile),sessionId,{ flag:'wx' });
    if (otherFile) {
      for (let attempt=0;attempt<100;attempt++) {
        if (await access(join(directory,otherFile)).then(()=>true,()=>false)) break;
        if (attempt===99) throw Error('The second ACP peer did not start in parallel.');
        await delay(60);
      }
    }
    const publish = text => client.notify(methods.client.session.update,{ sessionId,
      update:{ sessionUpdate:'agent_message_chunk',content:{type:'text',text} } });
    await publish(label+' · ');
    await publish(params.prompt[0].text);
    if (params.prompt[0].text==='hold for cancellation') {
      await new Promise(resolve=>{cancel=resolve;});
      return { stopReason:'cancelled' };
    }
    return { stopReason:'end_turn' };
  })
  .onNotification(methods.agent.session.cancel,async ({ params }) => {
    assert.equal(params.sessionId,sessionId);
    await writeFile(join(directory,'cancelled'),sessionId,{flag:'wx'});
    cancel?.();
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
