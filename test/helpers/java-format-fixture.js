'use strict';

const assert = require('node:assert/strict');

function formatSource(packageName,name,{spring=false}={}) {
  const source = `package ${packageName};\n\n${spring?'import org.springframework.stereotype.Component;\n\n@Component\n':''}public class ${name} {\nint untouched=5;\npublic int value(boolean nested) {\nif(nested){\nreturn 42;\n}\nreturn 1;\n}\nint another=9;\n}\n`;
  const from = source.indexOf('public int value'), until = source.indexOf('\nint another');
  return {source,from,until};
}

function assertFormat(text,style,{range=false}={}) {
  const lines = text.replace(/\r\n/g,'\n').split('\n');
  const indent = columns => style.insertSpaces?' '.repeat(columns):'\t'.repeat(Math.floor(columns/style.tabWidth))+' '.repeat(columns%style.tabWidth);
  const method = 'public int value(boolean nested) {';
  const prefix = lines.find(line=>line.trimStart()===method)?.match(/^[ \t]*/)?.[0];
  assert.notEqual(prefix,undefined,JSON.stringify(text));
  let base = style.indentSize;
  if (range) {
    base = 0;
    for (const char of prefix) base += char==='\t'?style.tabWidth-base%style.tabWidth:1;
  }
  assert.ok(lines.includes(indent(base)+method),JSON.stringify(text));
  assert.ok(lines.includes(indent(base+style.indentSize)+'if (nested) {'),JSON.stringify(text));
  assert.ok(lines.includes(indent(base+style.indentSize*2)+'return 42;'),JSON.stringify(text));
}

module.exports = {formatSource,assertFormat};
