'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function runJavaTestingChecks(api,vscode,checks){
  const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8')),config=require('./java-testing-fixture').fixtureTestingConfig(runtime);
  const fixtureRoot=path.resolve(__dirname,'fixtures');
  for(const document of vscode.workspace.textDocuments){
    if(document.languageId!=='java'||!document.isDirty||document.uri.scheme!=='file')continue;
    const relative=path.relative(fixtureRoot,document.uri.fsPath);
    if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(document.uri.fsPath)||document.getText().replace(/\r\n/g,'\n')!==fs.readFileSync(document.uri.fsPath,'utf8').replace(/\r\n/g,'\n'))continue;
    await vscode.window.showTextDocument(document);await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  console.log('[Java Testing test] remaining dirty Java buffers: '+vscode.workspace.textDocuments.filter(d=>d.languageId==='java'&&d.isDirty).map(d=>d.uri.toString()).join(', '));
  console.log('[Java Testing test] preparing embedded independent launcher');
  const installed=await vscode.commands.executeCommand('rocketbrain.java.testing.install');assert.equal(installed.version,'0.9.0');assert.equal(installed.junitVersion,'6.0.3');assert.equal(installed.jacocoVersion,'0.8.16');
  assert.ok(fs.existsSync(installed.launcherJar));
  console.log('[Java Testing test] resolving imported project test classpath and building');
  let discovered=await api.javaTesting.discover();
  assert.ok(discovered.tests.some(t=>t.className==='fixture.boot.RocketbrainSpringTest'),JSON.stringify(discovered.tests.slice(0,5)));
  assert.ok(discovered.tests.some(t=>t.methodName==='policy'));
  checks.push('The final extension compiles its embedded independent JUnit launcher and discovers real Spring tests through the imported Maven/Gradle test classpath in the native Test Explorer.');
  const classItem=discovered.tests.find(t=>t.className==='fixture.boot.RocketbrainSpringTest'&&t.kind==='container'&&!t.methodName);assert.ok(classItem);
  console.log('[Java Testing test] running Spring/DB tests with real JVM coverage');
  const result=await api.javaTesting.run({includeIds:[classItem.nativeId],coverage:true,env:config.env,build:false});
  const project=result.projects.find(p=>p.summary.testsSucceeded>=7);assert.ok(project,JSON.stringify(result.projects.map(p=>p.summary)));assert.equal(project.summary.testsFailed,0);assert.ok(project.summary.testsSkipped>=1);
  assert.equal(project.coverage.state,'available',JSON.stringify(project.coverage.warnings));assert.equal(project.coverage.perTestCoverage,false);
  const policy=project.coverage.files.find(f=>f.uri.endsWith('/RiskPolicy.java'));assert.ok(policy);assert.ok(policy.branches.covered>0&&policy.branches.covered<policy.branches.total);assert.ok(policy.methods.covered<policy.methods.total);assert.ok(policy.details.some(l=>l.covered)&&policy.details.some(l=>!l.covered));
  discovered=api.javaTesting.snapshot();assert.ok(discovered.tests.some(t=>t.label==='small amount'));assert.ok(discovered.tests.some(t=>t.label==='large amount'));
  assert.ok(api.javaTesting.controller.items.size>0);
  checks.push('Native Java testing runs the real Spring/JPA DB tests, parameterized and dynamic cases, displays disabled cases and publishes measured line/branch/method coverage with covered and missed application code.');
  const outcomeClass=discovered.tests.find(t=>t.className==='fixture.boot.RunnerOutcomeTest'&&t.kind==='container'&&!t.methodName);assert.ok(outcomeClass);
  console.log('[Java Testing test] checking failure details and selected failed rerun');
  const failure=await api.javaTesting.run({includeIds:[outcomeClass.nativeId],jvmArgs:['-Drocketbrain.fixture.fail=true'],build:false});assert.equal(failure.projects[0].summary.testsFailed,1);assert.equal(failure.projects[0].summary.testsSucceeded,1);
  const rerun=await api.javaTesting.rerunFailed({jvmArgs:[],build:false});assert.equal(rerun.projects[0].summary.testsSucceeded,1);assert.equal(rerun.projects[0].summary.testsFailed,0);assert.equal(rerun.projects[0].summary.testsFound,1);
  checks.push('An intentional JVM assertion failure is recorded as failed and the failed-test command reruns only that unique test ID after the condition is corrected.');
  const response=await fetch(runtime.baseUrl+'/probe/testing-state');assert.equal(response.status,200);const isolation=await response.json();assert.deepEqual(isolation,{people:2,departments:1,rolledBackNames:0});
  checks.push('Spring tests use the existing isolated MySQL/MariaDB schema with DDL and seeding disabled; transactional test writes roll back and the running application keeps its original rows.');
  const report={asOf:new Date().toISOString(),engine:runtime.dbEngine,version:(process.env.ROCKETBRAIN_RELEASE_VERSION||'0.9.0'),junit:installed.junitVersion,jacoco:installed.jacocoVersion,launcherSha256:installed.launcherSha256,summary:project.summary,policyCoverage:policy,isolation,failedSummary:failure.projects[0].summary,rerunSummary:rerun.projects[0].summary,coverageScope:'run',perTestCoverage:false};
  const serialized=JSON.stringify(report,null,2);assert.ok(!serialized.includes(config.env.SPRING_DATASOURCE_PASSWORD));fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.9")+'-native-java-testing-'+runtime.dbEngine+'.json'),serialized+'\n');
  await runV09Checks(api,checks,{runtime,config,installed});
}
async function runV09Checks(api,checks,{runtime,config,installed}){
  const reports=[];
  for(const [framework,className,expected] of [['junit','fixture.boot.RocketbrainSpringTest',7],['testng','fixture.boot.RocketbrainTestNGTest',4]]){
    const tree=api.javaTesting.snapshot(),selected=tree.tests.find(t=>t.framework===framework&&t.className===className&&t.kind==='container'&&!t.methodName);assert.ok(selected,'Actual '+framework+' class is discovered through imported test classpaths');
    const result=await api.javaTesting.run({includeIds:[selected.nativeId],perTestCoverage:true,env:config.env,build:false}),project=result.projects[0];
    assert.equal(result.state,'completed');assert.equal(project.framework,framework);assert.equal(project.summary.testsSucceeded,expected);assert.equal(project.summary.testsFailed,0);assert.ok(project.summary.testsSkipped>=1);
    const measured=project.perTestCoverage;assert.equal(measured.state,'available',JSON.stringify(measured.warnings));assert.equal(measured.scope,'test-execution-interval');assert.equal(measured.concurrencyObserved,false);
    assert.ok(measured.tests.length>=expected);assert.ok(measured.tests.every(t=>project.coverage.files.every(f=>!t.coverage.files.find(c=>c.uri===f.uri)||t.coverage.files.find(c=>c.uri===f.uri).lines.covered<=f.lines.covered)),'Merged run coverage includes all measured segments');
    const policyTests=measured.tests.map(t=>({testId:t.testId,file:t.coverage.files.find(f=>f.uri.endsWith('/RiskPolicy.java'))})).filter(t=>t.file?.lines.covered>0);
    assert.ok(policyTests.length>=2);assert.ok(new Set(policyTests.map(t=>JSON.stringify(t.file.details.map(l=>[l.line,l.covered])))).size>=2,'Actual data cases cover different application lines');
    assert.ok(measured.unattributed?.coverage,'Shared and configuration execution remains separately unattributed');
    reports.push({framework,summary:project.summary,scope:measured.scope,warnings:measured.warnings,boundaryDescription:measured.boundaryDescription,concurrencyObserved:measured.concurrencyObserved,measuredTests:measured.tests.length,policy:policyTests.map(t=>({testId:t.testId,lines:t.file.lines,branches:t.file.branches,details:t.file.details})),runPolicy:project.coverage.files.find(f=>f.uri.endsWith('/RiskPolicy.java')),unattributedTotals:measured.unattributed.coverage.totals});
    checks.push(`The native ${framework} serial Coverage by Test profile measures each actual test interval once, publishes distinct case coverage and preserves merged run coverage and unattributed shared execution.`);
    if(framework==='testng'){
      const cases=api.javaTesting.snapshot().tests.filter(t=>t.framework==='testng'&&t.className===className&&t.methodName==='amountPolicy'&&t.kind==='test');assert.equal(cases.length,2);assert.equal(new Set(cases.map(t=>t.id)).size,2);
      const rerun=await api.javaTesting.run({includeIds:[cases[0].nativeId],env:config.env,build:false});assert.equal(rerun.projects[0].summary.testsSucceeded,1);assert.equal(rerun.projects[0].summary.testsFound,1);
      reports.push({framework,selectedDataProviderCase:cases[0].id,rerun:rerun.projects[0].summary});
      checks.push('Native TestNG discovery and execution preserve runtime data-provider case IDs; selecting one measured case reruns exactly that invocation.');
    }
  }
  const outcome=api.javaTesting.snapshot().tests.find(t=>t.framework==='testng'&&t.className==='fixture.boot.TestNGOutcomeTest'&&t.kind==='container'&&!t.methodName);assert.ok(outcome);
  const failure=await api.javaTesting.run({includeIds:[outcome.nativeId],jvmArgs:['-Drocketbrain.fixture.fail=true'],build:false});assert.equal(failure.projects[0].summary.testsFailed,1);assert.equal(failure.projects[0].summary.testsSkipped,1);
  const rerun=await api.javaTesting.rerunFailed({jvmArgs:[],build:false});assert.equal(rerun.projects[0].summary.testsSucceeded,1);assert.equal(rerun.projects[0].summary.testsFound,1);assert.equal(rerun.projects[0].summary.testsFailed,0);
  checks.push('TestNG assertion failures and dependency skips appear as separate native outcomes, and failed-only rerun executes only the corrected failing method.');
  const response=await fetch(runtime.baseUrl+'/probe/testing-state'),isolation=await response.json();assert.deepEqual(isolation,{people:2,departments:1,rolledBackNames:0});
  const report={asOf:new Date().toISOString(),version:(process.env.ROCKETBRAIN_RELEASE_VERSION||'0.9.0'),engine:runtime.dbEngine,testng:installed.testngVersion,reports,failureSummary:failure.projects[0].summary,failedRerun:rerun.projects[0].summary,isolation};
  const serialized=JSON.stringify(report,null,2);assert.ok(!serialized.includes(config.env.SPRING_DATASOURCE_PASSWORD));fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.9")+'-native-per-test-'+runtime.dbEngine+'.json'),serialized+'\n');
}
module.exports={runJavaTestingChecks};
