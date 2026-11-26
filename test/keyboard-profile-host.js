'use strict';

const assert = require('node:assert/strict');
const { exportProfile } = require('../src/keyboard-profile');

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

module.exports = { runKeyboardProfileChecks };
