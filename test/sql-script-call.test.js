'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {analyzeScript,bindScript,publicScript}=require('../src/db/sql-script');

const options={sqlMode:['STRICT_TRANS_TABLES'],allowCalls:true};
const valid='SELECT 1; CALL `fixture`.`exact_read`(:value); SELECT 2';

test('ordinary CALL keeps the source span and binds only exact scoped value placeholders',()=>{
  const script=analyzeScript(valid,options);
  assert.equal(script.hasWrites,false);
  assert.equal(script.statements.length,3);
  assert.deepEqual(script.statements[1].call,{schema:'fixture',procedure:'exact_read',inputs:1});
  const input={value:{kind:'integer',value:'9007199254740993'}};
  const bound=bindScript(script,input);
  assert.deepEqual(bound.statements[1].valueKinds,['integer']);
  assert.deepEqual(bound.statements[1].values,[input.value.value]);
  assert.equal(JSON.stringify(publicScript(bound)).includes(input.value.value),false);
  assert.throws(()=>analyzeScript(valid,{sqlMode:options.sqlMode}),/read-only|unavailable/);
});

test('ordinary CALL refuses expressions, system variables, duplicate output labels and malformed boundaries',()=>{
  for(const input of ['CALL package.schema.member(?)','CALL routine(@@session.sql_mode)','CALL routine(1)',
    'CALL routine(@value,@VALUE)','CALL routine(?,)','CALL routine(?) RETURNING 1','CALL routine(ABS(?))','CALL ?(?)']) {
    assert.throws(()=>analyzeScript(input,options),{code:'ROCKETBRAIN_SCRIPT_CALL'});
  }
});

test('ordinary CALL records output labels separately from bound input values',()=>{
  const script=analyzeScript('CALL exact_read(:value, @label)',options);
  assert.deepEqual(script.statements[0].call,{procedure:'exact_read',inputs:1,slots:[null,'label']});
  const bound=bindScript(script,{value:{kind:'integer',value:'9007199254740993'}});
  assert.deepEqual(bound.statements[0].values,['9007199254740993']);
  assert.equal(JSON.stringify(publicScript(bound)).includes('9007199254740993'),false);
});
