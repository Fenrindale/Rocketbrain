'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inspectAdvisoryCalls } = require('../src/java/advisory-calls');
const { parseMavenDependencyTree, auditMavenPackages } = require('../src/java/dependency-advisories');
const { parseGradleAdvisoryGraph, gradleInit, task } = require('../src/java/gradle-advisory-graph');
const { mavenClasspathGoal, gradleClasspathTask, gradleClasspathInit, parseAdvisoryClasspath } = require('../src/java/advisory-classpath');
const { buildSpec } = require('../src/java/workbench-tasks');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const configuration = 'compileClasspath';
const keys = ['com.google.guava:guava@31.1-jre','org.apache.commons:commons-text@1.9'];
const evidenceText = [
  'package fixture.advisories;',
  'import java.util.function.Supplier;',
  'import org.apache.commons.text.StringSubstitutor;',
  'import org.apache.commons.text.lookup.StringLookupFactory;',
  '@org.springframework.stereotype.Component',
  'public final class Evidence {',
  '  Object apacheCall() { return StringSubstitutor.createInterpolator(); }',
  '  Object apacheLookup() { return StringLookupFactory.INSTANCE.interpolatorStringLookup(); }',
  '  Supplier<StringSubstitutor> deferred() { return StringSubstitutor::createInterpolator; }',
  '  Object guavaCall() { return com.google.common.io.Files.createTempDir(); }',
  '  Object unrelated() { return Lookalike.createInterpolator(); }',
  '  static class Lookalike { static Object createInterpolator() { return null; } }',
  '}',
  '',
].join('\n');

async function actualSpringWorkspace(vscode) {
  await fixtureConfig();
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const original = await fs.realpath(config.projectPath);
  if (!vscode) return original;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const matching = await Promise.all(['build.gradle','settings.gradle'].map(async filename => {
      try { return (await fs.readFile(path.join(original,filename))).equals(await fs.readFile(path.join(folder.uri.fsPath,filename))); }
      catch { return false; }
    }));
    if (matching.every(Boolean)) return fs.realpath(folder.uri.fsPath);
  }
  throw Error('Use the owned Spring workspace for installed advisory call checks.');
}

async function directoryFor(workspace, tool) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(workspace,'rocketbrain-advisory-' + tool + '-')));
  await fs.writeFile(path.join(root,'.owned'),'RocketbrainAdvisoryCallsFixture-v1',{flag:'wx'});
  const source = path.join(root,'src','main','java','fixture','advisories','Evidence.java');
  await fs.mkdir(path.dirname(source),{recursive:true});
  await fs.writeFile(source,evidenceText);
  const artifacts = [
    ['com.google.guava','guava','31.1-jre'],['org.apache.commons','commons-text','1.9'],
    ['org.springframework','spring-context','7.0.10'],
  ];
  if (tool === 'maven') {
    const entries = artifacts.map(([group,name,version]) =>
      '<dependency><groupId>'+group+'</groupId><artifactId>'+name+'</artifactId><version>'+version+'</version></dependency>');
    await fs.writeFile(path.join(root,'pom.xml'),
      '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>'+
      '<groupId>fixture.advisories</groupId><artifactId>owned-advisories</artifactId><version>1.0</version>'+
      '<properties><maven.compiler.release>21</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>'+
      '<dependencies>'+entries.join('')+'</dependencies></project>\n');
  } else {
    await fs.writeFile(path.join(root,'settings.gradle'),"rootProject.name = 'owned-advisories'\n");
    await fs.writeFile(path.join(root,'build.gradle'), "plugins { id 'java' }\nrepositories { mavenCentral() }\n"+
      "version = '1.0'\ntasks.withType(JavaCompile).configureEach { options.release = 21 }\n"+
      'dependencies {\n'+artifacts.map(parts => "  implementation '"+parts.join(':')+"'").join('\n')+'\n}\n');
  }
  return { root, source, uri: pathToFileURL(source).href, text: evidenceText };
}

function settings() {
  const options = {
    javaHome: process.env.ROCKETBRAIN_SPRING_JAVA_HOME,
    mavenHome: process.env.ROCKETBRAIN_MAVEN_HOME,
    gradleHome: process.env.ROCKETBRAIN_GRADLE_HOME,
  };
  for (const value of Object.values(options)) assert.ok(path.isAbsolute(value ?? ''),'Set the owned Maven, Gradle, and independent JDK paths.');
  return options;
}

async function run(spec) {
  await promisify(execFile)(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:120000,maxBuffer:4*1024*1024})
    .catch(error => { throw Error(String(error.stdout || error.stderr || error.message).slice(-2400)); });
}

