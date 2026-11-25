'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {fileURLToPath,pathToFileURL}=require('node:url');
const {execute}=require('../src/java/testing/provision');
const {observeAttributedSources,attributedLayers}=require('../src/java/dependency-attribution');
const {analyzeDependencyGraph}=require('../src/java/dependency-graph');
const {workspaceDependencyGraph,verifyDependencyLink}=require('../src/java/dependency-workspace');
const {tool,cyclicMaven,gradleSpring,buildRecords,task,springJdbcClasspath}=require('./helpers/java-attributed-dependency-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,mavenHome=process.env.ROCKETBRAIN_ATTRIBUTED_MAVEN_HOME;
const gradleHome=process.env.ROCKETBRAIN_ATTRIBUTED_GRADLE_HOME,classpathFile=process.env.ROCKETBRAIN_ATTRIBUTED_DEPENDENCY_CLASSPATH;
const dbs=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_ATTRIBUTED_DEPENDENCY_'+engine.toUpperCase()+'_CONFIG']]);
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const layer=(report,name)=>report.layers.find(value=>value.name===name);
const names=(graph,cycle)=>cycle.members.map(id=>graph.nodes.find(node=>node.id===id).label).sort();

async function setup(t) {
  const parent=await fs.realpath(os.tmpdir()), root=await fs.mkdtemp(path.join(parent,'rb-attributed-deps-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:7,retryDelay:250});
  });
  const {javaHome}=await read(javaConfig);
  return {root,javaHome,storagePath:path.join(root,'compiler-storage')};
}

function rangeText(link,text) {
  const lines=text.split('\n');
  const offset=point=>lines.slice(0,point.line).reduce((sum,line)=>sum+line.length+1,point.character);
  return text.slice(offset(link.range.start),offset(link.range.end));
}

function scopedWorkspace(fixture,javaHome) {
  const uri=file=>({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});
  const folder={uri:uri(fixture.root),name:'owned fixture'};
  const workspace={isTrusted:true,workspaceFolders:[folder],textDocuments:[],getWorkspaceFolder:()=>folder,
    findFiles:async pattern=>{
      assert.equal(pattern.base,folder.uri);
      return (pattern.glob==='**/*.java'?fixture.files:fixture.descriptors).map(file=>uri(file.path));
    }};
  const vscode={workspace,Uri:{parse:value=>uri(fileURLToPath(value))},
    RelativePattern:class {constructor(base,glob){this.base=base;this.glob=glob;}}};
  const java={getState:()=>({javaHome}),workbench:{getSnapshot:()=>({projects:[]})}};
  return {vscode,java};
}

test('attributed layer refuses forged references and keeps observed build output distinct from source edges',()=>{
  const first={uri:'file:///first.java',text:'actual',projectId:'a',projectLabel:'a',sourceSet:'main'};
  const second={uri:'file:///second.java',text:'class B',projectId:'b',projectLabel:'b',sourceSet:'main'};
  const projects=[{id:'a',label:'a',imported:{id:'jdt-a',libraries:[{projectDependency:{id:'jdt-b',output:'observed-output'}}]}},
    {id:'b',label:'b',imported:{id:'jdt-b'}}];
  const references=[{uri:first.uri,targetUri:second.uri,start:0,end:6,packageName:'first',targetPackage:'second',
    targetType:'second.B',symbol:'second.B#parse(int)',kind:'method call',declaration:0}];
  const result=attributedLayers([first,second],projects,[],{references,omitted:0});
  const edge=layer(result,'Javac project references').edges[0];
  assert.deepEqual(edge.observedBuildOutputs,['observed-output']);
  assert.deepEqual(edge.buildDeclarations,[]);
  assert.equal(edge.evidence[0].target.symbol,'second.B');
  references[0].end=999;
  assert.throws(()=>attributedLayers([first,second],projects,[],{references,omitted:0}),/Invalid compiler dependency/u);
});

test('real Javac binds package and project uses without imports and Maven independently rejects the declared reactor cycle',{
  skip:!javaConfig||!mavenHome,timeout:120000
},async t=>{
  const environment=await setup(t), fixture=await cyclicMaven(environment.root), model=buildRecords(fixture);
  const result=await observeAttributedSources({...environment,...model,files:fixture.files});
  assert.equal(result.summary.state,'attributed',JSON.stringify(result.notes));
  assert.equal(result.compiler.processorsEnabled,false);
  assert.equal(result.summary.buildExecuted,false);
  const modules=layer(result,'Javac project references'), packages=layer(result,'Javac package references');
  assert.deepEqual(names(modules,modules.cycles[0]),['left','right']);
  assert.deepEqual(names(packages,packages.cycles[0]),['rb.left','rb.right']);
  assert.equal(modules.nodes.some(node=>node.label==='idle'),false);
  const left=modules.nodes.find(node=>node.label==='left'),edge=modules.edges.find(item=>item.from===left.id);
  const witness=edge.evidence.find(item=>item.kind==='method call');
  assert.equal(witness.symbol,'rb.right.Right#pick(int)');
  assert.equal(rangeText(witness,fixture.left.text),'rb.right.Right.pick');
  assert.equal(witness.target.uri,fixture.right.uri);
  assert.ok(edge.evidence.some(item=>item.kind==='method reference'&&item.symbol==='rb.right.Right#pick(int)'));
  assert.ok(edge.evidence.some(item=>item.kind==='field reference'&&item.symbol==='rb.right.Right#VALUE'));
  assert.ok(edge.evidence.some(item=>item.kind==='constructor call'));
  assert.ok(edge.evidence.some(item=>item.symbol==='rb.right.Right.Marker'));
  assert.equal(edge.buildDeclarations[0].kind,'Maven compile');
  const direct=analyzeDependencyGraph({...model,files:fixture.files});
  assert.deepEqual(names(layer(direct,'Maven reactor modules'),layer(direct,'Maven reactor modules').cycles[0]),['left','right']);
  const build=await task(fixture,{...environment,mavenHome},'maven',['validate']);
  assert.notEqual(build.code,0,build.output);
  assert.match(build.output,/cycle|cyclic/iu);
  const classes=path.join(environment.root,'actual-classes');
  await fs.mkdir(classes);
  const compiled=await execute(tool(environment.javaHome,'javac'),['-proc:none','-d',classes,...fixture.files.map(file=>file.path)],{timeoutMs:25000});
  assert.equal(compiled.code,0,compiled.output);
  const ran=await execute(tool(environment.javaHome,'java'),['-cp',classes,'rb.left.Left'],{timeoutMs:25000});
  assert.deepEqual([ran.code,ran.output],[0,'42']);
  const broken=fixture.files.map(file=>file.uri===fixture.left.uri?{...file,text:file.text.replace('Right.pick(41)','Right.missing(41)')}:file);
  const unresolved=await observeAttributedSources({...environment,...model,files:broken});
  assert.equal(unresolved.summary.state,'compiler-errors');
  assert.equal(unresolved.layers.length,0);
  assert.ok(unresolved.notes.some(note=>note.uri===fixture.left.uri&&note.range));
  const {vscode,java}=scopedWorkspace(fixture,environment.javaHome);
  const scoped=await workspaceDependencyGraph(vscode,java,{attributeSources:true,storagePath:environment.storagePath});
  const link=layer(scoped,'Javac project references').edges.find(item=>item.from===left.id).evidence.find(item=>item.kind==='method call');
  assert.equal((await verifyDependencyLink(vscode,java,scoped,link)).reference.symbol,'rb.right.Right#pick(int)');
  await assert.rejects(verifyDependencyLink(vscode,java,{...scoped},link),/current scoped Java dependency report/u);
  await fs.writeFile(fixture.right.path,fixture.right.text.replace('rb.left.Left.class','String.class'));
  await assert.rejects(verifyDependencyLink(vscode,java,scoped,link),/reviewed Java source or build descriptor changed/u);
  if(process.env.ROCKETBRAIN_ATTRIBUTED_MAVEN_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_ATTRIBUTED_MAVEN_RECEIPT,
    JSON.stringify({java:'Temurin 25.0.5+8',maven:'3.9.11',sourceCycle:['left','right'],buildCycleRefused:true,sourceOutput:42,
      exactOverload:witness.symbol,unresolvedCompilerSeparate:true})+'\n');
});

test('actual Gradle builds a Spring project with the attributed module link and runs its classes on both databases',{
  skip:!javaConfig||!gradleHome||!classpathFile||!dbs.every(([,file])=>file),timeout:235000
},async t=>{
  const environment=await setup(t);
  const classpath=[...new Set((await Promise.all(dbs.map(([engine])=>springJdbcClasspath(classpathFile,engine)))).flat())];
  const fixture=await gradleSpring(environment.root,classpath), model=buildRecords(fixture);
  const result=await task(fixture,{...environment,gradleHome},'gradle',[':app:classes',':app:observedCompileClasspath']);
  assert.equal(result.code,0,result.output);
  const observed=result.output.split(/\r?\n/u).flatMap(line=>line.startsWith('RB_DEP_CP|')?[line.slice(10)]:[]);
  assert.ok(observed.some(file=>!path.relative(file,fixture.output('kernel'))),JSON.stringify(observed));
  const app=model.projects.find(item=>item.label==='app'), kernel=model.projects.find(item=>item.label==='kernel');
  kernel.imported={id:'owned-kernel',libraries:[]};
  app.imported={id:'owned-app',libraries:observed.map(file=>({kind:'classpath',path:file,
    ...(!path.relative(file,fixture.output('kernel'))&&{projectDependency:{id:kernel.imported.id,output:file}})}))};
  const source=await observeAttributedSources({...environment,...model,files:fixture.files});
  assert.equal(source.summary.state,'attributed',JSON.stringify(source.notes));
  const project=layer(source,'Javac project references'), edge=project.edges.find(item=>item.from===app.id&&item.to===kernel.id);
  assert.ok(edge.evidence.some(item=>item.kind==='method reference'&&item.symbol==='rb.kernel.Adjuster#apply(int)'));
  assert.equal(edge.buildDeclarations[0].kind,'Gradle implementation');
  assert.deepEqual(edge.observedBuildOutputs,[fixture.output('kernel')]);
  assert.equal(project.cycles.length,0);
  await fs.access(path.join(fixture.output('app'),'rb','app','Probe.class'));
  const runResults=[];
  for(const [engine,file] of dbs){
    const config=await read(file);
    assert.equal(config.host,'127.0.0.1');assert.ok(Number.isInteger(config.port)&&config.port>0&&config.port<65536);
    assert.match(config.database,/^[a-z_]+$/u);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/iu.test(key)));
    env.RB_DEP_JDBC_URL='jdbc:'+engine+'://127.0.0.1:'+config.port+'/'+config.database+
      (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
    env.RB_DEP_JDBC_USER=config.user;env.RB_DEP_JDBC_PASSWORD=config.password;
    const ran=await execute(tool(environment.javaHome,'java'),['-cp',[fixture.output('app'),...observed].join(path.delimiter),'rb.app.Probe'],
      {env,timeoutMs:25000});
    assert.equal(ran.code,0,ran.output);
    const [server,value]=ran.output.split('|');
    assert.match(server,engine==='mysql'?/^8\.4\./u:/^11\.4\..*MariaDB/u);
    assert.equal(value,'42');
    runResults.push({engine,server,value:42});
  }
  if(process.env.ROCKETBRAIN_ATTRIBUTED_DEPENDENCY_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_ATTRIBUTED_DEPENDENCY_RECEIPT,
    JSON.stringify({java:'Temurin 25.0.5+8',gradle:'9.1.0',springJdbc:'7.0.10',gradleCompiled:true,
      observedOutputEdge:true,sourceBinding:'rb.kernel.Adjuster#apply(int)',results:runResults})+'\n');
});
