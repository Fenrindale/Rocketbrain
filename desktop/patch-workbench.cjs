'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sourceEntry = 'src/vs/workbench/workbench.desktop.main.ts';
const compiledEntry = 'out/vs/workbench/workbench.desktop.main.js';
const titlebarModule = 'browser/rocketbrainTitlebar.ts';
const moduleSource = path.join(__dirname, 'workbench', 'rocketbrainTitlebar.ts');

const base = Object.freeze({
  codeOssVersion: '1.143.1',
  codeOssCommit: 'e646868227c3e3a9e3f24277c8c7220be42c0be7',
  sourceSha256: 'a8c8a112607f5797ecbfa66645cf327ff46178748453c6c16f0a7e621b3301e0',
  vscodiumVersion: '1.143.17232',
  vscodiumCommit: 'ca7f7b44b5e5c3faa663f6cdc043998f71936653',
  bundleSha256: '8d84032a329de378286c48b1524a126eb080b96b45ef5cf300c62f85884a1fd5',
});

const digest = (value, format = 'hex') => crypto.createHash('sha256').update(value).digest(format);

function verify(pathname, received, expected) {
  if (received !== expected) throw new Error(`Unexpected original ${pathname} (SHA-256 ${received}).`);
}

function insertBefore(text, anchor, inserted) {
  const offset = text.indexOf(anchor);
  if (offset < 0 || text.lastIndexOf(anchor) !== offset) throw new Error('The expected workbench insertion point was not unique.');
  return text.slice(0, offset) + inserted + text.slice(offset);
}

function installSourcePatch(checkout) {
  const entry = path.join(checkout, sourceEntry);
  const original = fs.readFileSync(entry, 'utf8').replaceAll('\r\n', '\n');
  verify(sourceEntry, digest(original), base.sourceSha256);
  const patched = insertBefore(original, "import './electron-browser/parts/dialogs/dialog.contribution.js';", "import './browser/rocketbrainTitlebar.js';\n");
  fs.copyFileSync(moduleSource, path.join(path.dirname(entry), titlebarModule), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(entry, patched);
  return { checkout, upstreamCommit: base.codeOssCommit, sourceSha256: digest(patched) };
}

function compiledRegistration(source = fs.readFileSync(moduleSource, 'utf8')) {
  const body = /^\/\/ BEGIN ROCKETBRAIN WORKBENCH\r?\n([\s\S]+?)^\/\/ END ROCKETBRAIN WORKBENCH\r?$/m.exec(source)?.[1];
  if (!body) throw new Error('The workbench titlebar module body was not found.');
  // Bound to the pinned binary's exact digest. The native registry, context keys,
  // commands, and pane services match the imports in the source contribution.
  return `;((Codicon,CommandsRegistry,ICommandService,MenuId,MenuRegistry,ContextKeyExpr,IPaneCompositePartService,ViewContainerLocation)=>{\n${body.replaceAll('\r\n', '\n')}})(A,Ke,ye,F,De,D,Ra,{Panel:1});\n`;
}

function patchCompiledWorkbench(appRoot) {
  const entry = path.join(appRoot, compiledEntry);
  const original = fs.readFileSync(entry, 'utf8');
  verify(compiledEntry, digest(original), base.bundleSha256);
  const patched = insertBefore(original, 'var MDo="0_leading",jL=class extends j{', compiledRegistration());
  fs.writeFileSync(entry, patched);
  return {
    entry: compiledEntry,
    upstreamCommit: base.codeOssCommit,
    originalSha256: base.bundleSha256,
    patchedSha256: digest(patched),
    productChecksum: digest(patched, 'base64').replace(/=+$/, ''),
  };
}

module.exports = { base, installSourcePatch, patchCompiledWorkbench, compiledRegistration };

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 2 && args[0] === '--source') {
      console.log(JSON.stringify(installSourcePatch(path.resolve(args[1]))));
    } else if (args.length === 1) {
      console.log(JSON.stringify(patchCompiledWorkbench(path.resolve(args[0]))));
    } else {
      throw new Error('Usage: node desktop/patch-workbench.cjs <resources/app> or --source <Code OSS checkout>');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
