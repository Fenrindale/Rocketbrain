'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { kotlinNativeElf, reviewKotlinNativeLaunch } = require('../src/java/kmp-native-review');
const { parseMi, quote } = require('../src/java/kmp-native-gdb');
const { createKotlinNativeDebugAdapter } = require('../src/java/kmp-native-debug-adapter');
const { registerKotlinNativeDebug } = require('../src/java/kmp-native-debug-vscode');
const { until } = require('./helpers/stdio-lsp');

function session(review, openGdb) {
  const messages = [];
  let sequence = 0;
  const adapter = createKotlinNativeDebugAdapter({ review, openGdb, send: item => messages.push(item) });
  async function rpc(command, args) {
    const seq = ++sequence;
    await adapter.handleMessage({ type: 'request', seq, command, arguments: args });
    const result = messages.find(item => item.type === 'response' && item.request_seq === seq);
    assert.ok(result);
    if (!result.success) throw Error(result.message);
    return result.body;
  }
  const event = (name, offset = 0) => until(() => messages.slice(offset).find(item => item.event === name)?.body ||
    (messages.slice(offset).some(item => item.event === name) && {}), 20000);
  return { rpc, event, messages, dispose: () => adapter.dispose() };
}

test('GDB/MI recognizes structured results and bounded literals', () => {
  const parsed = parseMi('15^done,bkpt={number="1",fullname="/tmp/\\355\\225\\234.kt",line="19"},variables=[{name="total",type="int",value="42"}]');
  assert.deepEqual([parsed.token, parsed.kind, parsed.name, parsed.payload.bkpt.fullname], [15, '^', 'done', '/tmp/한.kt']);
  assert.equal(parsed.payload.variables[0].value, '42');
  assert.equal(parseMi('~"GNU gdb 15\\n"'), undefined);
  assert.throws(() => parseMi('77^done,line="2",line="3"'), /invalid MI record/u);
  assert.throws(() => parseMi('*stopped,frame={"inside"}'), /invalid MI record/u);
  assert.throws(() => parseMi('12^done,' + 'x'.repeat(262144)), /record limit/u);
  assert.equal(quote('/tmp/A "quote".kt'), '"/tmp/A \\"quote\\".kt"');
  assert.throws(() => quote('invalid\n-command'), /bounded literal/u);
});

test('ELF envelope requires Linux x64 and both embedded DWARF sections', () => {
  const image = Buffer.alloc(512);
  image.writeUInt32BE(0x7f454c46, 0);
  image[4] = 2; image[5] = 1; image[6] = 1;
  image.writeUInt16LE(3, 16); image.writeUInt16LE(62, 18); image.writeUInt32LE(1, 20);
  image.writeBigUInt64LE(64n, 40);
  image.writeUInt16LE(64, 58); image.writeUInt16LE(4, 60); image.writeUInt16LE(1, 62);
  const names = Buffer.from('\0.shstrtab\0.debug_info\0.debug_line\0','ascii');
  names.copy(image, 320);
  const section = (index, nameAt, offset, length) => {
    const start = 64 + index * 64;
    image.writeUInt32LE(nameAt, start);
    image.writeBigUInt64LE(BigInt(offset), start + 24);
    image.writeBigUInt64LE(BigInt(length), start + 32);
  };
  section(1, 1, 320, names.length);
  section(2, 11, 390, 10);
  section(3, 23, 420, 10);
  assert.doesNotThrow(() => kotlinNativeElf(image));
  image.writeUInt16LE(183,18);
  assert.throws(() => kotlinNativeElf(image), /Linux x64 ELF/u);
  image.writeUInt16LE(62,18);
  section(3, 23, 420, 0);
  assert.throws(() => kotlinNativeElf(image), /DWARF/u);
});

