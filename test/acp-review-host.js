'use strict';

const assert = require('node:assert/strict');
const { agentProfiles } = require('./helpers/acp-peer-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runAcpReviewChecks(api,vscode,checks) {
  const [folder] = vscode.workspace.workspaceFolders || [];
  assert.equal(folder?.uri.scheme,'file');
  const peers = await agentProfiles(folder.uri.fsPath,process.env.ROCKETBRAIN_ACP_NODE,process.env.ROCKETBRAIN_ACP_SDK);
  try {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.acp.compare') && commands.includes('rocketbrain.acp.review'));
    const text = 'Review the Integer return value of a Spring controller.';
    const args = { folder:folder.uri,profiles:peers.profiles,text };
    await assert.rejects(api.acpReview.review(args),/Review the configured executables/);
    const replies = await api.acpReview.review({...args,approveProgram:true});
    assert.deepEqual(replies.map(({state,denied})=>[state,denied]),[['complete',1],['complete',1]]);
    assert.deepEqual(replies.map(item=>item.output),['First Peer · '+text,'Second Peer · '+text]);
    const documents = await Promise.all(replies.map(item=>vscode.workspace.openTextDocument({language:'plaintext',content:item.output})));
    await vscode.commands.executeCommand('vscode.diff',documents[0].uri,documents[1].uri,'Owned ACP reply comparison');
    assert.deepEqual(api.acpReview.results(),replies);
    checks.push('Two independent official ACP v1 SDK peers negotiated, streamed and awaited one another. The installed client rejected editor access and displayed an exact native diff.');
    return { sdk:'2.12.0',protocol:1,parallelPeers:2,permissionsDeclined:2,nativeDiff:true,jdbc:await jdbcReadback() };
  } finally { await peers.close(); }
}

module.exports = { runAcpReviewChecks };
