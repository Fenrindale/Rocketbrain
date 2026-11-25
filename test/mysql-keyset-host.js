'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runKeysetGridChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG,'utf8'));
  await api.connectMysql(config);
  try {
    const commands=await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.openTableSnapshot'));
    const id=await api.openTableSnapshot('rb_spring_person',{pageSize:1});
    assert.ok(Number.isInteger(id) && id>0);
    assert.ok(api.scriptResultRetained(id));
    await api.activateResult(id);
    checks.push('The installed snapshot command opened a retained read-only grid page from the real Spring database.');
    return { snapshotCommand:true,installedResultTab:true,jdbc:await jdbcReadback() };
  } finally { await api.disconnectMysql(); }
}

module.exports = { runKeysetGridChecks };
