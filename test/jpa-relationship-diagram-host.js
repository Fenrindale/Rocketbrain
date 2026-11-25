'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { pathToFileURL }=require('node:url');
const mysql=require('mysql2/promise');
const { ObserverClient }=require('../src/jpa/observer-client');
const { analyzeJPA }=require('../src/jpa/model');
const { buildDiagram,chooseScope,observedScopes,sourceScope,layoutFor,editLayout }=require('../src/jpa/relationship-diagram');

const person='fixture.boot.Person', department='fixture.boot.Department';
const view='JPA Relationships';
const command='rocketbrain.jpa.relationshipDiagram';

function readConfig() {
  const config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  return {config,token:fs.readFileSync(config.observerTokenFile,'utf8').trim()};
}

function modelFor(config) {
  const directory=path.join(config.sourcePaths[0],'fixture','boot');
  const read=file=>({uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')});
  const files=fs.readdirSync(directory).filter(name=>name.endsWith('.java')).map(name=>read(path.join(directory,name)));
  const mapping=read(path.join(config.projectPath,'src','main','resources','META-INF','orm.xml'));
  return analyzeJPA(files,{mappingFiles:[mapping],physicalNaming:'standard'});
}

function relationship(diagram, from, attribute, to, kind) {
  const value=diagram.edges.find(edge=>edge.fromType===from&&edge.toType===to&&edge.name===attribute);
  assert.ok(value,`No ${from}.${attribute} → ${to} in ${diagram.mode} graph`);
  assert.equal(value.kind,kind);
  return value;
}

async function verify({ config,token }) {
  const client=new ObserverClient({url:config.observerUrl,token});
  let db;
  try {
    let observed,scopes;
    await until(async()=>{
      observed=await client.refresh(); scopes=observedScopes(observed);
      return scopes.length===2;
    },'The optional second Hibernate factory did not start');
    const model=modelFor(config);
    assert.equal(observed.agentVersion,'0.12.0');
    const localPerson=model.entities.find(item=>item.fqn===person);
    const scope=chooseScope(scopes,model,localPerson.uri), snapshot=buildDiagram(model,scope);
    const secondary=scopes.find(item=>item.key!==scope.key);
    assert.equal(snapshot.scope,scope.key);
    assert.equal(secondary.name,'rocketbrain-diagram-secondary');
    assert.notEqual(secondary.identity,scope.identity);
    const alternate=buildDiagram(model,secondary);
    assert.deepEqual(alternate.nodes.map(node=>node.fqn),['fixture.boot.License']);
    assert.equal(alternate.edges.length,0);
    assert.equal(chooseScope(scopes,model,model.entities.find(item=>item.fqn==='fixture.boot.License').uri),null);
    assert.equal(snapshot.sourceRevisionMatched,false);
    assert.equal(snapshot.coverage.excluded,0);
    assert.equal(snapshot.nodes.find(node=>node.fqn===person).table,'rb_spring_person');
    assert.equal(snapshot.nodes.find(node=>node.fqn===department).table,'rb_spring_department');
    assert.ok(relationship(snapshot,person,'department',department,'manyToOne').source);
    assert.equal(relationship(snapshot,department,'people',person,'oneToMany').ownership,'inverse');
    assert.equal(relationship(snapshot,'fixture.boot.CustomRecord','departments',department,'manyToMany').ownership,'owning');
    relationship(snapshot,'fixture.boot.DocumentAsset','extends','fixture.boot.Asset','inheritance');
    assert.equal(snapshot.edges.some(edge=>edge.name==='tags'),false);
    assert.equal(snapshot.unresolved.some(item=>item.entity===department&&item.property==='people'),false);
    const local=buildDiagram(model,sourceScope);
    relationship(local,person,'department',department,'manyToOne');
    relationship(local,'fixture.boot.DocumentAsset','extends','fixture.boot.Asset','inheritance');
    const focused=buildDiagram(model,scope,person);
    assert.equal(focused.nodes[0].fqn,person);
    assert.ok(focused.nodes.some(node=>node.fqn===department));
    assert.ok(focused.coverage.excluded>0);
    const key=focused.nodes[0].id, moved={x:552,y:277};
    const saved=editLayout(focused,{}, {type:'move',id:key,...moved});
    assert.deepEqual(layoutFor(snapshot,saved)[key],{...moved,hidden:false});
    assert.equal((await client.refresh()).factories.find(item=>item.id===scope.key).statistics.prepareStatementCount,scope.factory.statistics.prepareStatementCount);

    const configDb=JSON.parse(fs.readFileSync(config.dbConfigPath,'utf8'));
    db=await mysql.createConnection({host:configDb.host,port:configDb.port,user:configDb.user,password:configDb.password,database:configDb.database});
    const [[{version}]]=await db.query('SELECT VERSION() AS version');
    assert.equal(/mariadb/i.test(version),config.dbEngine==='mariadb');
    const [foreignKeys]=await db.execute(`SELECT TABLE_NAME AS owner, COLUMN_NAME AS field, REFERENCED_TABLE_NAME AS target
      FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
      AND TABLE_NAME IN ('rb_spring_person','rb_v5_record_departments')`);
    assert.ok(foreignKeys.some(key=>key.owner==='rb_spring_person'&&key.field==='department_id'&&key.target==='rb_spring_department'));
    assert.equal(foreignKeys.filter(key=>key.owner==='rb_v5_record_departments').length,2);
    const response=await fetch(config.baseUrl+'/probe',{signal:AbortSignal.timeout(10000)}), probe=await response.json();
    assert.equal(probe.department,'Engineering');
    assert.ok(probe.jpqlCount>0);
    return {engine:config.dbEngine,version,provider:scope.factory.version,entities:snapshot.nodes.length,relationships:snapshot.edges.length,
      inverseCollection:true,owningManyToMany:true,inheritance:true,elementCollectionSeparate:true,automaticUnit:true,secondObservedUnit:true,ambiguousUnitNotMerged:true,
      sourceCandidate:true,focusedGraph:true,mappingSnapshotReadOnly:true,databaseForeignKeysVerified:true,actualSpringQuery:true};
  } finally {client.dispose();await db?.end();}
}

async function until(predicate, message) {
  const end=Date.now()+8000;
  while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,70));}
  throw Error(message);
}

