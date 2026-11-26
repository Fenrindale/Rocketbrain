'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const mysql = require('mysql2/promise');
const { ObserverClient } = require('../src/jpa/observer-client');
const { comparePersistenceBuild } = require('../src/jpa/persistence-contexts');
const { jdbcReadback } = require('./java-source-analysis-host');

const childType = 'fixture.contextchild.ContextChildRow';
const childId = 'rocketbrain-persistence-child';
const childUnit = 'rocketbrain-child-unit';
const childMarker = 'context-child-fixture-4492';
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const fileUri = file => ({ scheme: 'file', fsPath:file, toString: () => pathToFileURL(file).href });
const classPath = (root,type) => path.join(root,...type.split('.')) + '.class';

async function withContextFixture(run) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  for(const url of [runtime.baseUrl,runtime.observerUrl]) assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/u);
  const dbFile = await fs.realpath(runtime.dbConfigPath);
  const dbFolder = path.dirname(dbFile), owner = await read(path.join(dbFolder,'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(path.basename(dbFolder),owner.id);
  const config = await read(dbFile);
  assert.deepEqual([config.host,config.database],['127.0.0.1','rocketbrain_fixture']);
  const token = (await fs.readFile(runtime.observerTokenFile,'utf8')).trim();
  const connection = await mysql.createConnection(config);
  const jdbc = await jdbcReadback();
  let opened = false;
  async function app(operation) {
    const response = await fetch(runtime.baseUrl + '/probe/persistence-contexts/' + operation, {
      signal:AbortSignal.timeout(15000),redirect:'error'
    });
    assert.equal(response.status,200,operation + ': ' + (response.ok ? '' : await response.text()));
    return response.json();
  }
  try {
    const [[server]] = await connection.query('SELECT @@datadir AS datadir');
    assert.equal(path.relative(dbFolder,path.dirname(await fs.realpath(server.datadir))),'');
    const ids = await app('open');
    opened = true;
    assert.equal(ids.childId,childId);
    assert.notEqual(ids.parentId,ids.childId);
    await connection.execute('INSERT INTO rb_context_child (id,note) VALUES (?,?)',[812548,childMarker]);
    assert.deepEqual(await app('read'),{child:childMarker});
    await connection.execute('DELETE FROM rb_context_child WHERE id=?',[812548]);
    const result = await run({ runtime, token, ids, async close() {
      assert.deepEqual(await app('close'),{closed:true});
      opened = false;
    } });
    assert.deepEqual(await jdbcReadback(),jdbc);
    return { engine:runtime.dbEngine, jdbc, ...result };
  } finally {
    try { if(opened) await app('close'); }
    finally { await connection.end(); }
  }
}

function verifyHierarchy(report, snapshot, ids, token) {
  assert.equal(report.state,'observed',JSON.stringify(report,null,2));
  assert.deepEqual(report.unassignedFactoryIds,[]);
  assert.equal(report.contexts.length,2);
  assert.equal(report.processId,snapshot.processId);
  assert.equal(report.observerExecutedSql,false);
  assert.equal(report.applicationCallbacksInvoked,false);
  const root = report.contexts.find(value => value.id === ids.parentId);
  const child = report.contexts.find(value => value.id === ids.childId);
  assert.ok(root && child);
  assert.equal(root.parentState,'root');
  assert.equal(child.parentState,'observed');
  assert.equal(child.parentKey,root.key);
  assert.equal(root.factories.length,1);
  assert.equal(child.factories.length,1);
  const [parentFactory, childFactory] = [root.factories[0],child.factories[0]];
  assert.equal(parentFactory.beanName,childFactory.beanName);
  assert.equal(childFactory.beanName,'entityManagerFactory');
  assert.notEqual(parentFactory.factoryId,childFactory.factoryId);
  assert.notEqual(parentFactory.persistenceUnit,childFactory.persistenceUnit);
  assert.equal(childFactory.persistenceUnit,childUnit);
  assert.equal(childFactory.build.state,'known',JSON.stringify(childFactory.build));
  assert.deepEqual(childFactory.build.classes.map(value=>value.javaType),[childType]);
  assert.equal(snapshot.factories.find(value=>value.id===childFactory.factoryId).entities[0].javaType,childType);
  assert.ok(snapshot.events.some(value=>value.factoryId===childFactory.factoryId && value.query?.includes('ContextChildRow')));
  assert.ok(!JSON.stringify(report).includes(childMarker));
  assert.ok(!JSON.stringify(report).includes(token));
  return { root,child,parentFactory,childFactory };
}

async function compiledFolder(workspace,source,types) {
  const folder = await fs.mkdtemp(path.join(workspace,'compiled-context-check-'));
  for(const type of types){
    const target = classPath(folder,type);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(classPath(source,type),target);
  }
  return folder;
}

async function verifyRun(fixture, methods, workspace, Uri) {
  const source = path.join(fixture.runtime.projectPath,'build','classes','java','main');
  const snapshot = await methods.refresh();
  const report = await methods.contexts();
  const { root,child,parentFactory,childFactory } = verifyHierarchy(report,snapshot,fixture.ids,fixture.token);
  const fixtureFolder = await compiledFolder(workspace,source,childFactory.build.classes.map(value=>value.javaType));
  try {
    const target = Uri(fixtureFolder);
    const compared = await methods.compare(childFactory,target);
    assert.equal(compared.state,'matched');
    assert.equal(compared.verifiedFingerprint,childFactory.build.fingerprint);
    assert.equal(compared.sameSourceRevisionVerified,false);
    const changed = classPath(fixtureFolder,childType);
    const bytes = await fs.readFile(changed);
    bytes[bytes.length-1] ^= 1;
    await fs.writeFile(changed,bytes);
    const mismatch = await methods.compare(childFactory,target);
    assert.equal(mismatch.state,'different');
    assert.deepEqual(mismatch.classes,[{javaType:childType,state:'different'}]);
    assert.equal(parentFactory.build.state,'known');
    const parentBuild = await comparePersistenceBuild(parentFactory.build,fileUri(source),[{uri:fileUri(fixture.runtime.projectPath)}]);
    assert.equal(parentBuild.state,'matched');
    assert.ok(parentBuild.classes.length>1);
    const current = await methods.refresh();
    for (const id of [parentFactory.factoryId,childFactory.factoryId]) {
      const captured = snapshot.factories.find(value=>value.id===id);
      assert.equal(captured.statistics.enabled,true);
      assert.deepEqual(current.factories.find(value=>value.id===id).statistics,captured.statistics);
    }
    await fixture.close();
    const after = await methods.contexts();
    assert.equal(after.state,'observed',JSON.stringify(after));
    assert.equal(after.contexts.length,1);
    assert.equal(after.contexts[0].key,root.key);
    assert.equal(after.contexts[0].factories[0].factoryId,parentFactory.factoryId);
    assert.ok(!(await methods.refresh()).factories.some(value=>value.id===childFactory.factoryId));
    return { contexts:[{key:root.key,id:root.id},{key:child.key,id:child.id,parentKey:child.parentKey}],
      factories:[{id:parentFactory.factoryId,unit:parentFactory.persistenceUnit},{id:childFactory.factoryId,unit:childFactory.persistenceUnit}],
      sameBeanName:childFactory.beanName, childFingerprint:childFactory.build.fingerprint, compiledComparison:'matched',
      alteredComparison:'different', parentBuildState:parentFactory.build.state, parentCompiledClasses:parentBuild.classes.length, sameStatementCounters:true, childClosed:true };
  } finally {
    const local = path.relative(await fs.realpath(workspace),await fs.realpath(fixtureFolder));
    assert.match(local,/^compiled-context-check-[A-Za-z0-9]+$/u);
    await fs.rm(fixtureFolder,{recursive:true,force:true});
  }
}

async function runSpringPersistenceContextChecks(api,vscode,checks) {
  const workspace = await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
  assert.ok(workspace.split(path.sep).includes('test-output'));
  const observer = api.jpa.observer;
  const proof = await withContextFixture(async fixture => {
    try {
      await observer.connect({url:fixture.runtime.observerUrl,token:fixture.token});
      const methods = {
        refresh:()=>observer.refresh(),
        contexts:()=>vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectPersistenceContexts'),
        async compare(factory,directory) {
          const value = await vscode.commands.executeCommand('rocketbrain.jpa.observer.comparePersistenceBuild',{factoryId:factory.factoryId,directory});
          assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()),JSON.parse(JSON.stringify(value)));
          return value.comparison;
        }
      };
      return await verifyRun(fixture,methods,workspace,vscode.Uri.file);
    } finally { observer.disconnect(); }
  });
  checks.push('Two real Spring contexts reused the same factory bean name with different persistence units and exact native factory ownership. Managed class bytes matched selected build output and a changed byte was detected. Closing the child removed its links.');
  return { ...proof, nativeView:true };
}

if(require.main===module)withContextFixture(async fixture => {
  const client = new ObserverClient({url:fixture.runtime.observerUrl,token:fixture.token});
  try {
    const workspace = fixture.runtime.projectPath, folders = [{uri:fileUri(workspace)}];
    const methods = { refresh:()=>client.refresh(), contexts:()=>client.persistenceContexts(),
      compare:(factory,folder)=>comparePersistenceBuild(factory.build,folder,folders) };
    return await verifyRun(fixture,methods,workspace,fileUri);
  } finally { client.dispose(); }
}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.stack);process.exitCode=1;});

module.exports={runSpringPersistenceContextChecks};
