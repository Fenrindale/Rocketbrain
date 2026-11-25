'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const { randomUUID }=require('node:crypto');
const { apiProtocolsFixture,waitForProtocol }=require('./helpers/api-protocols-fixture');

async function runApiProtocolsChecks(api,vscode,checks) {
  const [folder]=vscode.workspace.workspaceFolders;
  assert.equal(folder.uri.scheme,'file');
  const id=randomUUID(), token=randomUUID();
  const fixture=await apiProtocolsFixture(token);
  const file=path.join(folder.uri.fsPath,'rb-api-protocols-'+id+'.http');
  const contents='@api = '+fixture.http+'\n@socket = '+fixture.websocket+'\n'+
    '# @expect status 200\n# @expect json $.data.greet == "Hello Native"\n'+
    'GRAPHQL {{api}}/graphql\nAuthorization: Bearer '+token+'\n\n'+JSON.stringify({
      query:'query Greet($name:String!) { greet(name:$name) failure }',operationName:'Greet',variables:{name:'Native'}
    })+'\n### socket\nWEBSOCKET {{socket}}/echo\nAuthorization: Bearer '+token+
    '\nSec-WebSocket-Protocol: rocketbrain.echo\n';
  let document,session,created=false;
  try {
    await fs.writeFile(file,contents,{encoding:'utf8',flag:'wx'});
    created=true;
    document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.languageId,'rocketbrain-http');
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    function select(marker) {
      const cursor=document.positionAt(contents.indexOf(marker));
      editor.selection=new vscode.Selection(cursor,cursor);
    }
    const commands=await vscode.commands.getCommands(true);
    for (const action of ['graphqlSchema','websocketSessions','websocketSend','websocketClose']) {
      assert.ok(commands.includes('rocketbrain.http.'+action));
    }
    select('GRAPHQL');
    const sent=await vscode.commands.executeCommand('rocketbrain.http.run');
    assert.equal(sent.status,200);
    assert.equal(sent.graphql.errors,1);
    assert.equal(sent.assertions.length,2);
    assert.ok(sent.assertions.every(item=>item.passed));
    assert.equal(JSON.parse(sent.body).data.greet,'Hello Native');
    const inspection=await vscode.commands.executeCommand('rocketbrain.http.graphqlSchema');
    assert.equal(inspection.status,200);
    assert.equal(inspection.graphql.kind,'schema');
    assert.equal(inspection.graphql.errors,0);
    const introspection=JSON.parse(inspection.body).data.__schema;
    assert.equal(introspection.queryType.name,'Query');
    assert.equal(introspection.mutationType.name,'Mutation');
    assert.deepEqual(fixture.requests.map(item=>[item.method,item.authorized,item.operationName]),
      [['POST',true,'Greet'],['POST',true,'RocketbrainSchema']]);
    checks.push('Native HTTP file commands selected a real GraphQL operation with variables, showed an HTTP 200 partial response error and inspected the live endpoint schema.');
    select('WEBSOCKET');
    session=(await vscode.commands.executeCommand('rocketbrain.http.run')).webSocket;
    assert.equal(session.state,'open');
    assert.equal(session.protocol,'rocketbrain.echo');
    assert.equal(api.httpTools.webSocket.list(document).find(item=>item.id===session.id)?.state,'open');
    const received=()=>api.httpTools.webSocket.get(document,session.id);
    const text='Native 메시지';
    await api.httpTools.webSocket.send(document,session.id,text);
    const transcript=await waitForProtocol(received,state=>state.messages.length===3);
    assert.equal(fixture.frames[0].text,text);
    const echo=transcript.messages.find(message=>message.kind==='text' && message.direction==='in');
    assert.equal(JSON.parse(echo.text).received,text);
    const binary=transcript.messages.find(message=>message.kind==='binary');
    assert.deepEqual({size:binary.size,text:binary.text},{size:3,text:null});
    api.httpTools.webSocket.close(document,session.id);
    const closed=await waitForProtocol(received,state=>state.state==='closed');
    assert.equal(closed.closeCode,1000);
    checks.push('The native request command opened an authenticated WebSocket and negotiated its subprotocol. The workbench sent text, received text and binary metadata, retained the transcript and confirmed the close handshake.');
    return {successful:true,graphql:{operation:'Greet',assertions:sent.assertions.length,responseErrors:sent.graphql.errors,
      schema:true,queryType:introspection.queryType.name,mutationType:introspection.mutationType.name},
      websocket:{authenticated:true,subprotocol:session.protocol,frames:transcript.messages.length,binaryBytes:binary.size,
        closeCode:closed.closeCode}};
  } finally {
    if (session && document) api.httpTools.webSocket.close(document,session.id);
    if (document && vscode.window.activeTextEditor?.document.uri.toString()===document.uri.toString()) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    if (created) await fs.unlink(file);
    await fixture.close();
  }
}

module.exports={runApiProtocolsChecks};
