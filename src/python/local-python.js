'use strict';

const fs = require('node:fs');
const path = require('node:path');

function localPython(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)) {
    throw Error('Choose an absolute path to a local Python interpreter.');
  }
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isFile() || /^[\\/]{2}/.test(real)) throw Error('Choose an installed local Python interpreter.');
  return path.normalize(value);
}

function pythonEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|JUPYTER_PATH|IPYTHONDIR|JUPYTER_CONFIG_DIR)$/i.test(key)) delete env[key];
  }
  return env;
}

module.exports = { localPython, pythonEnvironment };
