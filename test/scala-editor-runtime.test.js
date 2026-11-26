'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { configureScalaTransport } = require('../src/java/scala-editor-runtime');

test('Scala answers the language server configuration request before initialize completes',()=>{
  let receive;
  const replies=[], forwarded=[];
  const reader={listen(listener){receive=listener;}};
  const writer={async write(message){replies.push(message);}};
  const transport=configureScalaTransport({reader,writer},assert.fail);
  transport.reader.listen(message=>forwarded.push(message));
  receive({jsonrpc:'2.0',id:1,method:'workspace/configuration',params:{items:[
    {section:'metals.autoImportBuilds'},{section:'metals.defaultBspToBuildTool'},{section:'unknown'},{section:'metals.constructor'}
  ]}});
  const initialized={jsonrpc:'2.0',id:2,result:{capabilities:{}}};
  receive(initialized);
  assert.deepEqual(replies,[{jsonrpc:'2.0',id:1,result:['off',false,null,null]}]);
  assert.deepEqual(forwarded,[initialized]);
});
