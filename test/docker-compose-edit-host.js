'use strict';

const assert = require('node:assert/strict');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runDockerComposeEditChecks(api, vscode, checks) {
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const name of ['composeOverrideDraft', 'composeOverrideReview']) {
    assert.ok(commands.has('rocketbrain.docker.' + name));
  }
  assert.ok(api.docker?.composeEdit?.prepare);
  await assert.rejects(api.docker.composeEdit.apply('unreviewed-token', { approved: true }), /Approve a current/);
  checks.push('The installed Compose draft and review commands require an approved override review before editing.');
  return { draftCommand: true, reviewCommand: true, unreviewedEditDenied: true, jdbc: await jdbcReadback() };
}

module.exports = { runDockerComposeEditChecks };
