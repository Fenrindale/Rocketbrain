'use strict';

function qualifiedSqlName(dialect, ...segments) {
  const delimiter = dialect === 'sqlite' ? '"' : '`';
  if (!segments.length || segments.some(name => typeof name !== 'string' || !name || /[\u0000-\u001f\u007f]/u.test(name))) {
    throw Error('Choose a named database object.');
  }
  return segments.map(name => delimiter + name.replaceAll(delimiter, delimiter + delimiter) + delimiter).join('.');
}

module.exports = { qualifiedSqlName };
