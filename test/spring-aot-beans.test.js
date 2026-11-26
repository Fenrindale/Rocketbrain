'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../src/java/testing/provision');
const { compareAotBeans, inspectAotBeans } = require('../src/spring/aot-beans');
const { registerSpringAot } = require('../src/spring/aot-vscode');

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleCache = process.env.ROCKETBRAIN_AOT_GRADLE_CACHE;
const fixtures = ['mysql','mariadb'].map(engine => [engine,process.env['ROCKETBRAIN_AOT_' + engine.toUpperCase() + '_CONFIG']]);
const sourceFixture = path.join(__dirname,'fixtures/java/spring-aot-beans');
const registrationFile = 'build/generated/aotSources/fixture/AotProbe__BeanFactoryRegistrations.java';
const runReady = javaConfig && gradleCache && fixtures.every(([,file])=>file);
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));

test('Spring AOT compares two captured literal bean registries and preserves source identity', () => {
  const base = { project:'/project', artifact:'/project/BeanFactory.java', unresolved:[],sha256:'before',
    entries:[{ name:'removed',type:'fixture.Old',aliases:[] }, { name:'kept',type:'fixture.Kept',aliases:['oldAlias'] }] };
  const after = { ...base,sha256:'after',
    entries:[{ name:'added',type:'fixture.New',aliases:[] }, { name:'kept',type:'fixture.Kept',aliases:['newAlias'] }] };
  const result = compareAotBeans(base,after);
  assert.deepEqual(result,{ beforeSha256:'before',afterSha256:'after',added:['added'],removed:['removed'],changed:['kept'] });
  assert.throws(()=>compareAotBeans(base,{ ...after,artifact:'/project/OtherFactory.java' }),/same Spring AOT/u);
  assert.throws(()=>compareAotBeans(base,{ ...after,unresolved:[{}] }),/Unresolved generated/u);
});

