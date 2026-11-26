'use strict';

const invalidPart = /[\\:/%?#\x00-\x1f\x7f]/u;

function parts(value, rooted) {
  const segments = value.split('/');
  if (!segments.length || segments.length > 40 || segments.some(part => !part || part === '.' || part === '..' ||
      part.length > 255 || invalidPart.test(part) || !rooted && part.toLowerCase() === '.git')) {
    throw Error('Choose a physical Java path in the reviewed SSH workspace.');
  }
  return segments;
}

function rootParts(root) {
  if (typeof root !== 'string' || root.length > 4096) throw Error('Choose an absolute SSH runtime path.');
  const windows = /^([A-Za-z]):[\\/](.*)$/u.exec(root);
  if (windows) return { drive: windows[1].toUpperCase(), segments: parts(windows[2].replaceAll('\\', '/'), true) };
  if (root.startsWith('/') && !root.startsWith('//')) return { segments: parts(root.slice(1), true) };
  throw Error('Choose an absolute SSH runtime path.');
}

function fileUri({ drive, segments }) {
  return 'file:///' + (drive ? drive + ':/' : '') + segments.map(encodeURIComponent).join('/');
}

function pathForJava(file) {
  if (typeof file !== 'string' || file.length > 4096 || !file.startsWith('/') || !file.endsWith('.java')) {
    throw Error('Choose a Java source file in the reviewed SSH workspace.');
  }
  return parts(file.slice(1), false);
}

function createSshJavaMapping(root) {
  const expected = rootParts(root);
  return {
    workspaceUri: fileUri(expected),
    toRemote(file) { return fileUri({ drive: expected.drive, segments: [...expected.segments, ...pathForJava(file)] }); },
    toHost(uri) {
      if (typeof uri !== 'string' || !uri.startsWith('file:///') || uri.length > 8192) {
        throw Error('The SSH Java location is outside the reviewed workspace.');
      }
      const encoded = uri.slice(8).split('/');
      const decoded = encoded.map(part => decodeURIComponent(part));
      const drive = /^[a-z]:$/iu.test(decoded[0]) ? decoded.shift()[0].toUpperCase() : undefined;
      if (drive !== expected.drive || decoded.length <= expected.segments.length ||
          decoded.some(part => !part || part === '.' || part === '..' || invalidPart.test(part)) ||
          expected.segments.some((part, index) => drive ? decoded[index].toLowerCase() !== part.toLowerCase() : decoded[index] !== part)) {
        throw Error('The SSH Java location is outside the reviewed workspace.');
      }
      const file = '/' + decoded.slice(expected.segments.length).join('/');
      pathForJava(file);
      return file;
    }
  };
}

module.exports = { createSshJavaMapping, rootParts };
