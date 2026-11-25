'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {analyzeJPA,definitionsAt,completionsAt} = require('../src/jpa/model');
const {providerProfileFromSnapshot} = require('../src/jpa/provider');
const {ObserverClient} = require('../src/jpa/observer-client');
const {readConfig} = require('./jpql-console-host');

const named = {':minimum':'1'};
const specs = [
  {name:'chained-cte',keys:[':ceiling',':minimum'],values:{...named,':ceiling':'2'},types:['Long','String'],rows:[['1','Alex'],['2','Mina']],limit:1},
  {name:'derived',keys:['?1'],values:{'?1':'1'},types:['Long','String'],rows:[['1','Alex'],['2','Mina']]},
  {name:'union',keys:[':minimum'],values:named,types:['String'],rows:[['Alex'],['Mina'],['Engineering']],unordered:true},
  {name:'union-all',keys:[':minimum'],values:named,types:['String'],rows:[['Alex'],['Mina'],['Alex'],['Mina']],unordered:true},
  {name:'intersect',keys:[':maximum',':minimum'],values:{...named,':maximum':'1'},types:['String'],rows:[['Alex']]},
  {name:'except',keys:[':excluded',':minimum'],values:{...named,':excluded':'2'},types:['String'],rows:[['Alex']]},
  {name:'cte-with-union',keys:[':minimum'],values:named,types:['String'],rows:[['Alex'],['Engineering'],['Mina']]}
];

const fixtureName='HqlConsoleExamples.java';
const aliasUsage=content=>content.indexOf('r.label')+'r.la'.length;
const aliasDeclaration=content=>content.indexOf('as label')+'as '.length;

function javaFiles(directory){
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()) return javaFiles(file);
    return entry.isFile()&&entry.name.endsWith('.java')?[{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')}]:[];
  });
}

function sourceModel(config,snapshot,factory){
  const sourceRoot=path.join(config.projectPath,'src','main','java');
  const profile=providerProfileFromSnapshot(snapshot,factory);
  assert.equal(profile?.enabled,true);
  return analyzeJPA(javaFiles(sourceRoot),{basePackages:['fixture.boot'],providerProfile:profile});
}

function sourceQueries(model){
  const file=model.files.find(item=>item.uri.endsWith('/'+fixtureName));
  assert.ok(file);
  const sources=model.queries.filter(item=>item.uri===file.uri);
  assert.equal(sources.length,specs.length);
  for(const [index,query] of sources.entries()){
    const spec=specs[index];
    assert.equal(query.status,'known',spec.name+' '+query.reason);
    assert.equal(query.typeAnalysis.state,'known',spec.name+' '+query.typeAnalysis.coverage.unknown.join('; '));
    assert.deepEqual(query.typeAnalysis.selectionTypes.map(item=>item.javaType),spec.types.map(type=>'java.lang.'+type));
    assert.deepEqual(query.typeAnalysis.parameters.map(item=>item.key).sort(),spec.keys);
    assert.ok(query.typeAnalysis.parameters.every(item=>item.expectedTypes.some(type=>type.javaType==='java.lang.Long')));
    assert.equal(query.typeAnalysis.validityVerified,false);
  }
  const usage=aliasUsage(file.text), expected=aliasDeclaration(file.text);
  const declaration=definitionsAt(model,file.uri,usage).find(item=>item.uri===file.uri);
  assert.equal(declaration?.range.start.line,file.text.slice(0,expected).split('\n').length-1);
  assert.equal(declaration?.range.start.character,file.text.slice(0,expected).split('\n').at(-1).length);
  assert.ok(completionsAt(model,file.uri,usage).some(item=>item.label==='label'));
  return {file,sources};
}