async function actualBuild(tool, project) {
  const { root } = project;
  const base = { root, name:'Owned advisory fixture', tool };
  const config = settings();
  const temp = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(temp,'rocketbrain-actual-advisory-artifacts-'));
  const treeFile = path.join(owned,'tree.json'), classpathFile = path.join(owned,'classpath.data');
  try {
    if (tool === 'maven') {
      const spec=buildSpec(base,config,['compile','org.apache.maven.plugins:maven-dependency-plugin:3.11.0:tree',mavenClasspathGoal]);
      const repo=process.env.ROCKETBRAIN_ADVISORY_TEST_MAVEN_REPO;
      assert.ok(path.isAbsolute(repo ?? ''),'Use the isolated Maven fixture cache.');
      spec.args.push('--non-recursive','-DoutputType=json','-DoutputFile='+treeFile,
        '-DincludeScope=compile','-Dmdep.outputFile='+classpathFile,'-Dmaven.repo.local='+repo);
      await run(spec);
    } else {
      const treeInit=path.join(owned,'advisories.init.gradle'), compileInit=path.join(owned,'classpath.init.gradle');
      await fs.writeFile(treeInit,gradleInit,{flag:'wx'});
      await fs.writeFile(compileInit,gradleClasspathInit,{flag:'wx'});
      const graph=buildSpec(base,config,['classes',task],{discovery:true,output:treeFile,initFile:treeInit});
      graph.args.unshift('-Drocketbrain.advisories.configuration='+configuration);
      graph.args.push('--no-configuration-cache');
      graph.env.GRADLE_USER_HOME=path.resolve('test-output/java-gradle-user-home');
      await run(graph);
      const observed=buildSpec(base,config,[gradleClasspathTask],{discovery:true,output:classpathFile,initFile:compileInit});
      observed.args.push('--no-configuration-cache');
      observed.env.GRADLE_USER_HOME=graph.env.GRADLE_USER_HOME;
      await run(observed);
    }
    const classFile = tool === 'maven' ? 'target/classes' : 'build/classes/java/main';
    assert.equal((await fs.stat(path.join(root,classFile,'fixture/advisories/Evidence.class'))).isFile(),true);
    const tree = await fs.readFile(treeFile,'utf8');
    return {
      tree: tool === 'maven' ? parseMavenDependencyTree(tree) : parseGradleAdvisoryGraph(tree,configuration),
      classpath: parseAdvisoryClasspath(await fs.readFile(classpathFile,'utf8'),tool),
    };
  } finally {
    assert.equal(path.relative(owned,await fs.realpath(owned)),'');
    assert.equal(path.dirname(owned),temp);
    assert.ok(path.basename(owned).startsWith('rocketbrain-actual-advisory-artifacts-'));
    await fs.rm(owned,{recursive:true});
  }
}

function checkCalls(result, report) {
  const guava = result.rows.find(row => row.key === keys[0]), text = result.rows.find(row => row.key === keys[1]);
  assert.equal(guava.state,'calls-observed');
  assert.equal(text.state,'calls-observed');
  assert.deepEqual(guava.calls.map(call => call.kind),['call']);
  assert.deepEqual(text.calls.map(call => call.kind).sort(),['call','call','method reference']);
  assert.deepEqual(guava.callAdvisories,['GHSA-5mg8-w23w-74h3']);
  assert.ok(guava.advisories.length >= guava.callAdvisories.length);
  assert.ok(report.packages.every(row => row.advisories.length > 0));
  assert.equal(guava.vendorFixVersion,'32.0.1-jre');
  assert.equal(text.vendorFixVersion,'1.10.0');
  assert.equal(result.omitted,0);
  for (const call of [guava.calls[0],...text.calls]) assert.match(call.artifactSha256,/^[a-f0-9]{64}$/u);
  return text.calls.find(site => site.signature.endsWith('#createInterpolator()') && site.kind === 'call');
}

