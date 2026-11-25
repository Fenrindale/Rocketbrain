'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { decodeKmpModel,loadKmpModel } = require('../src/java/kmp-gradle');
const { kotlinDeclarations,definitionForKmp } = require('../src/java/kmp-sources');
const { runKmpTasks } = require('../src/java/kmp-workbench');

const fixture=path.join(__dirname,'fixtures','java','kotlin-multiplatform');
const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, gradleHome=process.env.ROCKETBRAIN_KMP_GRADLE_HOME;
const execute=promisify(execFile);

test('bounded Kotlin scalar declarations distinguish overloads and ignore nested or ambiguous forms',() => {
  const declarations=kotlinDeclarations('package p\r\nexpect fun match(x: String): Int\r\nexpect fun match(x: Int): Int\r\nexpect val answer: String\r\nclass Nested { actual fun deep(): Unit {} }\r\n');
  assert.deepEqual(declarations.map(item => item.kind),['fun','fun','val']);
  assert.notEqual(declarations[0].signature,declarations[1].signature);
  assert.equal(declarations[0].range.start.line,1);
  assert.deepEqual(kotlinDeclarations('package p\nimport example.Int\nactual fun f(): Int = 2'),[]);
  assert.deepEqual(kotlinDeclarations('package p\n/* outer /* inner */ actual fun bogus(): String */'),[]);
  assert.deepEqual(kotlinDeclarations('package p\nexpect fun f(x: List<Int>): String'),[]);
});

test('Gradle output model refuses external source sets and cross-module tasks',() => {
  const model={format:'RocketbrainKmpModel1',modules:[{path:':',directory:fixture,
    sourceSets:[{name:'commonMain',directories:[path.join(fixture,'src/commonMain/kotlin')],dependsOn:[]}],
    targets:[{name:'jvm',platform:'jvm',main:['commonMain'],compileTask:':compileKotlinJvm',testTask:':jvmTest',runTask:':jvmRun'}]}]};
  assert.equal(decodeKmpModel(fixture,model).modules[0].targets[0].compileTask,':compileKotlinJvm');
  const outside=structuredClone(model);
  outside.modules[0].sourceSets[0].directories=[path.dirname(fixture)];
  assert.throws(() => decodeKmpModel(fixture,outside),/outside the workspace/);
  const wrongScope=structuredClone(model);
  wrongScope.modules[0].targets[0].testTask=':different:jvmTest';
  assert.throws(() => decodeKmpModel(fixture,wrongScope),/different Gradle module/);
});

async function checkSuite(root,target) {
  const directory=path.join(root,'build/test-results',target);
  const files=(await fs.readdir(directory)).filter(name => /^TEST-(?:jsNodeTest\.)?kmpfixture\.PlatformTest\.xml$/.test(name));
  assert.equal(files.length,1,JSON.stringify(files));
  const report=await fs.readFile(path.join(directory,files[0]),'utf8');
  assert.match(report,/<testsuite [^>]*tests="2"/);
  assert.match(report,/<testsuite [^>]*errors="0"/);
  assert.match(report,/<testsuite [^>]*failures="0"/);
  return 2;
}

test('real Kotlin 2.4.21 Gradle model, JVM and JavaScript tasks, and scoped expect/actual navigation',{
  skip:!javaConfig || !gradleHome,timeout:480000
},async context => {
  const parent=await fs.realpath(os.tmpdir()), root=await fs.mkdtemp(path.join(parent,'rb-kmp-live-'));
  context.after(async () => {
    const owned=await fs.realpath(root);
    assert.equal(owned,root);
    assert.equal(path.dirname(owned),parent);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await fs.cp(fixture,root,{recursive:true});
  const config=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const tools={gradleHome,javaHome:config.gradleJavaHome || config.javaHome,
    gradleUserHome:process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME,nodeHome:process.env.ROCKETBRAIN_KMP_NODE_HOME};
  const logs=[];
  const runner={async execute(spec) {
    const result=await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:220000,maxBuffer:3*1024*1024});
    logs.push(result.stdout+result.stderr);
    return {code:0};
  }};
  const permit={workspaceTrusted:true,allowProjectExecution:true};
  await assert.rejects(loadKmpModel({root,tools,runner,workspaceTrusted:true}),/Explicitly inspect/);
  const model=await loadKmpModel({root,tools,runner,...permit});
  const [module]=model.modules, targetNames=['js','jvm'];
  assert.deepEqual(module.targets.map(target => [target.name,target.platform]),[['js','js'],['jvm','jvm']]);
  assert.ok(module.sourceSets.find(set => set.name==='jvmMain').dependsOn.includes('commonMain'));
  assert.ok(module.targets[0].main.includes('commonMain'));
  const operation={model,modulePath:module.path,targetNames,tools,runner,...permit};
  const compiled=await runKmpTasks({...operation,action:'compile'});
  assert.equal(compiled.result.state,'succeeded');
  assert.equal(compiled.result.linkedDeclarations,9);
  const expected=path.join(root,'src/commonMain/kotlin/kmpfixture/Platform.kt');
  const text=await fs.readFile(expected,'utf8');
  const position={line:3,character:12};
  const links=definitionForKmp(compiled.index,{file:expected,text:text.replace(/\r?\n/g,'\r\n'),position});
  assert.deepEqual(links.map(link => [link.sourceSet,link.range.start.line]),[['jsMain',3],['jvmMain',4]]);
  const property=definitionForKmp(compiled.index,{file:expected,text,position:{line:2,character:13}});
  assert.deepEqual(property.map(link => [link.name,link.sourceSet]),[['platformLabel','jsMain'],['platformLabel','jvmMain']]);
  const actual=fileURLToPath(links[1].uri), actualText=await fs.readFile(actual,'utf8');
  const reverse=definitionForKmp(compiled.index,{file:actual,text:actualText,position:{line:4,character:13}});
  assert.equal(fileURLToPath(reverse[0].uri),expected);
  assert.equal(reverse[0].range.start.line,3);
  await fs.appendFile(actual,'// changed after multiplatform compile\n');
  try {assert.throws(() => definitionForKmp(compiled.index,{file:expected,text,position}),/Inspect and build again/);}
  finally {await fs.writeFile(actual,actualText);}
  const tested=await runKmpTasks({...operation,action:'test'});
  assert.equal(tested.result.state,'succeeded');
  const tests={jvm:await checkSuite(root,'jvmTest'),js:await checkSuite(root,'jsNodeTest')};
  const runOutput={};
  for (const [target,platform] of [['jvm','JVM'],['js','JavaScript']]) {
    const ran=await runKmpTasks({...operation,targetNames:[target],action:'run'});
    assert.equal(ran.result.state,'succeeded');
    runOutput[target]='Rocketbrain KMP '+platform+' count=3 TEST';
    assert.ok(logs.at(-1).includes(runOutput[target]));
  }
  if (process.env.ROCKETBRAIN_KMP_RECEIPT) {
    const receipt={kotlin:'2.4.21',targets:targetNames,sourceSets:module.sourceSets.map(set => set.name),tests,runOutput,
      links:links.map(link => ({set:link.sourceSet,line:link.range.start.line+1})),propertyLinks:property.length,reverse:true,staleRejected:true};
    await fs.writeFile(process.env.ROCKETBRAIN_KMP_RECEIPT,JSON.stringify(receipt,null,2)+'\n');
  }
});
