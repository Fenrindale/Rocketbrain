'use strict';

// Explicit source-test lane. The integration lane may provision real servers.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const liveOnly = new Set(['db-authoring-grants.test.js']);
const files = fs.readdirSync(path.join(root, 'test'))
  .filter(name => name.endsWith('.test.js') && !name.endsWith('.integration.test.js') && !liveOnly.has(name))
  .sort().map(name => 'test/' + name);
if (!files.length) throw Error('No offline source tests were selected.');
console.log(`Running ${files.length} offline test files; real-server integration files are excluded.`);
console.log('Tests requiring explicitly configured Java, browser or native extension runtimes may skip.');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root, env: process.env, windowsHide: true, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