async function headlessNegatives(report, project, observed) {
  const javaHome=settings().javaHome;
  const base={report,javaHome,release:21,sources:[project],classpath:observed.classpath};
  const noCall=await inspectAdvisoryCalls({...base,sources:[{...project,text:'package fixture.advisories;\nfinal class Evidence { String createInterpolator() { return "local"; } }\n'}]});
  assert.ok(noCall.rows.every(row => row.state === 'no-listed-use-observed' && !row.calls.length));
  const shadowSource = { uri: pathToFileURL(path.join(project.root,'StringSubstitutor.java')).href,
    text:'package org.apache.commons.text; public final class StringSubstitutor { public static StringSubstitutor createInterpolator() { return null; } }' };
  const shadow=await inspectAdvisoryCalls({...base,sources:[project,shadowSource]});
  const apache=shadow.rows.find(row=>row.key===keys[1]);
  assert.equal(apache.signatures.find(signature=>signature.name==='createInterpolator').state,'source-shadowed');
  assert.equal(apache.calls.length,1);
  const wrong=process.env.ROCKETBRAIN_ADVISORY_TEST_FIXED_TEXT_JAR;
  assert.ok(path.isAbsolute(wrong ?? ''),'Set the owned official fixed Apache Commons Text artifact path.');
  const duplicate=await inspectAdvisoryCalls({...base,classpath:[...base.classpath,wrong]});
  const duplicateApache=duplicate.rows.find(row=>row.key===keys[1]);
  assert.equal(duplicateApache.calls.length,0);
  assert.ok(duplicateApache.signatures.every(signature=>signature.state==='duplicate-owner'));
  const mismatched=await inspectAdvisoryCalls({...base,classpath:[...base.classpath.filter(file=>!file.endsWith('commons-text-1.9.jar')),wrong]});
  const mismatchedApache=mismatched.rows.find(row=>row.key===keys[1]);
  assert.equal(mismatchedApache.calls.length,0);
  assert.ok(mismatchedApache.signatures.every(signature=>signature.state==='artifact-hash-mismatch'));
  const original=base.classpath.find(file=>file.endsWith('commons-text-1.9.jar'));
  const copy=path.join(project.root,'owned-artifact.jar');
  await fs.copyFile(original,copy);
  const fresh=await inspectAdvisoryCalls({...base,classpath:[...base.classpath.filter(file=>file!==original),copy]});
  assert.equal(fresh.rows.find(row=>row.key===keys[1]).calls.length,3);
  await fs.appendFile(copy,'changed after inspected bytes');
  assert.throws(()=>fresh.validateClasspath(),/classpath changed/i);
  return { noListedCall:true, sourceShadowRefused:true, duplicateOwnerRefused:true, differentArtifactRefused:true, staleArtifactRefused:true };
}

async function runJavaAdvisoryCallChecks(api,vscode,checks={}) {
  const workspace=await actualSpringWorkspace(vscode);
  const columns={};
  for (const tool of ['maven','gradle']) {
    const project=await directoryFor(workspace,tool);
    try {
      let metadata, report, inspected, nativeNavigation=false, staleSourceRefused=false, negatives;
      if (vscode) {
        const service=api.java.dependencyAdvisories, target=vscode.Uri.file(project.root);
        metadata={tree:tool==='maven'?await service.resolveTree(target,{allowProjectExecution:true}):
          await service.resolveGradleTree(target,configuration,{allowProjectExecution:true})};
        report=await service.audit(metadata.tree,keys,{allowLookup:true});
        await assert.rejects(()=>service.inspectCalls(report),/explicitly resolve/);
        inspected=await service.inspectCalls(report,{allowProjectExecution:true});
        const link=checkCalls(inspected,report);
        const uri=await service.publishCalls(inspected), document=await vscode.workspace.openTextDocument(uri);
        assert.match(document.getText(),/Listed API use observed/u);
        assert.match(document.getText(),/Runtime reachability/u);
        assert.equal(document.isDirty,false);
        const source=await service.openCall(inspected,link);
        assert.equal(path.relative(source.fsPath,project.source),'');
        const editor=vscode.window.activeTextEditor;
        assert.equal(editor.document.getText(editor.selection),'StringSubstitutor.createInterpolator()');
        nativeNavigation=true;
        await fs.writeFile(project.source,project.text+'// changed after inspection\n');
        await assert.rejects(()=>service.openCall(inspected,link),/reviewed Java sources/u);
        staleSourceRefused=true;
      } else {
        metadata=await actualBuild(tool,project);
        report=await auditMavenPackages(metadata.tree,keys);
        inspected=await inspectAdvisoryCalls({report,sources:[project],classpath:metadata.classpath,javaHome:settings().javaHome,release:21});
        checkCalls(inspected,report);
        if (tool === 'maven') negatives=await headlessNegatives(report,project,metadata);
      }
      assert.ok(metadata.tree.packages.some(item=>item.name==='org.springframework:spring-context'&&item.direct));
      columns[tool]={advisories:2,calls:3,methodReferences:1,actualResolvedClasspath:true,sourceCoordinatesOnlyLookup:true,
        vendorFixVersions:['1.10.0','32.0.1-jre'], nativeNavigation,staleSourceRefused,...negatives};
    } finally {
      assert.equal(await fs.realpath(project.root),project.root);
      assert.equal(path.relative(path.dirname(project.root),workspace),'');
      assert.ok(path.basename(project.root).startsWith('rocketbrain-advisory-'+tool+'-')&&
        (await fs.stat(path.join(project.root,'.owned'))).isFile());
      if (vscode) {
        const active = vscode.window.activeTextEditor?.document;
        if (active?.uri.scheme === 'file' && path.relative(active.uri.fsPath,project.source) === '') {
          assert.equal(active.isDirty,false);
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
      await fs.rm(project.root,{recursive:true,maxRetries:12,retryDelay:180});
    }
  }
  checks.javaAdvisoryCalls={tools:columns,jdbc:await jdbcReadback()};
  return checks;
}

if(require.main===module)runJavaAdvisoryCallChecks().then(value=>console.log(JSON.stringify(value)),
  error=>{console.error(error);process.exitCode=1;});
module.exports={runJavaAdvisoryCallChecks};