test('Kotlin Native adapter gates source, steps, locals and stale handles', async () => {
  const source = path.resolve('Main.kt'), events = new EventEmitter(), requests = [];
  let cleanup = 0, stale = false, observed = 0;
  const review = { source, validate() { if (stale) throw Error('review changed'); } };
  const mock = { events, async initialize() {}, async stop() { cleanup++; }, validateInferior() { observed++; },
    async request(command) {
      requests.push(command);
      if (command.endsWith('--line 15')) return { name: 'done', payload: { bkpt: { number: '1', addr: '0x111', fullname: source, line: '15' } } };
      if (command.endsWith('--line 19')) return { name: 'done', payload: { bkpt: { number: '2', addr: '<MULTIPLE>', fullname: source, line: '19' } } };
      if (command.startsWith('-stack-list-variables')) return { name: 'done', payload: { variables: [
        { name: 'total', type: 'int', value: '41' },
        { name: 'notObservedAsScalar', type: 'pointer', value: '0x100' }
      ] } };
      return { name: command.startsWith('-exec') ? 'running' : 'done' };
    } };
  const dap = session(review, () => mock);
  await dap.rpc('initialize');
  await dap.rpc('launch');
  const bp = await dap.rpc('setBreakpoints', { source: { path: source }, breakpoints: [
    { line: 15 }, { line: 15, condition: 'anything' }, { line: 19 }
  ] });
  assert.deepEqual(bp.breakpoints.map(item => item.verified), [true,false,false]);
  assert.ok(requests.includes('-break-delete 2'));
  assert.deepEqual((await dap.rpc('setBreakpoints', { source: { path: source + '.other' }, breakpoints: [{ line: 15 }] })).breakpoints[0].verified,false);
  await dap.rpc('configurationDone');
  events.emit('stopped', { reason:'breakpoint-hit', bkptno:'1', 'thread-id':'1', frame:{ fullname:source, line:'15', func:'kfun:main' } });
  const { threadId } = await dap.event('stopped');
  const [frame] = (await dap.rpc('stackTrace', { threadId })).stackFrames;
  const [scope] = (await dap.rpc('scopes', { frameId: frame.id })).scopes;
  const locals = await dap.rpc('variables', { variablesReference:scope.variablesReference });
  assert.deepEqual(locals.variables,[{name:'total',value:'41',type:'int',variablesReference:0}]);
  await assert.rejects(dap.rpc('evaluate', { expression:'total' }), /unavailable/u);
  await dap.rpc('next',{ threadId });
  await assert.rejects(dap.rpc('variables', { variablesReference:scope.variablesReference }), /current stopped/u);
  events.emit('stopped', { reason:'end-stepping-range', 'thread-id':'1', frame:{ fullname:source, line:'16' } });
  stale = true;
  await assert.rejects(dap.rpc('stackTrace',{ threadId }), /review changed/u);
  await dap.dispose();
  assert.equal(cleanup,1);
  assert.ok(observed>=3);
});

test('Kotlin Native does not admit an unreviewed launch or attach configuration', async () => {
  let factory;
  const disposable=()=>({dispose(){}});
  const service=registerKotlinNativeDebug({
    debug:{ registerDebugAdapterDescriptorFactory(_type, value) { factory=value; return disposable(); },
      onDidTerminateDebugSession:disposable }, commands:{ registerCommand:disposable }
  });
  for(const request of ['launch','attach']) assert.throws(()=>factory.createDebugAdapterDescriptor({
    type:'rocketbrain-kotlin-native', configuration:{request,program:'/tmp/unreviewed.kexe'}
  }), /reviewed Rocketbrain command/u);
  await service.dispose();
});

