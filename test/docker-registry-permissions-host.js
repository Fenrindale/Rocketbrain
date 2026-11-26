'use strict';

const assert = require('node:assert/strict');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runDockerRegistryPermissionChecks(api, vscode, checks) {
  const command = 'rocketbrain.docker.registryPermissions';
  assert.ok((await vscode.commands.getCommands(true)).includes(command));
  assert.ok(api.docker?.registryPermissions?.review);
  assert.ok(api.docker.registryPermissions.check);
  await assert.rejects(api.docker.registryPermissions.check('unreviewed-token', { approved: true }), /Approve a current/);
  checks.push('The installed registry permission command is available and requires an exact current review before any network request.');
  return { nativeCommand: true, unreviewedRequestDenied: true, jdbc: await jdbcReadback() };
}

module.exports = { runDockerRegistryPermissionChecks };
