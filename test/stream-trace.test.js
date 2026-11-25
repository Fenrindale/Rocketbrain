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


const jdkOptions = { skip: !process.env.ROCKETBRAIN_STREAM_PROOF_JAVA };
const traceOnJdk = source => traceStream(source, process.env.ROCKETBRAIN_STREAM_PROOF_JAVA);

test('primitive ranges, conversions and bounded literal validation use exact JDK origins', () => {
  const plan = streamPipeline('LongStream.rangeClosed(9_007_199_254_740_992L,9_007_199_254_740_995L).mapToDouble(x -> x).toArray()');
  assert.equal(plan.qualified, 'java.util.stream.LongStream');
  assert.equal(plan.sourceCount, 4);
  assert.deepEqual(plan.stages.map(stage => stage.outputType), ['long', 'double', 'double']);
  assert.equal(streamPipeline('DoubleStream.of(1e-3,-0.4).sum()').sourceCount, 2);
  assert.equal(streamPipeline('IntStream.rangeClosed(9,8).findFirst()').sourceCount, 0);
  assert.throws(() => streamPipeline('IntStream.range(0,100001).count()'), /100,000/);
  assert.throws(() => streamPipeline('LongStream.range(0x08,10).count()'), /decimal integer/);
  assert.throws(() => streamPipeline('my.IntStream.of(4).count()'), /JDK Stream/);
  assert.throws(() => streamPipeline('IntStream.of(1).anyMatch(Integer::isInfinite)'), /expression lambda/);
});

test('actual primitive matching shows interleaved demand and typed terminal result', jdkOptions, async () => {
  const result = await traceOnJdk('IntStream.rangeClosed(1,20).map(x -> x*3).filter(x -> x%2==0).anyMatch(x -> x>8)');
  assert.deepEqual(result.demand, { evaluation: 'short-circuited', sourceCount: 20, inputEvents: 4 });
  assert.deepEqual(result.terminal, { name: 'anyMatch', kind: 'scalar', type: 'java.lang.Boolean',
    value: 'true', valueType: 'java.lang.Boolean' });
  const timeline = result.events.map(event => [event.sequence, result.stages[event.stage].name, event.input, event.output]);
  assert.deepEqual(timeline.slice(0, 5), [[1, 'input', '1', null], [2, 'map', '1', '3'], [3, 'filter', '3', null],
    [4, 'input', '2', null], [5, 'map', '2', '6']]);
  assert.deepEqual(timeline.filter(([, name]) => name === 'anyMatch'), [[7, 'anyMatch', '6', 'false'], [14, 'anyMatch', '12', 'true']]);
  assert.equal(result.events[1].inputType, 'java.lang.Integer');
  assert.equal(result.events.at(-1).outputType, 'java.lang.Boolean');
  const page = require('../src/java/stream-trace-vscode').renderStreamTrace(result);
  assert.match(page, /terminal returned before the declared source was fully traversed/);
  assert.match(page, /^\s+1  input · input "1" \[java\.lang\.Integer\]/m);
  assert.match(page, /^\s*14  anyMatch · predicate "12" → "true"/m);
});

test('stateful sorted and distinct capture buffer consumption before findFirst', jdkOptions, async () => {
  const result = await traceOnJdk('IntStream.of(9,2,2,1,5).distinct().sorted().skip(1).findFirst()');
  assert.equal(result.demand.inputEvents, 5);
  assert.equal(result.demand.evaluation, 'observed');
  const sorted = result.events.filter(event => result.stages[event.stage].name === 'sorted');
  assert.deepEqual(sorted.filter(item => item.action === 'candidate').map(item => item.input), ['9','2','1','5']);
  assert.deepEqual(sorted.filter(item => item.action === 'emitted').map(item => item.input), ['1','2']);
  const inputLast = result.events.findLast(event => event.stage === 0);
  assert.ok(inputLast.sequence < sorted.find(item => item.action === 'emitted').sequence);
  assert.deepEqual(result.terminal, { name: 'findFirst', kind: 'optional', type: 'java.util.OptionalInt', value: '2',
    valueType: 'java.lang.Integer' });
});

test('terminal count preserves JDK elision and separates real traversal, empty and capped receipts', jdkOptions, async () => {
  const elided = await traceOnJdk('IntStream.range(0,9).map(x -> 1/(x-x)).count()');
  assert.deepEqual(elided.events, []);
  assert.equal(elided.terminal.value, '9');
  assert.equal(elided.demand.evaluation, 'count-without-traversal');
  const counted = await traceOnJdk('IntStream.range(0,9).filter(x -> x%2==0).count()');
  assert.equal(counted.terminal.value, '5');
  assert.equal(counted.demand.inputEvents, 9);
  const empty = await traceOnJdk('IntStream.empty().findFirst()');
  assert.equal(empty.terminal.value, null);
  assert.equal(empty.terminal.kind, 'optional');
  assert.equal(empty.demand.evaluation, 'no-events');
  const clipped = await traceOnJdk('IntStream.range(0,1000).map(x -> x*2).sum()');
  assert.equal(clipped.events.length, 512);
  assert.equal(clipped.terminal.value, '999000');
  assert.equal(clipped.demand.evaluation, 'capture-limited');
  assert.equal(clipped.truncated, true);
});

test('primitive conversion, expansion, arrays and long precision survive real JDK tracing', jdkOptions, async () => {
  const long = await traceOnJdk('LongStream.range(9007199254740993L,9007199254740997L).findFirst()');
  assert.equal(long.events[0].input, '9007199254740993');
  assert.equal(long.terminal.value, '9007199254740993');
  assert.equal(long.terminal.valueType, 'java.lang.Long');
  const double = await traceOnJdk('DoubleStream.of(1e-3, 2.5, -0.5).mapToObj(x -> Double.toString(x)).toArray()');
  assert.deepEqual(double.events.filter(event => event.action === 'mapped').map(event => [event.inputType, event.outputType]),
    Array.from({ length: 3 }, () => ['java.lang.Double', 'java.lang.String']));
  assert.deepEqual(double.terminal, { name: 'toArray', kind: 'array', type: 'java.lang.Object[]', value: '3',
    valueType: 'java.lang.Integer' });
  const flat = await traceOnJdk('Stream.of(1,2).flatMapToInt(x -> IntStream.range(x,x+2)).mapToLong(x -> x).skip(1).sum()');
  assert.equal(flat.terminal.value, '7');
  assert.equal(flat.terminal.valueType, 'java.lang.Long');
  assert.ok(flat.events.filter(event => event.action === 'mapped').every(event => event.outputType === 'java.lang.Long'));
  assert.deepEqual(flat.events.filter(event => event.action === 'flat value').map(event => event.output), ['1','2','2','3']);
});