test('real Kotlin Native Linux x64 GDB source step resumes both Spring JDBC HTTP readbacks', {
  skip: process.env.ROCKETBRAIN_KOTLIN_NATIVE_LINUX_TEST !== '1' && 'Run the owned Linux x64 Kotlin/Native and Spring fixtures.',
  timeout: 180000
}, async t => {
  const { readProbe, startSpring, sha256, assertNoCredential } = require('./quarkus-native-linux.cjs');
  const workspace = await fs.realpath(path.resolve('test/fixtures/java/kmp-native-linux'));
  const springRoot = await fs.realpath(path.resolve('test/fixtures/java/quarkus-native-linux/spring'));
  const springJar = path.join(springRoot,'target/spring-native-comparison-1.0.0.jar');
  const program = path.join(workspace,'build/bin/linuxX64/debugExecutable/rocketbrainNativeDebug.kexe');
  const source = path.join(workspace,'src/linuxX64Main/kotlin/nativefixture/Main.kt');
  const original = await fs.readFile(source);
  const lines = original.toString('utf8').split('\n');
  const line = marker => lines.findIndex(row=>row.includes(marker))+1;
  const dbPassword = process.env.RB_NATIVE_DB_PASSWORD, user = process.env.RB_NATIVE_DB_USER;
  assert.equal(user,'rb_native');
  assert.ok(typeof dbPassword==='string' && dbPassword.length>=16);
  const owned = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-kotlin-native-gdb-'));
  t.after(async () => {
    const physical = await fs.realpath(owned);
    assert.equal(physical,owned);
    assert.match(path.basename(physical),/^rb-kotlin-native-gdb-/u);
    await fs.rm(physical,{recursive:true,force:true});
  });
  assert.equal(process.platform,'linux');
  Object.assign(process.env,{RB_NATIVE_MYSQL_URL:'jdbc:mysql://127.0.0.1:43306/rocketbrain_native?allowPublicKeyRetrieval=true&sslMode=DISABLED',
    RB_NATIVE_MARIADB_URL:'jdbc:mariadb://127.0.0.1:43307/rocketbrain_native?sslMode=disable'});
  const spring = await startSpring(path.join(process.env.JAVA_HOME,'bin/java'),springJar,springRoot);
  for (const key of ['RB_NATIVE_DB_PASSWORD','RB_NATIVE_DB_USER','RB_NATIVE_MYSQL_URL','RB_NATIVE_MARIADB_URL']) delete process.env[key];
  const findings = {};
  let exactArtifact;
  try {
    for(const engine of ['mysql','mariadb']) {
      const seeded = await readProbe(spring.baseUrl,engine);
      const resultFile = path.join(owned,engine+'.txt');
      const port = new URL(spring.baseUrl).port, baseline = path.join(owned,engine+'-baseline.txt');
      const rawOutput = execFileSync(program,[port,engine,baseline],{encoding:'utf8',timeout:8000});
      assert.match(rawOutput,/\*stopped,reason="exited-normally"/u);
      const expected = '42|spring|2|42|'+seeded.version;
      assert.equal((await fs.readFile(baseline,'utf8')).trim(),expected);
      const reviewed = reviewKotlinNativeLaunch({workspace,program,source,args:[port,engine,resultFile]});
      exactArtifact = reviewed;
      assert.equal(await sha256(program),reviewed.artifactSha256);
      assert.equal(await sha256(source),reviewed.sourceSha256);
      let inferior;
      const dap = session({...reviewed,validateInferior(pid){reviewed.validateInferior(pid);inferior=pid;}});
      try {
        await dap.rpc('initialize');
        await dap.rpc('launch');
        const foreign = await dap.rpc('setBreakpoints',{source:{path:path.join(workspace,'other','Main.kt')},breakpoints:[{line:line('BREAK_ON_UPDATE')}]});
        assert.equal(foreign.breakpoints[0].verified,false);
        const bp = await dap.rpc('setBreakpoints',{source:{path:source},breakpoints:[{line:line('BREAK_ON_UPDATE')},{line:9000}]});
        assert.deepEqual(bp.breakpoints.map(row=>row.verified),[true,false]);
        await dap.rpc('configurationDone');
        const stopped=await dap.event('stopped');
        assert.equal(stopped.reason,'breakpoint',JSON.stringify(stopped));
        async function localAt(entry,expectedLine,value) {
          const [frame]=(await dap.rpc('stackTrace',{threadId:entry.threadId})).stackFrames;
          assert.deepEqual([frame.source.path,frame.line],[source,expectedLine]);
          const [scope]=(await dap.rpc('scopes',{frameId:frame.id})).scopes;
          const {variables}=await dap.rpc('variables',{variablesReference:scope.variablesReference});
          assert.ok(variables.some(item=>item.name==='total'&&item.value===String(value)),JSON.stringify(variables));
          return scope;
        }
        const scope=await localAt(stopped,line('BREAK_ON_UPDATE'),41);
        const after=dap.messages.length;
        await dap.rpc('next',{threadId:stopped.threadId});
        const stepped=await dap.event('stopped',after);
        assert.equal(stepped.reason,'step',JSON.stringify(stepped));
        await localAt(stepped,line('STEP_TO_HTTP'),42);
        await assert.rejects(dap.rpc('variables',{variablesReference:scope.variablesReference}),/current stopped/u);
        await assert.rejects(dap.rpc('evaluate',{expression:'total'}),/unavailable/u);
        const resume=dap.messages.length;
        await dap.rpc('continue',{threadId:stepped.threadId});
        assert.deepEqual(await dap.event('exited',resume),{exitCode:0});
        await dap.event('terminated',resume);
        assert.ok(inferior>0);
        await dap.dispose();
        await assert.rejects(fs.access('/proc/'+inferior+'/exe'),{code:'ENOENT'});
        const native=(await fs.readFile(resultFile,'utf8')).trim();
        assert.equal(native,expected);
        assert.ok(!native.includes(dbPassword));
        findings[engine]={...seeded,breakpointLine:line('BREAK_ON_UPDATE'),nextLine:line('STEP_TO_HTTP'),
          localBefore:41,localAfter:42,exactInferior:true,nativeHttpReadback:true,plainNativeBaseline:true,staleHandleRefused:true,
          foreignSourceRefused:true,invalidLineRefused:true,ownedProcessClosed:true};
      } finally { await dap.dispose(); }
    }
    let interruptedPid;
    const interrupted = session({...exactArtifact,
      validateInferior(pid) { exactArtifact.validateInferior(pid); interruptedPid=pid; }
    });
    try {
      await interrupted.rpc('initialize');
      await interrupted.rpc('launch');
      const installed=await interrupted.rpc('setBreakpoints',{source:{path:source},breakpoints:[{line:line('BREAK_ON_UPDATE')}]});
      assert.equal(installed.breakpoints[0].verified,true);
      await interrupted.rpc('configurationDone');
      assert.equal((await interrupted.event('stopped')).reason,'breakpoint');
      await interrupted.rpc('disconnect');
      assert.ok(interruptedPid>0);
      await assert.rejects(fs.access('/proc/'+interruptedPid+'/exe'),{code:'ENOENT'});
    } finally { await interrupted.dispose(); }
    try {
      await fs.appendFile(source,'\n// Mutated after review by the owned fixture.\n');
      assert.throws(()=>exactArtifact.validate(true),/changed/u);
    } finally { await fs.writeFile(source,original); }
    await assertNoCredential(program,dbPassword);
    const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    if(process.env.GITHUB_SHA)assert.equal(commit,process.env.GITHUB_SHA);
    const verdict={commit,platform:'linux',architecture:'x64',kotlin:'2.4.21',gradle:'9.1.0',
      gdb:execFileSync('/usr/bin/gdb',['--version'],{encoding:'utf8'}).split('\n')[0],
      artifactSha256:exactArtifact.artifactSha256,sourceSha256:exactArtifact.sourceSha256,
      springSha256:await sha256(springJar),localLaunch:true,stdioIsolatedFromMi:true,staleSourceRefused:true,stoppedMidRun:true,
      realDapAdapter:true,nativeVsCodeLaunched:false,findings};
    await fs.writeFile(process.env.ROCKETBRAIN_KOTLIN_NATIVE_RECEIPT,JSON.stringify(verdict,null,2)+'\n',{flag:'wx'});
  } finally { await spring.stop(); }
});
