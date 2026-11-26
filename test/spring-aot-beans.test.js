'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const { compareAotBeans, inspectAotBeans } = require('../src/spring/aot-beans');
const { registerSpringAot } = require('../src/spring/aot-vscode');
const { createAotFixture, read } = require('./helpers/spring-aot-fixture');

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleCache = process.env.ROCKETBRAIN_AOT_GRADLE_CACHE;
const fixtures = ['mysql','mariadb'].map(engine => [engine,process.env['ROCKETBRAIN_AOT_' + engine.toUpperCase() + '_CONFIG']]);
const runReady = javaConfig && gradleCache && fixtures.every(([,file])=>file);

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
  const fixture = await createAotFixture({parent:os.tmpdir(),javaConfig,gradleCache});
  context.after(fixture.dispose);
  const {project,artifact} = fixture;
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
  context.after(()=>aot.dispose());

  async function build(feature) {
    await fixture.build(feature);
    return aot.capture({projectUri:vscode.Uri.file(project),artifactUri:vscode.Uri.file(artifact)});
  }

  async function runBoth(runtimeFeature) {
    return Promise.all(databases.map(([engine,config]) => fixture.run(engine,config,runtimeFeature)));
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