test('Spring Boot AOT reflects generated conditional beans and uses real database credentials only at run time', {
  skip:!runReady,timeout:350000
}, async context => {
  const parent = await fs.realpath(os.tmpdir());
  const project = await fs.mkdtemp(path.join(parent,'rb-aot-beans-'));
  const identity = await fs.lstat(project,{bigint:true});
  const runtime = await read(javaConfig);
  const lib = path.join(runtime.gradleHome,'lib');
  const launchers = (await fs.readdir(lib)).filter(name=>/^gradle-launcher-[\d.]+\.jar$/u.test(name));
  assert.equal(launchers.length,1);
  const java = path.join(runtime.javaHome,'bin',process.platform === 'win32' ? 'java.exe' : 'java');
  const artifact = path.join(project,registrationFile);
  const jar = path.join(project,'build/libs/rocketbrain-spring-aot-beans-1.0.0.jar');
  const databases = await Promise.all(fixtures.map(async ([engine,file]) => [engine,await read(file)]));
  const vscode = {
    Uri:{file:fsPath=>({scheme:'file',fsPath}),parse:uri=>new URL(uri)},
    Range:class {constructor(...points){this.points=points;}},
    workspace:{isTrusted:true,getWorkspaceFolder:()=>({uri:{fsPath:project}}),
      registerTextDocumentContentProvider:()=>({dispose(){}}),
      openTextDocument:async uri=>({uri,isDirty:false,getText:()=>loaded.get(uri.fsPath)})},
    window:{showTextDocument:async (document,options)=>({document,options})},
    commands:{registerCommand:()=>({dispose(){}})}
  };
  const aot = registerSpringAot(vscode);
  const loaded = new Map();
  context.after(async () => {
    aot.dispose();
    const real = await fs.realpath(project), current = await fs.lstat(real,{bigint:true});
    assert.equal(path.relative(project,real),'');
    assert.equal(path.relative(parent,path.dirname(real)),'');
    assert.match(path.basename(real),/^rb-aot-beans-/u);
    assert.deepEqual([current.dev,current.ino],[identity.dev,identity.ino]);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await fs.cp(sourceFixture,project,{recursive:true});

  async function build(feature) {
    const result = await execute(java,['-Dorg.gradle.java.home=' + runtime.javaHome,'-cp',path.join(lib,launchers[0]),
      'org.gradle.launcher.GradleMain','--no-daemon','--offline','--gradle-user-home',gradleCache,'bootJar'],
      { cwd:project,env:{...process.env,JAVA_HOME:runtime.javaHome,ROCKETBRAIN_AOT_FEATURE:feature},
        timeoutMs:140000 });
    assert.equal(result.code,0,result.output);
    assert.match(result.output,/> Task :processAot/u);
    return aot.capture({projectUri:vscode.Uri.file(project),artifactUri:vscode.Uri.file(artifact)});
  }

  async function runBoth(runtimeFeature) {
    return Promise.all(databases.map(async ([engine,config]) => {
      assert.equal(config.host,'127.0.0.1');
      const driver = engine === 'mysql' ? 'mysql' : 'mariadb';
      const url = 'jdbc:' + driver + '://127.0.0.1:' + config.port + '/' + config.database +
        (engine === 'mysql' ? '?sslMode=DISABLED&allowPublicKeyRetrieval=true' : '?sslMode=disable');
      const result = await execute(java,['-Dspring.aot.enabled=true','-jar',jar],{
        cwd:project,timeoutMs:40000,env:{...process.env,ROCKETBRAIN_AOT_FEATURE:runtimeFeature,
          ROCKETBRAIN_AOT_DB_URL:url,ROCKETBRAIN_AOT_DB_USER:config.user,ROCKETBRAIN_AOT_DB_PASSWORD:config.password}
      });
      assert.equal(result.code,0,result.output);
      const proof = /^rocketbrain-aot-proof:([^\r\n]+)\|42\|fixed\|(true|false)\s*$/mu.exec(result.output);
      assert.ok(proof,result.output);
      assert.match(proof[1],engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*-MariaDB/u);
      return { engine,version:proof[1],value:42,alias:'fixed',activeProbe:proof[2] === 'true' };
    }));
  }

  const before = await build('enabled');
  assert.equal(before.unresolved.length,0);
  assert.equal(before.executedProjectCode,false);
  const feature = before.entries.find(entry=>entry.name==='activeProbe');
  assert.equal(feature.type,'java.lang.Integer');
  assert.equal(feature.factory.owner,'fixture.AotProbe');
  assert.equal(feature.factory.method,'activeProbe');
  assert.ok(feature.factory.source);
  assert.deepEqual(before.entries.find(entry=>entry.name==='fixedProbe').aliases,['fixedAlias']);
  loaded.set(feature.factory.source.file,await fs.readFile(feature.factory.source.file,'utf8'));
  const editor = await aot.open({id:before.id,name:'activeProbe',which:'factory'});
  const [line,from,_,to] = editor.options.selection.points;
  assert.equal(loaded.get(feature.factory.source.file).split(/\r?\n/u)[line].slice(from,to),'activeProbe');
  const a = await runBoth('off');
  assert.ok(a.every(row=>row.activeProbe));

  const after = await build('off');
  assert.equal(after.previousId,before.id);
  const diff = aot.compare({beforeId:before.id,afterId:after.id});
  assert.deepEqual([diff.added,diff.removed,diff.changed],[[],['activeProbe'],[]]);
  assert.deepEqual([diff.beforeSha256,diff.afterSha256],[before.manifestSha256,after.manifestSha256]);
  assert.notEqual(diff.beforeSha256,diff.afterSha256);
  await assert.rejects(aot.open({id:before.id,name:'activeProbe'}),/source changed/u);
  const b = await runBoth('enabled');
  assert.ok(b.every(row=>!row.activeProbe));
  assert.deepEqual(a.map(({activeProbe,...row})=>row),b.map(({activeProbe,...row})=>row));

  const text = await fs.readFile(artifact,'utf8');
  await fs.writeFile(artifact,text.replace('    beanFactory.registerAlias', '    if (externalCondition()) beanFactory.registerAlias'));
  const unrecognized = inspectAotBeans(project,artifact);
  assert.ok(unrecognized.unresolved.some(row=>row.method==='registerAliases'));
  assert.throws(()=>compareAotBeans(after,unrecognized),/Unresolved generated/u);
  if (process.env.ROCKETBRAIN_AOT_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_AOT_RECEIPT,JSON.stringify({
    enabledAtBuild:a,disabledAtBuild:b,registrationSha256:[before.sha256,after.sha256],
    manifestSha256:[before.manifestSha256,after.manifestSha256],
    diff:{added:diff.added,removed:diff.removed,changed:diff.changed},factorySourceOpened:true,
    aliasResolved:true,staleNavigationRefused:true,ambiguousOutputComparisonRefused:true,inspectionExecutedProjectCode:false
  },null,2)+'\n',{flag:'wx'});
});
