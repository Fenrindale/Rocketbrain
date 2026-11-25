'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { streamPipeline, traceStream } = require('../src/java/stream-trace');

const sample = 'java.util.stream.Stream.of(1, 2, 3, 4, 5).filter(x -> x % 2 == 0)\n' +
  '  .map(x -> x * 10).flatMap(x -> Stream.of(x, x + 1)).limit(3).toList()';

test('Java stream source retains exact offsets through nested expressions', () => {
  const plan = streamPipeline(sample);
  assert.deepEqual(plan.stages.map(item=>item.name), ['input','filter','map','flatMap','limit','toList']);
  assert.equal(sample.slice(plan.stages[3].start,plan.stages[3].end),'flatMap(x -> Stream.of(x, x + 1))');
  assert.equal(plan.stages[4].limit,'3');
  assert.equal(streamPipeline('java.util.List.of(-2, 0).stream().map((x) -> x + 1).toList()').list,true);
});

test('the Java stream preview requires a bounded self-contained sequential expression with a terminal result', () => {
  assert.throws(()=>streamPipeline('Stream.of(values).toList()'),/literal Java values/);
  assert.throws(()=>streamPipeline('Stream.of(1).parallel().toList()'),/filter, map/);
  assert.throws(()=>streamPipeline('Stream.of(1).map(x -> { return x; }).toList()'),/expression lambda/);
  assert.throws(()=>streamPipeline('Stream.of(1).map(x -> x)'),/ending with toList/);
});

test('the configured real JDK preserves stream short-circuit order and exact step values',
  {skip:!process.env.ROCKETBRAIN_STREAM_PROOF_JAVA},async()=>{
    const executable = process.env.ROCKETBRAIN_STREAM_PROOF_JAVA;
    const report = await traceStream(sample,executable);
    assert.deepEqual(report.events.filter(item=>item.action==='result').map(item=>item.input),['20','21','40']);
    assert.deepEqual(report.events.filter(item=>item.action==='rejected').map(item=>item.input),['1','3']);
    assert.deepEqual(report.events.filter(item=>item.action==='input').map(item=>item.input),['1','2','3','4']);
    assert.deepEqual(report.events.filter(item=>item.action==='mapped').map(item=>[item.input,item.output]),[['2','20'],['4','40']]);
    assert.equal(report.truncated,false);
    const empty = await traceStream('Stream.of(1,2).map(x -> x + 1).limit(0).toList()',executable);
    assert.deepEqual(empty.events,[]);
    await assert.rejects(traceStream(sample,executable,{signal:AbortSignal.abort()}),/cancelled/);
  });
