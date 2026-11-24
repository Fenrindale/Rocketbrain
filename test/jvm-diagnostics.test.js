'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { createJvmDiagnostics } = require('../src/java/jvm-diagnostics');
const { parseJvmList,summarizeProfile,parseThreadSnapshot,parseThreadLocks,parseHeapHistogram } = require('../src/java/jvm-diagnostics-model');

test('local JVM discovery strips all launch arguments and ignores its own jcmd process', () => {
  const rows = parseJvmList('31 org.example.Work -Dexample=private-token\n20 sun.tools.jcmd.JCmd -l\n' +
    '22 C:\\app\\demo.jar --secret=private-token\n41 --token=aValue\n15\n');
  assert.deepEqual(rows,[
    {pid:15,label:''},{pid:22,label:'demo.jar'},{pid:31,label:'org.example.Work'},{pid:41,label:''}
  ]);
  assert.equal(JSON.stringify(rows).includes('private-token'),false);
});

test('profile uses distinct CPU samples and weighted allocations while identifying inclusive and self callers', () => {
  const sample = (type, values) => ({ type,values });
  const frame = (type,name,lineNumber) => ({ method:{type:{name:type},name,descriptor:'()V'},lineNumber });
  const data = { recording:{ omittedEvents:3,events:[
    sample('jdk.ExecutionSample',{startTime:'2026-11-24T01:00:00Z',stackTrace:{frames:[
      frame('sample/Task','poll',10),frame('sample/Task','loop',8),frame('sample/Task','loop',7)
    ]}}),
    sample('jdk.ObjectAllocationSample',{ startTime:'2026-11-24T01:00:01Z',weight:512,objectClass:{name:'[B'},
      stackTrace:{frames:[frame('sample/Task','allocate',11)]} }),
    sample('jdk.InitialSystemProperty',{ secret:'never surfaced' })
  ] } };
  const report = summarizeProfile(JSON.stringify(data));
  assert.equal(report.cpuSamples,1);
  assert.equal(report.allocationSamples,1);
  assert.equal(report.omittedEvents,3);
  assert.equal(report.estimatedAllocationBytes,512);
  assert.equal(report.observedSampleWindowMs,1000);
  assert.equal(report.cpuMethods.find(item => item.method === 'loop').cpu,1);
  assert.equal(report.cpuMethods.find(item => item.method === 'poll').selfCpu,1);
  assert.equal(report.allocationTypes[0].type,'[B');
  assert.equal(JSON.stringify(report).includes('never surfaced'),false);
});

test('thread readers keep inferred monitor cycles separate from JVM-confirmed deadlocks', () => {
  const threads = [
    { tid:10,name:'left',state:'BLOCKED',blockedOn:'monitor:B',monitorsOwned:[{locks:['monitor:A']}] },
    { tid:11,name:'right',state:'BLOCKED',blockedOn:'monitor:A',monitorsOwned:[{locks:['monitor:B']}] },
    { tid:12,name:'virtual',virtual:true,state:'WAITING',stack:['example.Wait.run(Wait.java:20)'] }
  ];
  const snapshot = parseThreadSnapshot(JSON.stringify({threadDump:{threadContainers:[{container:'root',threads}]}}));
  assert.deepEqual([snapshot.platformThreads,snapshot.virtualThreads],[2,1]);
  assert.deepEqual(snapshot.monitorCycles,[['10','11']]);
  threads.push({tid:13,monitorsOwned:[{locks:['monitor:A']}]});
  assert.deepEqual(parseThreadSnapshot(JSON.stringify({threadDump:{threadContainers:[{threads}]}})).monitorCycles,[]);
  const locks = parseThreadLocks('"left" #10 daemon\n   java.lang.Thread.State: BLOCKED\n\t- locked <0xa>\n' +
    '\t- waiting to lock <0xb>\n\n   Locked ownable synchronizers:\n\t- <0xc>\n' +
    'Found one Java-level deadlock:\n"left":\n  which is held by "right"\nFound 1 deadlock.\n');
  assert.deepEqual(locks.threads[0].locks,['0xa']);
  assert.deepEqual(locks.threads[0].awaiting,['0xb']);
  assert.deepEqual(locks.threads[0].synchronizers,['0xc']);
  assert.equal(locks.jvmDeadlocks,1);
  assert.deepEqual(locks.waitEdges,[{thread:'left',heldBy:'right'}]);
  assert.deepEqual(parseHeapHistogram('  1:  22  444 java.lang.String (java.base@25)\nTotal    22  444\n').total,
    {instances:22,bytes:444});
});

function javaTool(javaHome,name) {
  return path.join(javaHome,'bin',name + (process.platform === 'win32' ? '.exe' : ''));
}

async function readiness(child) {
  return new Promise((resolve,reject) => {
    let seen = '';
    const timer = setTimeout(() => finish(Error('Owned JVM did not reach readiness.')),15000);
    function finish(error) {
      clearTimeout(timer);
      child.removeListener('error',finish);
      child.removeListener('exit',exit);
      child.stdout.removeListener('data',read);
      if (error) reject(error); else resolve();
    }
    function exit() { finish(Error('The owned JVM exited before readiness.')); }
    function read(buffer) {
      seen = (seen + buffer.toString('utf8')).slice(-4096);
      if (/\bREADY\b/.test(seen)) finish();
    }
    child.stdout.on('data',read);
    child.once('error',finish);
    child.once('exit',exit);
  });
}

