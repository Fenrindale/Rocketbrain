'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {activeContext,workspaceKeybindings} = require('../src/keyboard-profile');

const packageFile = path.join(__dirname,'../package.json');
const managed = binding => binding?.when?.startsWith(activeContext + ' && ');

function assertWorkspaceKeybindings(manifest) {
  const installed = manifest.contributes.keybindings.filter(managed);
  assert.deepEqual(installed,workspaceKeybindings(),
    'Run node scripts/keyboard-profile-manifest.js --write to update the generated workspace shortcuts.');
}

if (require.main === module) {
  let input = fs.readFileSync(packageFile,'utf8');
  if (process.argv[2] === '--write') {
    const marker = '    "keybindings": [\n';
    if (!input.includes(marker)) throw Error('Cannot find the VS Code keybindings contribution list.');
    input = input.split('\n').filter(line => {
      if (!line.includes('"when": "' + activeContext + ' && ')) return true;
      return !managed(JSON.parse(line.trim().replace(/,$/u,'')));
    }).join('\n');
    const lines = workspaceKeybindings().map(rule =>
      '      { '+Object.entries(rule).map(([key,value]) => JSON.stringify(key)+': '+JSON.stringify(value)).join(', ')+' },').join('\n');
    input = input.replace(marker,() => marker + lines + '\n');
    assertWorkspaceKeybindings(JSON.parse(input));
    fs.writeFileSync(packageFile,input);
  } else assertWorkspaceKeybindings(JSON.parse(input));
}
module.exports = {assertWorkspaceKeybindings};
