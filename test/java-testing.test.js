'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {provisionTestingRuntime,discoverTests,runTests,manifestText,normalizeSelectors}=require('../src/java/testing');
const {validateJavaHome,readLauncherSources,execute}=require('../src/java/testing/provision');
const {parseCoverageXml}=require('../src/java/testing/coverage');
const runtimeConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG||path.resolve('test-output/v0.4-java-host-runtime.json');
const javaHome=fs.existsSync(runtimeConfig)?JSON.parse(fs.readFileSync(runtimeConfig,'utf8')).javaHome:null;
const enabled=javaHome&&fs.existsSync(path.join(javaHome,'bin','java'+(process.platform==='win32'?'.exe':'')));
let fixturePromise;
async function fixture(){
  return fixturePromise||= (async()=>{
    const base=path.resolve('test-output/java-testing-unit');await fsp.mkdir(base,{recursive:true});const folder=await fsp.mkdtemp(path.join(base,'fixture-'));
    await fsp.writeFile(path.join(folder,'owner.json'),JSON.stringify({kind:'RocketbrainJavaTestingUnit-v1',folder:path.basename(folder)}));
    const mainSources=path.join(folder,'src/main/java'),testSources=path.join(folder,'src/test/java'),mainClasses=path.join(folder,'classes/main'),testClasses=path.join(folder,'classes/test');
    for(const dir of [mainSources,testSources,mainClasses,testClasses])await fsp.mkdir(path.join(dir,'sample'),{recursive:true});
    const mainFile=path.join(mainSources,'sample/BranchLogic.java');
    await fsp.writeFile(mainFile,'package sample; public class BranchLogic { public static String classify(int value) { if(value>0) return "positive"; return "other"; } }\n');
    const testFile=path.join(testSources,'sample/ExampleTests.java');
    await fsp.writeFile(testFile,`package sample;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.util.stream.Stream;
import static org.junit.jupiter.api.Assertions.*;
public class ExampleTests {
 @Test void passing() { System.out.println("{\\\"type\\\":\\\"finished\\\",\\\"state\\\":\\\"passed\\\"}"); assertEquals("positive",BranchLogic.classify(3)); }
 @Test void failing() { assertEquals("wanted","actual"); }
 @Disabled("intentional fixture skip") @Test void disabled() { fail("must not execute"); }
 @ParameterizedTest @ValueSource(ints={-1,2}) void numbers(int value) { assertNotNull(BranchLogic.classify(value)); }
 @TestFactory Stream<DynamicTest> dynamic() { return Stream.of(DynamicTest.dynamicTest("first",()->assertEquals("other",BranchLogic.classify(-1))), DynamicTest.dynamicTest("second",()->assertEquals("positive",BranchLogic.classify(2)))); }
}`);
    await fsp.writeFile(path.join(testSources,'sample/BeforeAllFailureTests.java'),'package sample; import org.junit.jupiter.api.*; public class BeforeAllFailureTests { @BeforeAll static void setup(){throw new IllegalStateException("container failure");} @Test void neverStarted(){} }');
    await fsp.writeFile(path.join(testSources,'sample/SlowTests.java'),'package sample; import org.junit.jupiter.api.*; public class SlowTests { @Test void waiting() throws Exception { Thread.sleep(8000); } }');
    await fsp.writeFile(path.join(testSources,'sample/LegacyTests.java'),'package sample; public class LegacyTests { @org.junit.Test public void legacy(){org.junit.Assert.assertEquals("positive",BranchLogic.classify(1));} }');
    await fsp.writeFile(path.join(testSources,'sample/NestedTests.java'),'package sample; import org.junit.jupiter.api.*; public class NestedTests { void sameName(){}\n@Nested class Inner {\n@Test void sameName(){Assertions.assertTrue(true);}\n}\n}');
    const runtime=await provisionTestingRuntime({target:path.resolve('test-output/java-testing-runtime'),javaHome,cacheDirectory:path.resolve('test-output/java-testing-downloads'),sources:readLauncherSources()});
    const javac=path.join(javaHome,'bin','javac'+(process.platform==='win32'?'.exe':''));
    let result=await execute(javac,['-g','-encoding','UTF-8','-d',mainClasses,mainFile]);assert.equal(result.code,0,result.output);
    result=await execute(javac,['-g','-encoding','UTF-8','-classpath',[runtime.junitJar,mainClasses].join(path.delimiter),'-d',testClasses,...fs.readdirSync(path.join(testSources,'sample')).map(name=>path.join(testSources,'sample',name))]);assert.equal(result.code,0,result.output);
    return {folder,mainFile,testFile,runtime,config:{workspace:folder,javaHome,runtime,classPath:[mainClasses,testClasses],testClassPaths:[testClasses],sourceRoots:[mainSources,testSources],classDirectories:[mainClasses],outputRoot:path.join(folder,'runs'),timeoutMs:15000}};
  })();
}
const live=(name,fn)=>test(name,{skip:!enabled&&'Independent JDK25 test fixture is not configured.',timeout:120000},fn);
test('Java testing rejects unsafe selectors, missing JDK metadata and malformed coverage XML',()=>{
  assert.throws(()=>normalizeSelectors([{kind:'shell',value:'ignored'}]));assert.throws(()=>normalizeSelectors([{kind:'class',value:'Bad\nName'}]));
  const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'rocketbrain-invalid-jdk-'));
  try{fs.writeFileSync(path.join(root,'release'),'IMPLEMENTOR="unknown"');assert.throws(()=>validateJavaHome(root),/JDK25/);fs.writeFileSync(path.join(root,'release'),'JAVA_VERSION="25.0.5"\nIMPLEMENTOR="JetBrains"');assert.throws(()=>validateJavaHome(root),/independent/);}finally{fs.rmSync(root,{recursive:true,force:true});}
  assert.throws(()=>parseCoverageXml('<!DOCTYPE report SYSTEM "http://example.com/x"><report/>'),/declaration/);assert.throws(()=>parseCoverageXml('<report><!ENTITY x "bad"></report>'),/entity/);
});
live('owned JUnit launcher discovers actual bytecode and executes dynamic and parameterized tests with private result provenance',async()=>{
  const {config}=await fixture(),selected={selectors:[{kind:'class',value:'sample.ExampleTests'}]};
  const found=await discoverTests(config,selected);assert.equal(found.state,'completed',JSON.stringify(found));assert.equal(found.summary.testsFound,3);assert.ok(found.tests.some(item=>item.methodName==='numbers'&&item.kind==='container'));assert.ok(found.tests.filter(item=>item.methodName).every(item=>item.uri?.endsWith('/sample/ExampleTests.java')&&Number.isInteger(item.line)));
  const result=await runTests(config,selected);assert.equal(result.state,'completed');assert.equal(result.exitCode,1);assert.equal(result.summary.testsFound,7);assert.equal(result.summary.testsSucceeded,5);assert.equal(result.summary.testsFailed,1);assert.equal(result.summary.testsSkipped,1);
  const failed=result.events.find(event=>event.type==='finished'&&event.test.methodName==='failing');assert.equal(failed.error.expected,'wanted');assert.equal(failed.error.actual,'actual');assert.ok(failed.error.frames.some(frame=>frame.uri?.endsWith('/ExampleTests.java')));
  assert.ok(result.events.filter(event=>event.type==='dynamic').length>=4);assert.ok(result.events.some(event=>event.test?.id.includes('[test-template-invocation:')));assert.match(result.output,/{"type":"finished","state":"passed"}/);assert.equal(result.events.filter(event=>event.type==='finished'&&!event.test).length,0,'application stdout cannot forge test status');
  const invocation=result.tests.find(item=>item.kind==='test'&&item.id.includes('[dynamic-test:'));
  const rerun=await runTests(config,{selectors:[{kind:'uniqueId',value:invocation.id}]});assert.equal(rerun.summary.testsStarted,1);assert.equal(rerun.summary.testsSucceeded,1);
  const failedRerun=await runTests(config,{selectors:[{kind:'uniqueId',value:failed.test.id}]});assert.equal(failedRerun.summary.testsStarted,1);assert.equal(failedRerun.summary.testsFailed,1);
  const excluded=await runTests(config,{...selected,excludes:[{kind:'uniqueId',value:failed.test.id}]});assert.equal(excluded.summary.testsFailed,0);assert.equal(excluded.summary.testsStarted,5);
  const nested=await discoverTests(config,{selectors:[{kind:'class',value:'sample.NestedTests'}]});const child=nested.tests.find(item=>item.kind==='test');assert.equal(child.className,'sample.NestedTests$Inner');assert.ok(child.line===undefined||child.line===2,'A nested test must not borrow the unrelated outer same-name method position.');
});
live('JaCoCo reports real Java25 run coverage with line, branch and method counts and UTF8 source locations',async()=>{
  const {config}=await fixture();const result=await runTests(config,{selectors:[{kind:'method',value:'sample.ExampleTests#passing'}],coverage:true});
  assert.equal(result.state,'completed');assert.equal(result.summary.testsSucceeded,1);assert.equal(result.coverage.state,'available',JSON.stringify(result.coverage));assert.equal(result.coverage.scope,'run');assert.equal(result.coverage.perTestCoverage,false);
  const file=result.coverage.files.find(item=>item.relativePath==='sample/BranchLogic.java');assert.ok(file);assert.equal(file.branches.total,2);assert.equal(file.branches.covered,1);assert.ok(file.lines.covered>0);assert.equal(file.methods.covered,1);assert.equal(file.methods.total,2);assert.ok(file.methodDetails.some(method=>method.name==='classify'&&method.covered));assert.ok(file.details.every(detail=>detail.line>=0));assert.ok(fs.existsSync(result.coverage.execFile));assert.ok(fs.existsSync(path.join(result.coverage.htmlDirectory,'index.html')));
  const manifest=fs.readFileSync(path.join(result.runDirectory,'MANIFEST.MF'),'utf8');assert.ok(manifest.includes('%EA%B9%80'));assert.ok(manifest.split('\r\n').every(line=>Buffer.byteLength(line)<=70));
});
live('JUnit container failures and cancellation stay distinct from assertion failures and incomplete coverage',async()=>{
  const {config}=await fixture();const legacy=await runTests(config,{selectors:[{kind:'class',value:'sample.LegacyTests'}]});assert.equal(legacy.summary.testsSucceeded,1);assert.ok(legacy.tests.some(item=>item.id.startsWith('[engine:junit-vintage]')));
  const broken=await runTests(config,{selectors:[{kind:'class',value:'sample.BeforeAllFailureTests'}]});assert.equal(broken.state,'completed');assert.equal(broken.summary.containersFailed,1);assert.equal(broken.summary.testsStarted,0);assert.ok(broken.events.some(event=>event.type==='finished'&&event.test.kind==='container'&&event.state==='failed'));
  const abort=new AbortController();const cancelled=await runTests(config,{selectors:[{kind:'class',value:'sample.SlowTests'}],coverage:true,cancellation:abort.signal,onEvent:event=>{if(event.type==='started'&&event.test.kind==='test')abort.abort();}});assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.coverage.state,'unavailable');assert.equal(cancelled.cancelled,true);
});
live('coverage refuses stale disk source alignment and exact launcher builds are reproducible',async()=>{
  const {config,mainFile,runtime}=await fixture(),original=fs.readFileSync(mainFile,'utf8');
  try{const result=await runTests(config,{selectors:[{kind:'method',value:'sample.ExampleTests#passing'}],coverage:true,onEvent:event=>{if(event.type==='started'&&event.test.kind==='test')fs.writeFileSync(mainFile,original+'// changed during coverage\n');}});assert.equal(result.coverage.state,'unavailable');assert.match(result.coverage.warnings[0],/changed/);}finally{fs.writeFileSync(mainFile,original);}
  const second=await provisionTestingRuntime({target:path.resolve('test-output/java-testing-runtime'),javaHome,sources:readLauncherSources(),cacheDirectory:path.resolve('test-output/java-testing-downloads')});assert.equal(second.launcherJar,runtime.launcherJar);assert.equal(second.launcherSha256,runtime.launcherSha256);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(second.launcherJar)).digest('hex'),second.launcherSha256);
});
