'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inside } = require('../java/workbench-model');
const { localPython } = require('./local-python');

async function localEntry(file, directory = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/u.test(file)) return null;
  const real = await fs.realpath(file).catch(() => null);
  if (!real || /^[\\/]{2}/u.test(real)) return null;
  const stat = await fs.stat(real).catch(() => null);
  return (directory ? stat?.isDirectory() : stat?.isFile()) ? real : null;
}

async function standaloneNode(configured) {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const paths = configured ? [configured] : (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
    .map(folder => path.join(folder, name));
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || path.basename(candidate).toLowerCase() !== name) continue;
    const executable = await localEntry(candidate);
    if (executable) return executable;
  }
  throw Error('Set rocketbrain.python.typeNodePath to a standalone local Node.js executable.');
}

async function pyrightLaunch({ serverHome, nodePath, workspace, python }) {
  const root = await localEntry(workspace, true);
  const home = await localEntry(serverHome, true);
  if (!root || !home) throw Error('Choose a local workspace and configure the open-source Pyright installation folder.');
  const manifest = await localEntry(path.join(home, 'package.json'));
  const server = await localEntry(path.join(home, 'langserver.index.js'));
  if (!manifest || !server || !inside(home, manifest) || !inside(home, server) ||
      (await fs.stat(manifest)).size > 64 * 1024) throw Error('The Pyright language server installation is incomplete.');
  let packageData;
  try { packageData = JSON.parse(await fs.readFile(manifest, 'utf8')); }
  catch { throw Error('The Pyright installation manifest could not be read.'); }
  if (packageData.name !== 'pyright' || !/^1\.[0-9]+\.[0-9]+$/u.test(packageData.version ?? '') ||
      !/^(?:\.\/)?langserver\.index\.js$/u.test(packageData.bin?.['pyright-langserver'] ?? '')) {
    throw Error('Choose an installed Pyright 1.x distribution with its standard language server.');
  }
  const node = await standaloneNode(nodePath);
  const interpreter = python ? localPython(python) : undefined;
  const allowed = new Set(['path','systemroot','windir','comspec','temp','tmp','tmpdir','userprofile','home','lang','lc_all']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  return { command: node, args: [server, '--stdio'], root, interpreter, version: packageData.version,
    options: { cwd: root, env, windowsHide: true, shell: false } };
}

function analysisSettings(interpreter, mode = 'standard') {
  return { python: { ...(interpreter && { pythonPath: interpreter }),
    analysis: { typeCheckingMode: mode, diagnosticMode: 'openFilesOnly', useLibraryCodeForTypes: true } },
    pyright: { disableOrganizeImports: true } };
}

module.exports = { pyrightLaunch, analysisSettings };
