'use strict';

const distroName = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,127}$/u;
const authority = /^(?:wsl\.localhost|wsl\$)$/iu;
const segment = /^[^\\/:<>"|?*\x00-\x1f\x7f]+$/u;

function linuxProjectPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')) {
    throw Error('Enter one absolute physical Linux project folder.');
  }
  const parts = value.slice(1).split('/');
  if (parts.some(part => !segment.test(part) || part.length > 255 || /[. ]$/u.test(part) || part === '.' || part === '..')) {
    throw Error('Use an exact Linux project path without aliases, links or ambiguous Windows names.');
  }
  return value;
}

function wslUnc(value) {
  if (typeof value !== 'string' || !value.startsWith('\\\\')) return undefined;
  const [host, distribution, ...parts] = value.slice(2).split('\\');
  if (!authority.test(host)) return undefined;
  if (!distroName.test(distribution || '') || !parts.length) {
    throw Error('Use a WSL UNC project folder inside a registered distribution.');
  }
  const linux = linuxProjectPath('/' + parts.join('/'));
  return { distribution, linux };
}

function sameWslPath(one, other) {
  return one && other && one.distribution === other.distribution && one.linux === other.linux;
}

module.exports = { distroName, linuxProjectPath, wslUnc, sameWslPath };
