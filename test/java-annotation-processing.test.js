'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath,pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { LOMBOK_VERSION,LOMBOK_SHA256,stageLombokAgent } = require('../src/java/annotation-processing');
const { StdioLsp,positionOf,until } = require('./helpers/stdio-lsp');
const { copyProcessorProject,processorSource,renamedProcessorSources } = require('./helpers/java-processor-fixture');

const configuration = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const runtime = {skip:!configuration && 'Independent JDT, JDK, Maven and Gradle are not configured.',timeout:300000};
const main = 'processors.fixture.ProcessorProbe';
const run = promisify(execFile);
const xml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;');
const uri = file => pathToFileURL(file).href;
const sourceFile = value => fileURLToPath(value.targetUri || value.uri);
const equivalent = (left,right) => !path.relative(left,right);

test('editor processor opt-in defaults off and refuses arbitrary or stale agent bytes',async t => {
  assert.equal(serverSettings().java.import.gradle.annotationProcessing.enabled,false);
  assert.equal(serverSettings([],{gradleAnnotationProcessing:true}).java.import.gradle.annotationProcessing.enabled,true);
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-processor-unit-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const jar = path.join(root,'fake.jar'), storage = path.join(root,'storage');
  assert.equal(stageLombokAgent('',storage),null);
  assert.throws(() => stageLombokAgent('relative.jar',storage),/absolute local JAR/);
  await fs.writeFile(jar,Buffer.alloc(2055065));
  assert.throws(() => stageLombokAgent(jar,storage),/checksum/);
  await assert.rejects(fs.stat(path.join(storage,'verified-java-agents')),error => error.code === 'ENOENT');
});

