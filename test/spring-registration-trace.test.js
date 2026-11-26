'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parseRegistrationTrace, readRegistrationTrace } = require('../src/spring/registration-trace');
const { execute } = require('../src/java/testing/provision');
const { jdbcOptions } = require('./helpers/virtual-async-trace-fixture');
const root = path.resolve(__dirname, '..');
const probe = path.join(__dirname, 'fixtures/java/spring-registration-trace/src/main/java/registry/RegistryProbe.java');
const helper = path.join(root, 'runtime/spring-registration/src/rocketbrain/spring/RegistrationTrace.java');
const input = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_REGISTRY_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine =>
  [engine, process.env['ROCKETBRAIN_REGISTRY_' + engine.toUpperCase() + '_CONFIG']]);
const jsonl = (...rows) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('Spring registry traces preserve successful events and distinguish incomplete callbacks', () => {
  const header = { kind:'spring-registration', version:1 };
  const begin = { kind:'begin', id:1, label:'registrar' };
  const mutation = { kind:'mutation', id:1, operation:'register', name:'배송', origin:{ type:'impl.Registrar',
    method:'register', file:'Registrar.java', line:13 } };
  const end = { kind:'end', id:1, outcome:'returned' };
  const report = parseRegistrationTrace(jsonl(header, begin, mutation, end));
  assert.deepEqual(report.scopes, [{ id:1, label:'registrar', outcome:'returned', mutationCount:1 }]);
  assert.equal(report.mutations[0].name, '배송');
  const live = parseRegistrationTrace(jsonl(header, begin, mutation) + '{"kind":"');
  assert.equal(live.scopes[0].outcome, 'open');
  assert.equal(live.pendingLine, true);
  assert.throws(() => parseRegistrationTrace(jsonl(header, mutation)), /invalid record/u);
  assert.throws(() => parseRegistrationTrace(jsonl(header, begin, end, mutation)), /invalid record/u);
  assert.throws(() => parseRegistrationTrace(jsonl(header, begin, { ...mutation, operation:'alias' })), /invalid record/u);
  assert.throws(() => parseRegistrationTrace(jsonl(header, begin, { kind:'truncated' }, end)), /invalid record/u);
});

test('a real selected Spring registry callback preserves dynamic bean and JDBC behavior while recording its origins', {
  timeout:120000, skip:!(input && classpathFile && engines.every(([, file]) => file))
}, async test => {
  const runtime = JSON.parse(await fs.readFile(input, 'utf8'));
  const javaHome = runtime.javaHome || runtime.settings['rocketbrain.java.javaHome'];
  const exe = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const parent = await fs.realpath(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(parent, 'rb-spring-registry-'));
  const identity = await fs.lstat(scratch, { bigint:true });
  test.after(async () => {
    const resolved = await fs.realpath(scratch);
    const current = await fs.lstat(resolved, { bigint:true });
    assert.equal(path.relative(parent, path.dirname(resolved)), '');
    assert.equal(path.relative(scratch, resolved), '');
    assert.match(path.basename(resolved), /^rb-spring-registry-/u);
    assert.deepEqual([current.dev,current.ino], [identity.dev,identity.ino]);
    await fs.rm(resolved, { recursive:true, force:true, maxRetries:8, retryDelay:250 });
  });
  const output = path.join(scratch, 'classes');
  await fs.mkdir(output);
  const source = (await fs.readFile(probe, 'utf8')).split(/\r?\n/u);
  const originLine = source.findIndex(line => line.includes('REGISTRATION_ORIGIN')) + 1;
  const springContext = new Set(['spring-context-7.0.10.jar','spring-aop-7.0.10.jar','spring-expression-7.0.10.jar']);
  const contextClasspath = (await fs.readFile(classpathFile,'utf8')).trim().split(path.delimiter)
    .filter(file => springContext.has(path.basename(file)));
  assert.deepEqual(new Set(contextClasspath.map(file => path.basename(file))), springContext);
  const results = [];
  for (const [engine, configFile] of engines) {
    const { env, classpath } = await jdbcOptions({ engine, configFile, classpathFile });
    const cp = [...classpath, ...contextClasspath].join(path.delimiter);
    assert.ok(cp);
    if (!results.length) {
      const compiled = await execute(exe('javac'), ['-g', '-classpath', cp, '-d', output, helper, probe],
        { cwd:scratch, timeoutMs:30000 });
      assert.equal(compiled.code, 0, compiled.output);
    }
    const color = engine === 'mysql' ? 'Blue' : 'Green';
    const trace = path.join(scratch, engine + '.jsonl');
    const result = await execute(exe('java'), ['-classpath', output + path.delimiter + cp, 'registry.RegistryProbe', trace, color],
      { cwd:scratch, timeoutMs:25000, env:{ ...process.env, ...env } });
    assert.equal(result.code, 0, 'The real Spring registry probe did not finish successfully.');
    const receipt = /REGISTRY_JDBC:(Blue|Green)\|([^|\r\n]+)\|42\|1/u.exec(result.output);
    assert.equal(receipt?.[1], color);
    assert.match(receipt[2], engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*-MariaDB/u);
    const review = await readRegistrationTrace(trace);
    assert.deepEqual(review.scopes.map(row => [row.label,row.outcome,row.mutationCount]),
      [['dynamic registrar','returned',6],['failed registrar','threw',1]]);
    assert.deepEqual(review.mutations.map(row => [row.operation,row.name,row.alias]), [
      ['register','selected'+color,undefined], ['alias','selected'+color,'selected'],
      ['alias','selected'+color,'temporaryAlias'], ['unalias','temporaryAlias',undefined],
      ['register','unused',undefined], ['remove','unused',undefined], ['alias','selected','observedBeforeFailure']
    ]);
    assert.deepEqual(review.mutations[0].origin, { type:'registry.RegistryProbe', method:'dynamicRegister',
      file:'RegistryProbe.java', line:originLine });
    results.push({ engine, server:receipt[2], registeredBranch:color, jdbc:42, beanCreations:1,
      exactOriginChecked:true, aliasesAndRemovalPreserved:true, failurePropagated:true, report:review });
  }
  if (process.env.ROCKETBRAIN_REGISTRY_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_REGISTRY_RECEIPT,
    JSON.stringify({ results },null,2) + '\n', { flag:'wx' });
});
