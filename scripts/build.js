'use strict';
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
async function build() {
  const sourceDir=path.join(__dirname,'../runtime/jpa-observer/src/rocketbrain/observer');
  const sources=Object.fromEntries(fs.readdirSync(sourceDir).filter(name=>name.endsWith('.java')).sort().map(name=>[name,fs.readFileSync(path.join(sourceDir,name),'utf8')]));
  fs.writeFileSync(path.join(__dirname,'../src/jpa/observer-sources.json'),JSON.stringify(sources));
  fs.writeFileSync(path.join(__dirname,'../src/java/testing/launcher-sources.json'),JSON.stringify(require('../src/java/testing/provision').readLauncherSources()));
  fs.mkdirSync('dist', { recursive: true });
  await esbuild.build({ entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', bundle: true, platform: 'node', target: 'node20', external: ['vscode'], sourcemap: false });
  await esbuild.build({ entryPoints: ['src/db/worker.js'], outfile: 'dist/worker.js', bundle: true, platform: 'node', target: 'node20', external: ['sql.js/dist/sql-wasm.wasm'], sourcemap: false });
  fs.copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), 'dist/sql-wasm.wasm');
  for (const file of ['results.js', 'results.css']) fs.copyFileSync(path.join('src/ui', file), path.join('dist', file));
  console.log('Built extension, isolated SQL worker, WASM and results view.');
}
build().catch(e => { console.error(e); process.exitCode = 1; });
