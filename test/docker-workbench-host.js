'use strict';

const assert = require('node:assert/strict');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runDockerWorkbenchChecks(api,vscode,checks) {
  assert.ok(api.docker?.inventory && api.docker?.selectContext && api.docker?.review);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['select','refresh','logs','lifecycle','compose','manifest']) {
    assert.ok(commands.includes('rocketbrain.docker.'+name));
  }
  await vscode.commands.executeCommand('rocketbrain.docker.focus');
  await assert.rejects(api.docker.inventory(),/Select a Docker context/);
  checks.push('The installed Docker tree and six commands are available and inventory requires selecting a Docker context.');
  return { nativeTree:true,commands:6,explicitContextRequired:true,jdbc:await jdbcReadback() };
}

module.exports = { runDockerWorkbenchChecks };