async function runJpaRelationshipDiagramChecks(api,vscode,checks) {
  const fixture=readConfig(), report=await verify(fixture), service=api.jpa.relationshipDiagram;
  const tab=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(item=>item.label===view));
  try {
    await api.jpa.observer.connect({url:fixture.config.observerUrl,token:fixture.token});
    await api.jpa.refresh();
    const candidates=await vscode.workspace.findFiles('**/fixture/boot/Person.java','**/{build,target,test-output}/**',8);
    assert.equal(candidates.length,1);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(candidates[0]));
    const observed=await vscode.commands.executeCommand(command);
    assert.equal(observed?.diagram.mode,'observed');
    const p=observed.diagram.nodes.find(node=>node.fqn===person);
    const edge=relationship(observed.diagram,person,'department',department,'manyToOne');
    assert.ok(edge.source);
    await until(tab,'The JPA Relationships panel did not open');
    await until(()=>service.isRendered(observed.token),'The installed diagram canvas did not render');

    const moved={x:665,y:338};
    const placement=await service.changeLayout(observed.token,{type:'move',id:p.id,...moved});
    assert.deepEqual(placement[p.id],{...moved,hidden:false});
    await service.changeLayout(observed.token,{type:'visibility',id:p.id,hidden:true});
    service.close();
    await until(()=>!tab(),'The JPA Relationships panel did not close');
    const reopened=await vscode.commands.executeCommand(command,{scope:observed.diagram.scope,focus:person});
    assert.deepEqual(reopened.layout[p.id],{...moved,hidden:true});
    await until(()=>service.isRendered(reopened.token),'The reopened diagram canvas did not render');
    const restored=await service.changeLayout(reopened.token,{type:'visibility',id:p.id,hidden:false});
    assert.equal(restored[p.id].hidden,false);
    const source=await service.openSource(reopened.token,edge.id);
    assert.equal(source.uri,edge.source.uri);
    assert.ok(vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(source.uri)));
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(),source.uri);
    assert.match(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),/department/);
    await service.changeLayout(reopened.token,{type:'reset'});
    const secondary=api.jpa.observer.snapshot().factories.find(factory=>factory.factoryName==='rocketbrain-diagram-secondary');
    assert.ok(secondary);
    const separate=await vscode.commands.executeCommand(command,{scope:secondary.id});
    assert.deepEqual(separate?.diagram.nodes.map(node=>node.fqn),['fixture.boot.License']);
    api.jpa.observer.disconnect();
    await until(()=>!tab(),'The observed diagram did not close after disconnection');
    const sourceOnly=await vscode.commands.executeCommand(command,{scope:'source'});
    assert.equal(sourceOnly?.diagram.mode,'source');
    relationship(sourceOnly.diagram,person,'department',department,'manyToOne');
    await until(()=>tab()&&service.isRendered(sourceOnly.token),'The source JPA diagram did not render');
    checks.push('The installed JPA relationship diagram selects the running Hibernate factory, navigates the exact source association, persists moved and hidden entities, and closes on observer disconnect.');
    return {...report,nativeDiagram:true,nativeSourceNavigation:true,nativeLayoutReopen:true,nativeDisconnect:true};
  } finally {service.close();api.jpa.observer.disconnect();}
}

module.exports={runJpaRelationshipDiagramChecks};
if (require.main===module) verify(readConfig()).then(report=>console.log(JSON.stringify({...report,nativeDiagram:false})))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