test('Maven and Gradle run Lombok and MapStruct, and real JDT updates generated navigation and diagnostics',runtime,async t => {
  const config = JSON.parse(await fs.readFile(configuration,'utf8'));
  const {javaHome,serverPath,gradleHome} = config;
  const mavenHome = process.env.ROCKETBRAIN_MAVEN_HOME || config.mavenHome || path.resolve(path.dirname(configuration),
    '../research/implementation/runtimes/v0.18-maven-cache/extracted/apache-maven-3.9.11');
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-processor-runtime-'));
  const prevGradle = process.env.GRADLE_USER_HOME;
  let stopGradle;
  t.after(async () => {
    try { await stopGradle?.(); }
    finally {
      if (prevGradle === undefined) delete process.env.GRADLE_USER_HOME; else process.env.GRADLE_USER_HOME=prevGradle;
      await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:300});
    }
  });
  const gradleUserHome = path.join(root,'gradle-home'), repository = path.join(root,'maven-repository');
  process.env.GRADLE_USER_HOME=gradleUserHome;
  const java = path.join(javaHome,'bin',process.platform === 'win32' ? 'java.exe' : 'java');
  const mavenBoot = (await fs.readdir(path.join(mavenHome,'boot'))).find(name => /^plexus-classworlds-[\d.]+\.jar$/.test(name));
  const gradleBoot = (await fs.readdir(path.join(gradleHome,'lib'))).find(name => /^gradle-launcher-[\d.]+\.jar$/.test(name));
  assert.ok(mavenBoot && gradleBoot);
  const options = cwd => ({cwd,timeout:120000,windowsHide:true,maxBuffer:2*1024*1024,
    env:{...process.env,JAVA_HOME:javaHome}});
  const gradleCommand = ['-Dorg.gradle.java.home='+javaHome,'-cp',path.join(gradleHome,'lib',gradleBoot),
    'org.gradle.launcher.GradleMain'];
  stopGradle = () => run(java,[...gradleCommand,'--stop'],options(root));
  async function buildCli(tool) {
    const project = await copyProcessorProject(path.join(root,'cli-'+tool),tool);
    const args = tool === 'maven' ? [
      '-Dfile.encoding=UTF-8','-Dmaven.home='+mavenHome,'-Dclassworlds.conf='+path.join(mavenHome,'bin/m2.conf'),
      '-Dmaven.multiModuleProjectDirectory='+project,'-cp',path.join(mavenHome,'boot',mavenBoot),
      'org.codehaus.plexus.classworlds.launcher.Launcher','-B','-ntp','-Dmaven.repo.local='+repository,'compile'
    ] : [...gradleCommand,'--no-daemon','--console=plain','--max-workers=2','classes'];
    await run(java,args,options(project));
    const generated = tool === 'maven' ? 'target/generated-sources/annotations' : 'build/generated/sources/annotationProcessor/java/main';
    assert.match(await fs.readFile(path.join(project,generated,'processors/fixture/ProfileMapperImpl.java'),'utf8'),/value\.getLabel\(\)/);
    const binary = path.join(project,tool === 'maven' ? 'target/classes' : 'build/classes/java/main');
    const result = await run(java,['-cp',binary,main],options(project));
    assert.equal(result.stdout.trim(),'finch:finch');
    return result.stdout.trim();
  }
  const [maven,gradle] = await Promise.all([buildCli('maven'),buildCli('gradle')]);
  const lombokJar = path.join(repository,'org/projectlombok/lombok',LOMBOK_VERSION,'lombok-'+LOMBOK_VERSION+'.jar');
  const settingsFile = path.join(root,'maven-settings.xml');
  await fs.writeFile(settingsFile,'<settings><localRepository>'+xml(repository)+'</localRepository></settings>');
  const launchOptions = {javaHome,serverPath,lombokJar,storagePath:path.join(root,'identities')};
  assert.throws(() => resolveLaunch(launchOptions),/Trust the workspace/);
  assert.throws(() => resolveLaunch({...launchOptions,lombokJar:'',gradleAnnotationProcessing:true}),/Trust the workspace/);
  const disabledLaunch = resolveLaunch({...launchOptions,lombokJar:''});
  const enabledLaunch = resolveLaunch({...launchOptions,trustedWorkspace:true,gradleAnnotationProcessing:true});
  assert.notEqual(disabledLaunch.identity,enabledLaunch.identity);
  assert.ok(!disabledLaunch.args.some(arg => arg.startsWith('-javaagent:')));
  assert.equal(enabledLaunch.annotationProcessing.lombok.sha256,LOMBOK_SHA256);
  assert.ok(enabledLaunch.args.some(arg => arg.startsWith('-javaagent:') && !arg.endsWith(lombokJar)));

  async function editor(tool) {
    const project = await copyProcessorProject(path.join(root,'editor-'+tool),tool), rootUri = uri(project);
    const launch = resolveLaunch({...launchOptions,storagePath:path.join(root,'engine-'+tool),
      trustedWorkspace:true,gradleAnnotationProcessing:tool === 'gradle'});
    launch.args.unshift('-Duser.home='+path.join(root,'editor-java-user'));
    const settings = serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{
      gradleHome,gradleJavaHome:javaHome,gradleAnnotationProcessing:tool === 'gradle'
    });
    settings.java.configuration.maven = {userSettings:settingsFile};
    const lsp = new StdioLsp(launch);
    try {
      await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'processors-'+tool}],
        capabilities:{workspace:{configuration:true},textDocument:{
          documentSymbol:{hierarchicalDocumentSymbolSupport:true},definition:{linkSupport:true},
          completion:{completionItem:{snippetSupport:false}}
        }},initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings}
      },75000);
      lsp.notify('initialized',{});
      lsp.notify('workspace/didChangeConfiguration',{settings});
      const documents = {};
      for (const name of ['Profile','ProfileMapper','ProcessorProbe']) {
        const file = processorSource(project,name), text = await fs.readFile(file,'utf8');
        const document = {uri:uri(file),text,version:1,languageId:'java'};
        documents[name] = {...document,file};
        lsp.notify('textDocument/didOpen',{textDocument:document});
      }
      const probe = documents.ProcessorProbe, textDocument = {uri:probe.uri};
      await until(async () => (await lsp.request('textDocument/documentSymbol',{textDocument},12000))?.length,110000);
      assert.equal(await lsp.request('java/buildWorkspace',true,90000),1);
      const completion = async (marker,extra) => {
        const result = await lsp.request('textDocument/completion',{textDocument,
          position:positionOf(probe.text,marker,extra),context:{triggerKind:1}},12000);
        return (result?.items || result || []).map(item => item.label);
      };
      const definition = async marker => {
        const result = await lsp.request('textDocument/definition',{textDocument,
          position:positionOf(probe.text,marker,2)},12000);
        return result?.[0] ? sourceFile(result[0]) : null;
      };
      const latest = (uri,after=0) => lsp.notifications.slice(after).findLast(item => item.method === 'textDocument/publishDiagnostics' &&
        equivalent(fileURLToPath(item.params.uri),fileURLToPath(uri)))?.params.diagnostics;
      const cleanProbe = async (after=0) => until(() => {
        const diagnostics = latest(probe.uri,after);
        return diagnostics && !diagnostics.some(item => item.severity === 1);
      },30000);
      assert.ok(equivalent(await definition('getLabel()'),documents.Profile.file));
      const generated = await until(() => definition('ProfileMapperImpl()'),30000);
      assert.match(generated,/generated-sources[\\/]annotations[\\/].*ProfileMapperImpl\.java$/);
      assert.match(await fs.readFile(generated,'utf8'),/value\.getLabel\(\)/);
      assert.ok((await completion('value.getLabel()',6)).some(label => /getLabel\(\)/.test(label)));
      await until(async () => (await completion('new ProfileMapperImpl()',17)).some(label => /ProfileMapperImpl/.test(label)),30000);
      await cleanProbe();

      function change(document,text) {
        document.text=text;
        lsp.notify('textDocument/didChange',{textDocument:{uri:document.uri,version:++document.version},contentChanges:[{text}]});
      }
      const afterInvalid = lsp.notifications.length, original = probe.text;
      change(probe,original.replace('getLabel()','getMissing()'));
      await until(() => latest(probe.uri,afterInvalid)?.some(item => item.severity === 1 && /getMissing/.test(item.message)),30000);
      change(probe,original);
      const edits = renamedProcessorSources(Object.fromEntries(Object.entries(documents).map(([name,doc]) => [name,doc.text])));
      const afterRename = lsp.notifications.length;
      for (const [name,text] of Object.entries(edits)) {
        const doc = documents[name];
        await fs.writeFile(doc.file,text);
        change(doc,text);
        lsp.notify('textDocument/didSave',{textDocument:{uri:doc.uri},text});
      }
      assert.equal(await lsp.request('java/buildWorkspace',false,90000),1);
      await cleanProbe(afterRename);
      const getterLabels = await completion('value.getAlias()',6);
      assert.ok(getterLabels.some(label => /getAlias\(\)/.test(label)));
      assert.ok(!getterLabels.some(label => /getLabel\(\)/.test(label)));
      assert.ok(equivalent(await definition('getAlias()'),documents.Profile.file));
      assert.match(await fs.readFile(generated,'utf8'),/value\.getAlias\(\)/);
      return {tool,lombokCompletion:true,mapStructCompletion:true,generatedDefinition:true,missingGetterDiagnostic:true,incrementalRename:true};
    } finally { await lsp.close(); }
  }

  const editors = [];
  for (const tool of ['maven','gradle']) editors.push(await editor(tool));
  const receipt = {maven,gradle,editors,lombokVersion:LOMBOK_VERSION,lombokSha256:LOMBOK_SHA256};
  if (process.env.ROCKETBRAIN_PROCESSOR_TEST_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_PROCESSOR_TEST_RECEIPT,JSON.stringify(receipt,null,2)+'\n');
});
