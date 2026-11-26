'use strict';

const assert = require('node:assert/strict');
const { realpathSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { startGroovyConsole,verifiedGroovyJar } = require('../src/java/groovy-console');
const { collectProjects,packageName } = require('../src/java/workbench-model');
const { BuildTasks } = require('../src/java/workbench-tasks');
const { createGroovyFixture,scripts } = require('./helpers/groovy-fixture');
const { createGroovyApplicationDebugger } = require('../src/java/groovy-debug-vscode');

const configuration = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const runtime = {skip:!configuration && 'Independent JDK and Gradle are not configured.',timeout:180000};
const run = promisify(execFile);
const temporary = async () => fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-groovy-check-'));

test('Groovy worker is bundled from owned source and refuses untrusted or unpinned execution',async t => {
  const root = await temporary();
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  assert.equal(require('../src/java/groovy-console-source.json'),
    await fs.readFile(path.resolve(__dirname,'../runtime/groovy/GroovyConsoleWorker.java'),'utf8'));
  await assert.rejects(startGroovyConsole({workspaceTrusted:false}),/Trust the workspace/);
  await fs.writeFile(path.join(root,'malformed.jar'),Buffer.alloc(7712577));
  await assert.rejects(verifiedGroovyJar({groovyJar:path.join(root,'malformed.jar')}),/does not match the pinned/);
});

test('Gradle workbench shows Java and Groovy sources admitted by joint source roots',async t => {
  assert.equal(packageName('package groovyfixture\nclass Demo {}','groovy'),'groovyfixture');
  const root = await temporary();
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const fixture = await createGroovyFixture(root), uri = pathToFileURL(fixture).href;
  const model = await collectProjects({folders:[uri],request:async command =>
    command === 'java.project.getAll' ? [uri] : command === 'java.project.getSettings' ?
      {'org.eclipse.jdt.ls.core.sourcePaths':[]} : {classpaths:[],modulepaths:[]}});
  assert.deepEqual(model.projects[0].languages,['groovy','java']);
  const files = model.projects[0].sourceRoots.flatMap(source => source.packages.flatMap(pkg => pkg.files));
  assert.deepEqual(files.map(file => file.name).sort(),['BadgeSpec.groovy','GroovyBadge.groovy','JavaEntry.java']);
});

test('Groovy application debug resolves a lower-case VS Code drive through the physical Gradle project', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = await temporary();
  t.after(async () => {
    assert.equal(path.relative(await fs.realpath(os.tmpdir()), path.dirname(root)), '');
    assert.match(path.basename(root), /^rb-groovy-check-/u);
    await fs.rm(root, { recursive: true, force: true });
  });
  const fixture = realpathSync.native(await createGroovyFixture(root));
  const source = path.join(fixture, 'src/main/groovy/groovyfixture/GroovyBadge.groovy');
  const editorPath = source.replace(/^[A-Z]:/u, drive => drive.toLowerCase());
  assert.notEqual(source, editorPath);
  let contents = await fs.readFile(source, 'utf8');
  const document = { languageId: 'groovy', uri: { scheme: 'file', fsPath: editorPath }, version: 1, getText: () => contents };
  const project = { id: 'fixture', name: 'fixture', tool: 'gradle', uri: pathToFileURL(fixture).href, root: fixture };
  const vscode = { workspace: { workspaceFolders: [pathToFileURL(fixture).href], textDocuments: [document] } };
  const java = { workbench: { getSnapshot: () => ({ projects: [project] }) } };
  const service = createGroovyApplicationDebugger(vscode, java, { projects: async () => [project], configuration: () => ({}), trusted() {} });
  const prepared = await service.prepare({ document });
  assert.equal(prepared.projectUri, project.uri);
  assert.equal(prepared.source, path.relative(fixture, source));
  assert.equal(prepared.task, ':run');
  contents += '\n// changed editor copy';
  await assert.rejects(service.prepare({ document }), /editor no longer matches/u);
});

