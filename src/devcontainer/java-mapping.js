'use strict';

const fs = require('node:fs');
const path = require('node:path');

const maxSourceBytes = 256 * 1024;
const invalidSegment = /[\\/:%?#\x00-\x1f\x7f]/u;

function pathSegments(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/')) {
    throw Error('Use a physical absolute Linux path in the selected container.');
  }
  const segments = value.slice(1).split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || invalidSegment.test(segment))) {
    throw Error('Use a physical absolute Linux path without aliases or traversal.');
  }
  return segments;
}

function fileUri(segments) {
  return 'file:///' + segments.map(segment => encodeURIComponent(segment)).join('/');
}

function remoteUriSegments(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:///') || uri.length > 8192) {
    throw Error('The Java server location is outside the mounted workspace.');
  }
  try {
    return pathSegments('/' + uri.slice(8).split('/').map(segment => {
      const decoded = decodeURIComponent(segment);
      if (invalidSegment.test(decoded)) throw Error();
      return decoded;
    }).join('/'));
  } catch {
    throw Error('The Java server returned an invalid mounted file URI.');
  }
}

function containedRelative(root, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Choose a Java file in the mounted workspace.');
  const relative = path.relative(root, file);
  const pieces = relative.split(path.sep);
  if (!relative || path.isAbsolute(relative) || pieces.some(piece => !piece || piece === '..' || piece === '.' ||
        piece.toLowerCase() === '.git' || invalidSegment.test(piece))) {
    throw Error('The Java file is outside the mounted workspace.');
  }
  return pieces;
}

function physicalJavaFile(root, file) {
  const relative = containedRelative(root, file);
  const stat = fs.lstatSync(file);
  if (!relative.at(-1).endsWith('.java') || !stat.isFile() || stat.size > maxSourceBytes ||
      path.relative(file, fs.realpathSync(file))) {
    throw Error('Use a physical Java source file in the mounted workspace up to 256 KiB.');
  }
  return relative;
}

function localMountSource(source, platform) {
  if (typeof source !== 'string' || source.length > 4096 || /[\x00-\x1f]/u.test(source)) return undefined;
  if (platform === 'win32') {
    if (/^[a-z]:[\\/]/i.test(source)) return source;
    const desktop = /^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\/(.+)$/i.exec(source);
    if (desktop) {
      const parts = pathSegments('/' + desktop[2]);
      return path.win32.join(desktop[1] + ':\\', ...parts);
    }
    return undefined;
  }
  return source.startsWith('/') && !source.startsWith('//') ? source : undefined;
}

function createJavaMountMapping(hostRoot, remoteRoot, mounts, platform = process.platform) {
  const segments = pathSegments(remoteRoot);
  if (!Array.isArray(mounts) || mounts.length > 64) throw Error('The selected container mount could not be verified.');
  const exact = mounts.filter(mount => mount?.Destination === remoteRoot);
  const source = localMountSource(exact[0]?.Source, platform);
  let matches = false;
  try { matches = Boolean(source && !path.relative(hostRoot, fs.realpathSync(source))); } catch {}
  if (exact.length !== 1 || exact[0].Type !== 'bind' || !matches ||
      mounts.some(mount => typeof mount?.Destination === 'string' && mount.Destination.startsWith(remoteRoot + '/'))) {
    throw Error('The selected container path must be one exact local workspace bind mount without nested mounts.');
  }
  return {
    workspaceUri: fileUri(segments),
    remoteRoot,
    toRemote(file) { return fileUri([...segments, ...physicalJavaFile(hostRoot, file)]); },
    toHost(uri) {
      const remote = remoteUriSegments(uri);
      if (remote.length <= segments.length || segments.some((segment, index) => remote[index] !== segment)) {
        throw Error('The Java server location is outside the mounted workspace.');
      }
      const file = path.join(hostRoot, ...remote.slice(segments.length));
      physicalJavaFile(hostRoot, file);
      return file;
    }
  };
}

module.exports = { createJavaMountMapping, maxSourceBytes, pathSegments };
