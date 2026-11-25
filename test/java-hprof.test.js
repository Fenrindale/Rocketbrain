'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {test}=require('node:test');
const {ownedHeapFixture}=require('./helpers/heap-fixture');
const {parseHprof}=require('../src/java/hprof-format');
const {analyzeHprof}=require('../src/java/hprof-graph');
const {createJvmDiagnostics}=require('../src/java/jvm-diagnostics');
const {showHeapAnalysis}=require('../src/java/hprof-vscode');

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('four-byte HPROF dominators handle cycles, shared descendants and predecessors that have no root path',async()=>{
  const byte=value=>Buffer.from([value]);
  const short=value=>{const bytes=Buffer.alloc(2);bytes.writeUInt16BE(value);return bytes;};
  const word=value=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(value);return bytes;};
  const combine=(...parts)=>Buffer.concat(parts);
  const record=(tag,body)=>combine(byte(tag),word(0),word(body.length),body);
  const symbol=(id,name)=>record(1,combine(word(id),Buffer.from(name)));
  const classId=123,root=(tag,id)=>combine(byte(tag),word(id));
  const field=(id)=>combine(word(id),byte(2));
  const metadata=combine(byte(0x20),word(classId),Buffer.alloc(32),short(0),short(0),short(2),field(22),field(23));
  const instance=(id,left,right)=>combine(byte(0x21),word(id),word(0),word(classId),word(8),word(left),word(right));
  const dump=combine(Buffer.from('JAVA PROFILE 1.0.2\0'),word(4),Buffer.alloc(8),
    symbol(21,'fixture/GraphNode'),symbol(22,'left'),symbol(23,'right'),
    record(2,combine(word(1),word(classId),word(0),word(21))),
    record(0x1c,combine(root(0xff,1),root(5,classId),metadata,
      instance(1,2,3),instance(2,4,0),instance(3,4,0),instance(4,2,0),instance(5,4,0))),
    record(0x2c,Buffer.alloc(0)));
  const graph=await analyzeHprof(dump);
  assert.equal(graph.metrics.unresolvedReferences,0);
  assert.equal(graph.metrics.unreachable,1);
  assert.equal(graph.inspect('0x1').retainedPayloadBytes,32);
  assert.equal(graph.inspect('0x4').dominator.address,'0x1');
  assert.equal(graph.inspect('0x2').retainedObjects,1);
  assert.equal(graph.inspect('0x5').retainedObjects,null);
  assert.deepEqual(graph.inspect('0x4').path.map(step=>step.via),['Unknown root','left','left']);
  const selected=['Find Objects by Java Type','fixture.GraphNode','0x4','Path to GC Root',
    'Open Immediate Dominator','Object Summary','Return to Heap'];
  const output=[];
  await showHeapAnalysis({window:{
    showInputBox:async()=> 'GraphNode',
    showQuickPick:async items=>{
      const search=selected.shift();
      if(!search)return undefined;
      const item=items.find(option=>option.label===search||option.key===search);
      assert.ok(item,search);
      return item;
    }
  }},graph,(title,lines)=>output.push({title,lines}));
  assert.deepEqual(output.map(item=>item.title),['Path to GC Root · 0x4','fixture.GraphNode · 0x1']);
  assert.match(output[0].lines.at(-1),/left → fixture\.GraphNode 0x4/);
  assert.match(output[1].lines[1],/^32 retained payload bytes · 4 objects$/);
  await assert.rejects(analyzeHprof(dump.subarray(0,-6)),/truncated/);
});

test('actual HotSpot jcmd heap capture contains the owned inheritance, arrays and roots', {
  skip:!config,timeout:120000
},async()=>{
  const {javaHome}=JSON.parse(await fs.readFile(config,'utf8')),fixture=await ownedHeapFixture(javaHome);
  try {
    const saved=await fixture.dump(true);
    assert.match(saved.stdout,/Heap dump file created/);
    const graph=await parseHprof(await fs.readFile(fixture.output));
    assert.ok(graph.roots.size>0);
    assert.equal(graph.objects.filter(object=>object.kind==='instance'&&object.typeName==='HeapFixture$Owner').length,1);
    assert.ok(graph.objects.some(object=>object.typeName==='byte[]'&&object.shallow===40000));
    const analyzer=createJvmDiagnostics({javaHome,storagePath:path.join(fixture.root,'diagnostics')});
    const analysis=await analyzer.inspectHeapDump(fixture.output);
    const owner=analysis.objects({type:'instance HeapFixture$Owner'}).rows[0];
    const proof=analysis.inspect(owner.address);
    assert.equal(proof.retainedPayloadBytes,58000+analysis.metrics.idSize*7,JSON.stringify(proof));
    assert.equal(proof.retainedObjects,6);
    assert.ok(proof.path.some(step=>step.via==='static KEEP'));
    assert.ok(proof.outgoing.rows.some(step=>step.label==='owned'));
    assert.equal(proof.dominator?.type,'HeapFixture');
    assert.ok(analysis.metrics.excludedNonStrongReferences>=1);
    assert.ok(proof.outgoing.rows.some(step=>step.label==='shared'&&step.object.retainedPayloadBytes===30008));
    const cancelled=new AbortController();
    cancelled.abort();
    await assert.rejects(analyzer.inspectHeapDump(fixture.output,{signal:cancelled.signal}),/cancelled/);
    const bytes=await fs.readFile(fixture.output);
    await assert.rejects(analyzeHprof(bytes.subarray(0,-1)),/truncated/);
    const report=process.env.ROCKETBRAIN_HEAP_RECEIPT;
    if(report)await fs.writeFile(report,JSON.stringify({
      jvm:'Temurin 25.0.5+8',capturedBytes:saved.bytes,objects:analysis.metrics.objects,reachable:analysis.metrics.reachable,
      unresolved:analysis.metrics.unresolvedReferences,nonStrong:analysis.metrics.excludedNonStrongReferences,
      ownerRetainedObjects:proof.retainedObjects,ownerRetainedPayloadBytes:proof.retainedPayloadBytes,
      root:proof.root,path:proof.path.map(step=>[step.via,step.object.type]),
      dominator:proof.dominator.type,sharedExcluded:true,inheritedEdge:true,malformedRefused:true,cancelled:true
    },null,2)+'\n');
  }finally{await fixture.close();}
});
