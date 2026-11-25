'use strict';

const assert=require('node:assert/strict');

function kotlinFormatSource(namespace,name) {
  const raw='"""start\n       exact raw indent\n  final row"""';
  const quoted='"quoted \\"fixture\\" and \\t"';
  const template='"'+ '${if (enabled) "yes" else "no"}'+'"';
  const source=`package ${namespace}\n\nclass ${name}{\nval unformatted=5\n  fun value(enabled:Boolean):String{\nval content=${raw}\nval line=${quoted}\nval toggle=${template}\nif(enabled){return content+line+toggle}\nreturn line\n}\nval another=9\n}\n\nfun main(){print(${name}().value(true).encodeToByteArray().joinToString(","))}\n`;
  return {source,raw,quoted,template,rangeStart:source.indexOf('  fun value'),rangeEnd:source.indexOf('\nval another')};
}

function assertKotlinFormat(text,fixture,style) {
  const normalized=text.replace(/\r\n/g,'\n');
  const physical=columns=>style.insertSpaces?' '.repeat(columns):'\t'.repeat(Math.floor(columns/style.tabWidth))+' '.repeat(columns%style.tabWidth);
  assert.ok(normalized.includes('\n'+physical(style.indentSize)+'fun value(enabled: Boolean): String {'),JSON.stringify(text));
  assert.ok(normalized.includes('\n'+physical(style.indentSize*2)+'val content = '+fixture.raw));
  assert.ok(normalized.includes(fixture.quoted));
  assert.ok(normalized.includes(fixture.template));
}

module.exports={kotlinFormatSource,assertKotlinFormat};