async function runtimeGraphs(client,config){
  const before=await client.refresh();
  const factory=before.factories.find(item=>item.entities.some(entity=>entity.javaType==='fixture.boot.Person'));
  assert.ok(factory);
  assert.equal(before.consoleSelectEnabled,true);
  const prepared=sourceQueries(sourceModel(config,before,factory.id));
  const findings=[];
  for(const [index,graph] of prepared.sources.entries()){
    const spec=specs[index], description=await client.describeSelect(graph.text,factory.id);
    assert.equal(description.state,'described',spec.name+' '+JSON.stringify(description));
    assert.deepEqual(description.columns.map(item=>item.javaType),spec.types.map(type=>'java.lang.'+type));
    assert.deepEqual(description.parameters.map(item=>item.key),spec.keys);
    assert.ok(description.parameters.every(item=>item.javaType==='java.lang.Long'));
    const result=await client.select(graph.text,factory.id,spec.values,10);
    assert.equal(result.state,'executed',spec.name+' '+JSON.stringify(result));
    assert.deepEqual(result.columns,description.columns);
    assert.deepEqual(spec.unordered?result.rows.toSorted():result.rows,spec.unordered?spec.rows.toSorted():spec.rows);
    assert.ok(result.databaseReadOnlyTransaction && result.rolledBack);
    assert.equal(result.boundParameterValuesRetained,false);
    if(spec.limit){
      const sample=await client.select(graph.text,factory.id,spec.values,spec.limit);
      assert.deepEqual(sample.rows,spec.rows.slice(0,spec.limit));
      assert.equal(sample.hasMore,true);
    }
    findings.push({kind:spec.name,rows:result.rowCount,parameters:description.parameters.length});
  }
  const failed = [
    ['select p.id from Person p union select p.displayName from Person p','provider_validation_failed'],
    ['with owners as (select o.id as id from owners o) select o.id from owners o','unsupported_select_shape'],
    ['with owners as (select p.id as id from Person p) update Person p set p.displayName = :ignored','unsupported_select_shape'],
    ['select p.id from Person p union select rb_upper(p.displayName) from Person p','unsupported_select_shape'],
    ['select p.id from Person p where p.id in (select k.id from Person k union select q.id from Person q)','unsupported_select_shape']
  ];
  const counter=(await client.refresh()).factories.find(item=>item.id===factory.id).statistics;
  assert.equal(counter.enabled,true);
  for(const [query,code] of failed){
    assert.deepEqual(await client.describeSelect(query,factory.id),{state:'rejected',code},query);
    assert.deepEqual(await client.select(query,factory.id,{}),{state:'rejected',code},query);
  }
  const after=await client.refresh();
  const rejectedCounter=after.factories.find(item=>item.id===factory.id).statistics;
  assert.equal(rejectedCounter.prepareStatementCount,counter.prepareStatementCount);
  assert.equal(rejectedCounter.queryExecutionCount,counter.queryExecutionCount);
  assert.equal(after.events.some(item=>prepared.sources.some(query=>query.text===item.query)),false);
  const health=await fetch(config.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000),redirect:'error'});
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{people:2,departments:1,rolledBackNames:0});
  return {prepare:prepared,factory,report:{engine:config.dbEngine,providerVersion:factory.version,
    graphResults:findings,typedSourceQueries:prepared.sources.length,negativeCases:failed.length,
    rejectedSqlPrepared:false,readOnlyAll:true,exactAliasNavigation:true}};
}

async function runHqlConsoleGraphChecks(api,vscode,checks){
  const {config,token}=readConfig(), client=new ObserverClient({url:config.observerUrl,token,timeoutMs:15000});
  try {
    const {factory,report}=await runtimeGraphs(client,config);
    await api.jpa.observer.connect({url:config.observerUrl,token,timeoutMs:15000});
    const nativeSources=sourceQueries(await api.jpa.refresh());
    const uri=vscode.Uri.parse(nativeSources.file.uri);
    const document=await vscode.workspace.openTextDocument(uri);
    const text=document.getText(), cursor=document.positionAt(aliasUsage(text));
    const expected=document.positionAt(aliasDeclaration(text));
    const definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',uri,cursor);
    assert.ok(definitions.some(item=>{
      const target=item.uri||item.targetUri, range=item.range||item.targetSelectionRange;
      return target.toString()===uri.toString() && range.start.line===expected.line && range.start.character===expected.character;
    }));
    const result=await vscode.commands.executeCommand('rocketbrain.jpa.console.run',{
      approved:true,query:nativeSources.sources[0].text,factoryId:factory.id,values:specs[0].values,limit:1
    });
    assert.equal(result?.view,'rocketbrain.jpql.result');
    assert.deepEqual(result.rows,[['1','Alex']]);
    assert.equal(result.hasMore,true);
    const opened=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label==='JPQL Results'));
    const deadline=Date.now()+3000;
    while(!opened()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(opened());
    checks.push('The installed Hibernate console executes typed CTE, derived, UNION, INTERSECT and EXCEPT selections and navigates a CTE field to its projected Java source alias.');
    return {...report,nativeView:true};
  }finally{client.dispose();api.jpa.observer.disconnect();}
}

async function backend(){
  const {config,token}=readConfig(), client=new ObserverClient({url:config.observerUrl,token,timeoutMs:15000});
  try { return {...(await runtimeGraphs(client,config)).report,nativeView:false}; }
  finally { client.dispose(); }
}

module.exports={runHqlConsoleGraphChecks};
if(require.main===module)backend().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});
