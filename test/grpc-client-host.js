'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { echoProto, grpcFixture } = require('./helpers/grpc-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runGrpcChecks(api,vscode,checks) {
  const token = 'owned-native-grpc-fixture';
  const fixture = await grpcFixture(token);
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const prefix = 'rb-grpc-' + randomBytes(6).toString('hex');
  const protoName = prefix + '.proto', proto = path.join(workspace,protoName);
  const file = path.join(workspace,prefix+'.http');
  const input = { text:'hello', id:'9007199254740995' };
  const request = (method,body,source=protoName) => [
    'GRPC '+fixture.endpoint+method, 'Proto: '+source, 'Authorization: Bearer '+token, '', JSON.stringify(body)
  ].join('\n');
  const content = [request('One',input), request('Many',input), request('Collect',[input,input]),
    request('Mirror',[input,input]), request('One',input,'../'+protoName)].join('\n###\n');
  const created = [];
  try {
    await fs.writeFile(proto,echoProto,{flag:'wx'}); created.push(proto);
    await fs.writeFile(file,content,{flag:'wx'}); created.push(file);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.languageId,'rocketbrain-http');
    const selected = method => content.indexOf(fixture.endpoint+method);
    const editor = await vscode.window.showTextDocument(document,{preview:false});
    const cursor = document.positionAt(selected('One'));
    editor.selection = new vscode.Selection(cursor,cursor);
    const unary = await vscode.commands.executeCommand('rocketbrain.http.run');
    assert.equal(unary.grpc.mode,'unary');
    assert.deepEqual(JSON.parse(unary.body),input);
    const server = await api.httpTools.run(document,selected('Many'));
    assert.equal(server.grpc.mode,'server-stream');
    assert.deepEqual(JSON.parse(server.body).map(value=>value.text),['one','two']);
    const client = await api.httpTools.run(document,selected('Collect'));
    assert.equal(client.grpc.mode,'client-stream');
    assert.deepEqual(JSON.parse(client.body),{...input,text:'hello/hello'});
    const duplex = await api.httpTools.run(document,selected('Mirror'));
    assert.equal(duplex.grpc.mode,'bidirectional-stream');
    assert.deepEqual(JSON.parse(duplex.body),[input,input]);
    await assert.rejects(api.httpTools.run(document,content.lastIndexOf(fixture.endpoint+'One')),/workspace-relative/);
    assert.equal(fixture.observed.authenticated,4);
    const jdbc = await jdbcReadback();
    checks.push('Native API workbench ran all four gRPC method modes with an owned authenticated server and a workspace Protocol Buffer descriptor. Exact int64 and the workspace boundary were preserved.');
    return { modes:[unary.grpc.mode,server.grpc.mode,client.grpc.mode,duplex.grpc.mode], messagesReceived:6, authenticated:4,
      exactInt64:true, workspaceDescriptorBoundary:true,jdbc };
  } finally {
    fixture.dispose();
    for (const name of created.reverse()) await fs.unlink(name);
  }
}

module.exports = { runGrpcChecks };
