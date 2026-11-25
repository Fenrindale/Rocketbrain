'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const yauzl = createRequire(require.resolve('@vscode/vsce/package.json'))('yauzl');
const archive = path.resolve(process.argv[2] || path.join(root, `${manifest.name}-${manifest.version}.vsix`));
const parent = path.join(root, '.vscode-test', 'packages');
fs.mkdirSync(parent, { recursive: true });
const destination = fs.mkdtempSync(path.join(parent, `${manifest.version}-`));
const expected = new Set(['[Content_Types].xml', 'extension.vsixmanifest', ...[
  'package.json', 'readme.md', 'NOTICE.txt', 'THIRD-PARTY-LICENSES.txt',
  'dist/java-quality-gate.js', 'dist/ide-mcp-server.js',
  'dist/extension.js', 'dist/worker.js', 'dist/sql-wasm.wasm', 'dist/results.js', 'dist/results.css',
  'dist/java-async/TaskTrace.java', 'dist/java-debug/LocalValueInspection.java',
  'themes/rocketbrain-dark.json', 'media/rocketbrain.svg', 'media/duckdb.tmLanguage.json', 'media/jdbc.tmLanguage.json',
  'media/scala.tmLanguage.json', 'media/jpql.tmLanguage.json'
].map(file => `extension/${file}`)]);

async function extract() {
  const seen = new Set();
  await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      let failed = false;
      const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('entry', entry => {
        const target = path.resolve(destination, entry.fileName);
        if (!expected.has(entry.fileName) || seen.has(entry.fileName) || !target.startsWith(destination + path.sep) || entry.uncompressedSize > 16 * 1024 * 1024 || ((entry.externalFileAttributes >>> 16) & 0xF000) === 0xA000) return fail(new Error(`Invalid VSIX payload: ${entry.fileName}`));
        seen.add(entry.fileName);
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const output = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', fail); output.on('error', fail);
          output.on('finish', () => { if (!failed) zip.readEntry(); }); stream.pipe(output);
        });
      });
      zip.on('end', () => seen.size === expected.size ? resolve() : reject(new Error('The VSIX is incomplete.')));
      zip.readEntry();
    });
  });
  process.env.ROCKETBRAIN_TEST_EXTENSION_PATH = path.join(destination, 'extension');
  console.log(`Testing the extracted VSIX payload: ${process.env.ROCKETBRAIN_TEST_EXTENSION_PATH}`);
  require('./test-extension');
}
extract().catch(error => { console.error(error); process.exitCode = 1; });