async function closeFixture(child, exit) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end('\n');
  const timeout = setTimeout(() => child.kill('SIGKILL'),3000);
  try { await exit; } finally { clearTimeout(timeout); }
}

test('owned JDK captures and reopens samples, platform/virtual locks, heap classes and cancels only its recording',
  { skip:!process.env.ROCKETBRAIN_JAVA_TEST_CONFIG && 'Independent Java test runtime is not configured.',timeout:100000 }, async () => {
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-diagnostic-proof-'));
    const base = process.env.ROCKETBRAIN_JFR_TEST_REPOSITORY ||
      (process.platform === 'win32' && !/^[\x20-\x7e]+$/.test(dir) ? 'C:/Temp' : dir);
    const repository = await fs.mkdtemp(path.join(await fs.realpath(base),'rb-jfr-'));
    const files = ['capture.jfr','threads.json','locks.txt','cancelled.jfr','companion.jfr'].map(name => path.join(dir,name));
    const storagePath = path.join(dir,'storage');
    const child = spawn(javaTool(runtime.javaHome,'java'),[
      '-Xmx128m','-Dexample=RB_FIXTURE_VALUE_FOR_EXCLUSION_ONLY',
      '-XX:FlightRecorderOptions=repository=' + repository,'--source','25',
      path.resolve(__dirname,'fixtures/jvm-diagnostics/DiagnosticsFixture.java')
    ],{cwd:dir,windowsHide:true,stdio:['pipe','pipe','ignore']});
    const exit = new Promise(resolve => { child.once('exit',resolve); child.once('error',resolve); });
    try {
      await readiness(child);
      const tool = createJvmDiagnostics({ javaHome:runtime.javaHome,storagePath });
      const processes = await tool.list();
      assert.ok(processes.some(process => process.pid === child.pid));
      assert.equal(JSON.stringify(processes).includes('RB_FIXTURE_VALUE'),false);
      const target = await tool.select(child.pid);
      await assert.rejects(tool.histogram({ ...target,pid:child.pid + 1 }),/Select the local JVM again/);
      const threads = await tool.captureThreads(target,{ output:files[1] });
      assert.ok(threads.snapshot.threads.some(thread => thread.virtual && thread.name === 'rb-diagnostics-virtual'));
      assert.ok(threads.snapshot.monitorCycles.some(cycle => cycle.length === 2));
      assert.equal(threads.locks.jvmDeadlocks,1);
      assert.equal(threads.locks.waitEdges.length,2);
      assert.deepEqual((await tool.inspectThreads(files[1])).snapshot,threads.snapshot);
      await tool.captureThreads(target,{ output:files[2],format:'locks' });
      assert.equal((await tool.inspectThreads(files[2])).locks.jvmDeadlocks,1);
      const histogram = await tool.histogram(target);
      assert.ok(histogram.rows.some(row => row.type === 'DiagnosticsFixture$Allocation'));
      assert.ok(histogram.total.bytes > 0);
      const recording = await tool.profile(target,{seconds:3,output:files[0]});
      assert.ok(recording.summary.cpuSamples > 0);
      assert.ok(recording.summary.allocationSamples > 0);
      assert.ok(recording.summary.cpuMethods.some(row => row.type === 'DiagnosticsFixture' && row.method === 'allocateAndCompute'));
      assert.ok(recording.summary.estimatedAllocationBytes > 0);
      assert.equal(recording.summary.omittedEvents,0);
      assert.deepEqual(await tool.inspectJfr(files[0]),recording.summary);
      await assert.rejects(tool.profile(target,{seconds:3,output:files[0]}),/already exists/);
      const { stdout:summary } = await exec(javaTool(runtime.javaHome,'jfr'),['summary',files[0]],
        {cwd:dir,windowsHide:true,timeout:12000});
      for (const event of ['InitialEnvironmentVariable','InitialSystemProperty','JVMInformation']) {
        assert.match(summary,new RegExp('jdk\\.' + event + '\\s+0\\s+0'));
      }
      const jcmd = async (...args) => (await exec(javaTool(runtime.javaHome,'jcmd'),[String(child.pid),...args],
        {cwd:dir,windowsHide:true,timeout:8000})).stdout;
      assert.match(await jcmd('JFR.start','name=rb_other_recording','settings=none','duration=30s','disk=true',
        'dumponexit=false','filename="' + files[4] + '"'),
        /Started recording/);
      const abort = new AbortController();
      const inFlight = tool.profile(target,{seconds:12,output:files[3],signal:abort.signal});
      void inFlight.catch(() => {});
      let running = false;
      for (let index = 0; index < 10 && !running; index++) {
        running = (await jcmd('JFR.check')).includes('rocketbrain_');
        if (!running) await new Promise(resolve => setTimeout(resolve,250));
      }
      assert.equal(running,true);
      abort.abort();
      await assert.rejects(inFlight,/cancelled/);
      const active = await jcmd('JFR.check');
      assert.doesNotMatch(active,/rocketbrain_/);
      assert.match(active,/rb_other_recording/);
      await jcmd('JFR.stop','name=rb_other_recording');
      await assert.rejects(fs.stat(files[3]),{code:'ENOENT'});
      assert.deepEqual(await fs.readdir(storagePath),[]);
      await closeFixture(child,exit);
      await assert.rejects(tool.histogram(target),/JVM|selection/);
    } finally {
      await closeFixture(child,exit);
      for (const file of files) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(storagePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(repository);
      await fs.rmdir(dir);
    }
  });
