'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const sourceEntry = 'src/vs/workbench/workbench.desktop.main.ts';
const compiledEntry = 'out/vs/workbench/workbench.desktop.main.js';
const titlebarModule = 'browser/rocketbrainTitlebar.ts';
const moduleSource = path.join(__dirname, 'workbench', 'rocketbrainTitlebar.ts');
const shellCss = path.join(__dirname, 'workbench', 'rocketbrainWorkbench.css');
const browserTitlebar = 'src/vs/workbench/browser/parts/titlebar/titlebarPart.ts';
const nativeTitlebar = 'src/vs/workbench/electron-browser/parts/titlebar/titlebarPart.ts';
const titlebarHeight = 76;
const windowControlsHeight = 34;

const base = Object.freeze({
  codeOssVersion: '1.143.1',
  codeOssCommit: 'e646868227c3e3a9e3f24277c8c7220be42c0be7',
  sourceSha256: 'a8c8a112607f5797ecbfa66645cf327ff46178748453c6c16f0a7e621b3301e0',
  browserTitlebarSha256: 'ae8253643eb6bf12c936fb0cc4693a03b86166ebd56147b22a1e71e25b7f8582',
  nativeTitlebarSha256: '0d2e81162161fd9405b0f83906c5ff60f07e603dc29f2680a9aa982444948c97',
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

function replaceOriginal(text, original, replacement) {
  const updated = insertBefore(text, original, replacement);
  return updated.replace(original, '');
}

function withStyles(source) {
  return replaceOriginal(source, "const shellStyles = ''; // ROCKETBRAIN WORKBENCH CSS",
    `const shellStyles = ${JSON.stringify(fs.readFileSync(shellCss, 'utf8').replaceAll('\r\n', '\n'))};`);
}

function installSourcePatch(checkout) {
  const entry = path.join(checkout, sourceEntry);
  const original = fs.readFileSync(entry, 'utf8').replaceAll('\r\n', '\n');
  verify(sourceEntry, digest(original), base.sourceSha256);
  const patched = insertBefore(original, "import './electron-browser/parts/dialogs/dialog.contribution.js';", "import './browser/rocketbrainTitlebar.js';\n");
  const browserFile = path.join(checkout, browserTitlebar);
  const nativeFile = path.join(checkout, nativeTitlebar);
  const browser = fs.readFileSync(browserFile, 'utf8').replaceAll('\r\n', '\n');
  const native = fs.readFileSync(nativeFile, 'utf8').replaceAll('\r\n', '\n');
  verify(browserTitlebar, digest(browser), base.browserTitlebarSha256);
  verify(nativeTitlebar, digest(native), base.nativeTitlebarSha256);
  const browserPatched = insertBefore(browser, '\t\treturn value / (this.preventZoom', `\t\tif (isNative && !isMacintosh && !this.isAuxiliary) { value = ${titlebarHeight}; }\n`);
  const nativePatched = replaceOriginal(native, 'Math.round(height * getZoomFactor(getWindow(this.element)))',
    `Math.round((this.getId() === Parts.TITLEBAR_PART ? Math.min(height, ${windowControlsHeight}) : height) * getZoomFactor(getWindow(this.element)))`);
  fs.writeFileSync(path.join(path.dirname(entry), titlebarModule), withStyles(fs.readFileSync(moduleSource, 'utf8')), { flag: 'wx' });
  fs.writeFileSync(browserFile, browserPatched);
  fs.writeFileSync(nativeFile, nativePatched);
  fs.writeFileSync(entry, patched);
  return { checkout, upstreamCommit: base.codeOssCommit, sourceSha256: digest(patched) };
}

function compiledRegistration(source = fs.readFileSync(moduleSource, 'utf8')) {
  const body = /^\/\/ BEGIN ROCKETBRAIN WORKBENCH\r?\n([\s\S]+?)^\/\/ END ROCKETBRAIN WORKBENCH\r?$/m.exec(source)?.[1];
  if (!body) throw new Error('The workbench titlebar module body was not found.');
  const registration = transformSync(withStyles(body.replaceAll('\r\n', '\n')), {
    loader: 'ts',
    target: 'es2022',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  }).code;
  // These names identify the contribution services in the exact digest verified below.
  return `;((DisposableStore,MenuId,MenuRegistry,ICommandService,IContextKeyService,INotificationService,registerWorkbenchContribution2,WorkbenchPhase,IViewDescriptorService,IExtensionService,IWorkbenchLayoutService,IViewsService,ViewContainerLocation,Parts,Position)=>{\n${registration}})(P,F,De,ye,ne,Ae,st,rt,Co,Tt,Ed,hi,{Sidebar:0,Panel:1,AuxiliaryBar:2},{TITLEBAR_PART:"workbench.parts.titlebar",EDITOR_PART:"workbench.parts.editor",STATUSBAR_PART:"workbench.parts.statusbar",ACTIVITYBAR_PART:"workbench.parts.activitybar",SIDEBAR_PART:"workbench.parts.sidebar",AUXILIARYBAR_PART:"workbench.parts.auxiliarybar",PANEL_PART:"workbench.parts.panel"},{BOTTOM:2});\n`;
}

function patchCompiledWorkbench(appRoot) {
  const entry = path.join(appRoot, compiledEntry);
  const original = fs.readFileSync(entry, 'utf8');
  verify(compiledEntry, digest(original), base.bundleSha256);
  const registration = insertBefore(original, 'var MDo="0_leading",jL=class extends j{', compiledRegistration());
  const browserPatched = replaceOriginal(registration, 'return e&&(t=Math.max(t,j$o(xe(this.element))?.height??0)),t/(this.preventZoom',
    `return e&&(t=Math.max(t,j$o(xe(this.element))?.height??0)),this.isAuxiliary||(t=${titlebarHeight}),t/(this.preventZoom`);
  const patched = replaceOriginal(browserPatched, 'let i=Math.round(t*nf(xe(this.element)));i!==this.cachedWindowControlHeight',
    `let i=Math.round((this.getId()==="workbench.parts.titlebar"?Math.min(t,${windowControlsHeight}):t)*nf(xe(this.element)));i!==this.cachedWindowControlHeight`);
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
