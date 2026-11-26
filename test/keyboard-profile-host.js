'use strict';

const assert = require('node:assert/strict');
const { exportProfile } = require('../src/keyboard-profile');
const {jdbcReadback} = require('./java-source-analysis-host');

async function runKeyboardProfileChecks(api, vscode, checks) {
  const plans = [];
  for (const platform of ['win32', 'linux', 'darwin']) {
    const report = await api.keyboardProfile.inspect({ platform });
    assert.equal(report.routes.length, 52);
    const missing = report.routes.filter(route => !route.available).map(route => route.command);
    assert.deepEqual(missing, [], 'Every action must resolve in the installed extension host.');
    assert.equal(JSON.parse(exportProfile(report)).length, 52);
    plans.push({ platform, actions: report.routes.length, manifestRules: report.manifestRules });
  }
  const source = '[ // explicit fixture input\n {"key":"ctrl+shift+f10","command":"fixture.keyboardPrefix"},\n]\n';
  const withConflict = await api.keyboardProfile.inspect({ platform: 'win32', input: source });
  const run = withConflict.routes.find(route => route.command === 'rocketbrain.runQuery');
  assert.ok(run.overlaps.some(item => item.relation === 'chord prefix' && item.scope === 'possible overlap'));
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.keyboardProfile'));
  checks.push('The installed keyboard profile resolves all 52 actions on all three export platforms and previews supplied chord conflicts.');
  return { plans, suppliedChordConflict: true };
}

async function runKeyboardProfileActivationChecks(api,vscode,checks) {
  const service=api.keyboardProfile;
  const initial=await service.workspaceStatus();
  assert.equal(initial.hasWorkspace,true);
  assert.equal(initial.configured,false,'Use a fresh owned workspace for the default disabled gate.');
  const before=await jdbcReadback();
  assert.ok(before);
  const cancelled=new vscode.CancellationTokenSource();
  cancelled.cancel();
  try {
    assert.equal((await service.setWorkspaceEnabled(true,cancelled.token)).enabled,false);
    assert.equal((await service.setWorkspaceEnabled(true)).enabled,true);
    const routes=await runKeyboardProfileChecks(api,vscode,checks);
    const active=await service.inspect({platform:'win32'});
    assert.equal(active.workspace.enabled,true);
    assert.ok(active.routes.every(route=>!route.overlaps.some(item=>
      item.source==='rocketbrain-local.rocketbrain' && item.when.startsWith('rocketbrain.keyboardProfile.enabled'))));
    assert.equal((await service.setWorkspaceEnabled(false)).enabled,false);
    const after=await jdbcReadback();
    assert.deepEqual(after,before);
    checks.push('The installed profile toggles its 52 optional shortcuts in the current workspace. A cancelled toggle and the Spring JDBC read preserve workspace data.');
    return {...routes,disabledByDefault:true,changedWorkspaceContext:true,cancelledToggle:true,restoredDisabled:true,jdbc:after};
  } finally {
    cancelled.dispose();
    await service.setWorkspaceEnabled(initial.configured);
  }
}

module.exports = {runKeyboardProfileChecks,runKeyboardProfileActivationChecks};
