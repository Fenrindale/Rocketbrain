'use strict';

const assert = require('node:assert/strict');
const { jdbcOptions } = require('./coroutine-watch-fixture');
const { launchCoroutineFixture } = require('./coroutine-fixture');

const request = 'rocketbrain/evaluateKotlinWatch';
const breakpointName = 'coroutinesfixture.KotlinWatchInspection#paused';
const mainClass = 'coroutinesfixture.KotlinWatchInspection';
const compiledResult = 'Rocketbrain Kotlin evaluated|48|9007199254741035|7|43|true';
const expectations = [
  ['amount + 2 * 3', '48', 'kotlin.Int'],
  ['large + amount', '9007199254741035', 'kotlin.Long'],
  ['caption?.length ?: 0', '7', 'kotlin.Int'],
  ['missing?.length ?: amount + 1', '43', 'kotlin.Int'],
  ['enabled && caption == "receipt" && boxed == 7', 'true', 'kotlin.Boolean'],
  ['boxed ?: 0', '7', 'kotlin.Int'],
  ['caption + " " + amount', '"receipt 42"', 'kotlin.String'],
  ['missing', 'null', 'kotlin.Nothing?'],
  ['enabled || (amount / 0 > 0)', 'true', 'kotlin.Boolean'],
  ['2147483647 + 1', '-2147483648', 'kotlin.Int']
];
const indexedExpectations = [
  ['numbers[1] + mutable[1]', '49', 'kotlin.Int'],
  ['numbers.size + captions.size', '5', 'kotlin.Int'],
  ['(captions[0] ?: "").length', '7', 'kotlin.Int'],
  ['captions[1] ?: "fallback"', '"fallback"', 'kotlin.String'],
  ['singleton[0]', 'null', 'kotlin.Nothing?'],
  ['immutable[0] + immutable[1]', '9007199254740996', 'kotlin.Long'],
  ['nested[0][1]', '7', 'kotlin.Int'],
  ['absentList?.size ?: 0', '0', 'kotlin.Int']
];

async function launchKotlinWatches(fixture, options, port) {
  const jdbc = await jdbcOptions(options);
  return launchCoroutineFixture(fixture, {
    vmArgs: ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:' + port]
  }, { ...jdbc, mainClass, env: {...jdbc.env, ...(options.fieldSignal ? {RB_KOTLIN_TEST_FIELD_SIGNAL:options.fieldSignal} : {})} });
}

async function assertKotlinWatchValues(send, frameId) {
  const values = [];
  for (const [expression, result, type] of expectations) {
    const body = await send('evaluate', { frameId, expression, context: 'watch' });
    assert.equal(body.result, result, expression);
    assert.equal(body.type, type, expression);
    assert.equal(body.variablesReference, 0, expression);
    values.push({ expression, result, type });
  }
  const hover = await send('evaluate', { frameId, expression: 'caption', context: 'hover' });
  assert.equal(hover.result, '"receipt"');
  assert.equal(hover.type, 'kotlin.String');
  const consoleValue = await send('evaluate', { frameId, expression: 'amount + 1', context: 'repl' });
  assert.equal(consoleValue.result, '43');
  for (const expression of ['side.mutate()', 'amount = 999', 'amount++', 'caption.hashCode()', 'true || side.mutate() > 0']) {
    await assert.rejects(send('evaluate', { frameId, expression, context: 'watch' }), /Kotlin (?:scalar )?watch expression/u);
  }
  await assert.rejects(send('evaluate', { frameId, expression: 'side', context: 'watch' }), /supported (?:Kotlin )?scalar/u);
  await assert.rejects(send('evaluate', { frameId, expression: 'absent', context: 'watch' }), /No visible Kotlin local/u);
  await assert.rejects(send('evaluate', { frameId, expression: '42'.repeat(170), context: 'watch' }), /320 characters/u);
  await assert.rejects(send('evaluate', { frameId, expression: 'amount / 0', context: 'watch' }), /division by zero/u);
  return values;
}

async function assertIndexedKotlinWatchValues(send, frameId) {
  const values = [];
  for (const [expression,result,type] of indexedExpectations) {
    const body = await send('evaluate',{frameId,expression,context:'watch'});
    assert.deepEqual([body.result,body.type,body.variablesReference],[result,type,0],expression);
    values.push({expression,result,type});
  }
  for (const [expression,message] of [['numbers[2]',/out of range/u],['numbers[-1]',/out of range/u],
    ['numbers[0L]',/Int index/u],['captions.get(0)',/Kotlin watch expression/u],
    ['trap.size',/standard JVM list/u],['trap[0]',/standard JVM list/u]]) {
    await assert.rejects(send('evaluate',{frameId,expression,context:'watch'}),message);
  }
  const list = await send('rocketbrain/readJavaValues',{action:'list',frameId});
  assert.ok(list.values.some(value=>value.name==='captions'&&value.kind==='list'&&value.length===3));
  assert.ok(!list.values.some(value=>value.name==='trap'));
  const page = await send('rocketbrain/readJavaValues',{action:'page',frameId,name:'captions',start:0,count:2});
  assert.deepEqual(page.rows.map(value=>value.display),['receipt','null']);
  return {values,paged:true,customGetterRefused:true,invalidIndicesRefused:true};
}

function kotlinWatchJdbcResult(output, engine) {
  assert.ok(output.includes(compiledResult), output);
  const match = /Rocketbrain Kotlin JDBC\|([^|\r\n]+)\|(\d+)\|(\d+)/u.exec(output);
  assert.ok(match, 'No Spring JDBC results from the resumed Kotlin fixture.');
  assert.match(match[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(match[2], '42');
  assert.equal(match[3], '0');
  return { engine, server: match[1], amount: Number(match[2]), sideEffects: Number(match[3]) };
}

module.exports = { request, breakpointName, launchKotlinWatches, assertKotlinWatchValues,
  assertIndexedKotlinWatchValues, kotlinWatchJdbcResult };