test('real pinned Groovy persists console bindings, evaluates dynamic code, reports errors and limits output',runtime,async t => {
  const {javaHome,gradleHome}=JSON.parse(await fs.readFile(configuration,'utf8'));
  const root=await temporary(), fixture=await createGroovyFixture(root);
  t.after(() => fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150}));
  const options={workspacePath:fixture,javaHome,gradleHome,workspaceTrusted:true};
  const first=await startGroovyConsole(options);
  const firstWorker=path.dirname(first.child.spawnargs.at(-1));
  try {
    assert.equal(path.dirname(firstWorker),await fs.realpath(os.tmpdir()));
    assert.match(path.basename(firstWorker),/^groovy-console-/);
    const result=await first.evaluate("word = 'rocket'; word");
    assert.equal(result.value,'rocket');
    const dynamic=await first.evaluate("map = [name: word, points: [1, 2, 3]]; map.name.toUpperCase() + ':' + map.points.sum()");
    assert.equal(dynamic.value,'ROCKET:6');
    const syntax=await first.evaluate('def one = 1\nint result = )\n','Syntax.groovy');
    assert.equal(syntax.state,'error');
    assert.equal(syntax.line,2);
    assert.ok(syntax.column > 0);
    assert.match(syntax.error,/Unexpected input/);
    const missing=await first.evaluate('word.fictitiousMethod()');
    assert.equal(missing.state,'error');
    assert.match(missing.error,/MissingMethodException/);
    const limit=await first.evaluate("println 'a'.repeat(70000); 8");
    assert.equal(limit.truncated,true);
    assert.equal(limit.stdout.length,32768);
    assert.equal(limit.value,'8');
    const script=await fs.readFile(path.join(fixture,scripts.script),'utf8');
    const run=await first.evaluate(script,'score.groovy');
    assert.match(run.stdout,/score=20/);
    assert.equal(run.value,'20');
  } finally { await first.dispose(); }
  await assert.rejects(fs.stat(firstWorker),{code:'ENOENT'});
  const next=await startGroovyConsole(options);
  const nextWorker=path.dirname(next.child.spawnargs.at(-1));
  try {
    const reset=await next.evaluate('word');
    assert.equal(reset.state,'error');
    assert.match(reset.error,/MissingPropertyException/);
    let cancel;
    const evaluation=next.evaluate('Thread.sleep(30000); 6','Long.groovy',{cancellation:{
      onCancellationRequested(callback) { cancel=callback; return {dispose(){}}; }
    }});
    await Promise.resolve();
    cancel();
    await assert.rejects(evaluation,/cancelled/);
  } finally { await next.dispose(); }
  await assert.rejects(fs.stat(nextWorker),{code:'ENOENT'});
});

test('real Gradle joint compilation and Spock execute three dynamic and Java/Groovy cases',runtime,async t => {
  const {javaHome,gradleHome}=JSON.parse(await fs.readFile(configuration,'utf8'));
  const root=await temporary(), fixture=await createGroovyFixture(root), uri=pathToFileURL(fixture).href;
  const gradleHomePath=path.join(root,'gradle-home'), logs=new Map();
  t.after(() => fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250}));
  const project=(await collectProjects({folders:[uri],request:async command =>
    command === 'java.project.getAll' ? [uri] : command === 'java.project.getSettings' ?
      {'org.eclipse.jdt.ls.core.sourcePaths':[]} : {classpaths:[],modulepaths:[]}})).projects[0];
  const tasks=new BuildTasks({storagePath:path.join(root,'storage'),tools:() => ({javaHome,gradleHome}),runner:{
    async execute(spec) {
      const result=await run(spec.command,spec.args,{cwd:spec.cwd,windowsHide:true,timeout:120000,
        env:{...spec.env,GRADLE_USER_HOME:gradleHomePath}});
      logs.set(spec.label,result.stdout);
      return {code:0,terminationConfirmed:true};
    }
  }});
  const list=await tasks.discover(project,{allowProjectExecution:true});
  for (const goal of ['test','run']) {
    const task=list.find(item => [goal,':'+goal].includes(item.name));
    assert.ok(task);
    const result=await tasks.run(project,task.id,{allowProjectExecution:true});
    assert.equal(result.state,'succeeded');
    if (goal === 'run') assert.match(logs.get(project.name+' · '+task.name),/NEO:6/);
  }
  const xml=await fs.readFile(path.join(fixture,scripts.tests),'utf8');
  assert.match(xml,/tests="3".*skipped="0".*failures="0".*errors="0"/);
  assert.match(xml,/dynamic values preserve the actual Groovy method dispatch/);
  if (process.env.ROCKETBRAIN_GROOVY_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_GROOVY_RECEIPT,
    JSON.stringify({groovy:'4.0.28',spock:'2.4-groovy-4.0',jointCompilation:true,testCases:3,application:'NEO:6'},null,2)+'\n');
});
