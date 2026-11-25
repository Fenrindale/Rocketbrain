'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {execute}=require('../src/java/testing/provision');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {classDiagram,visibleClassLayout,mermaidDiagram}=require('../src/java/source-analysis-model');
const {diagramHtml}=require('../src/java/source-diagram-view');
const {springDiagramFixture,springJdbcClasspath,executeSpringDiagram}=require('./helpers/java-diagram-relationship-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,classpathFile=process.env.ROCKETBRAIN_JAVA_UML_CLASSPATH;
const dbFiles=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_JAVA_UML_'+engine.toUpperCase()+'_CONFIG']]);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const item=(directory,name,text)=>({uri:pathToFileURL(path.join(directory,name+'.java')).href,text});
const find=(diagram,from,to,kind)=>diagram.edges.find(edge=>edge.from===from&&edge.to===to&&edge.kind===kind);

async function setup(t) {
  const {javaHome}=await read(javaConfig),parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-java-diagram-relations-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const tool=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  async function graph(sources,classpath=[]) {
    const report=await analyzeJavaSources({javaHome,storagePath:root,sources,classpath,inspection:{kind:'diagram'}});
    assert.deepEqual(report.errors,[]);
    assert.equal(report.processorsEnabled,false);
    return classDiagram(report,sources);
  }
  return {javaHome,root,tool,graph};
}

function selectedText(text,location) {
  const lines=text.split('\n');
  const offset=point=>lines.slice(0,point.line).reduce((size,line)=>size+line.length+1,point.character);
  return text.slice(offset(location.range.start),offset(location.range.end));
}

test('relationship occurrences require exact source spans and separate dependency cycles from the inheritance layout',()=>{
  const source={uri:'file:///owned/A.java',text:'class A { B field; }'};
  const location={uri:source.uri,start:10,end:11};
  const relation={target:'fixture.B',kind:'associates',role:'field',member:'field',signature:'fixture.B',location};
  const shape=(name,relations)=>({id:'fixture.'+name,kind:'CLASS',name,relations,members:[],location});
  const report={declarations:[shape('A',[relation]),shape('B',[{...relation,target:'fixture.A',kind:'uses',role:'call'}])]};
  const graph=classDiagram(report,[source]);
  assert.equal(visibleClassLayout(graph,{focus:'fixture.A'}).edges.length,2);
  assert.equal(visibleClassLayout(graph,{relationships:'structure'}).edges.length,0);
  assert.match(mermaidDiagram(graph),/--> Type\d+ : field type/u);
  assert.match(mermaidDiagram(graph),/\.\.> Type\d+ : method call/u);
  assert.doesNotMatch(mermaidDiagram(graph,{relationships:'associations'}),/method call/u);
  assert.match(diagramHtml(graph,{focus:'fixture.A',relationships:'all'}),/Relationship source links/u);
  report.declarations[0].relations[0].location={...location,end:999};
  assert.throws(()=>classDiagram(report,[source]),/invalid Java source location/u);
});

test('Javac distinguishes an imported sibling-module symbol from a local same-name type with exact member roles',{
  skip:!javaConfig,timeout:90000
},async t=>{
  const {root,tool,graph}=await setup(t),dependency=path.join(root,'dependency-classes'),application=path.join(root,'application-classes');
  await fs.mkdir(dependency);await fs.mkdir(application);
  const external=path.join(root,'Asset.java');
  await fs.writeFile(external,'package inventory.api; public class Asset { public int value(int n) { return n+1; } public int value(String n) { return 0; } }');
  const build=await execute(tool('javac'),['-proc:none','-d',dependency,external],{timeoutMs:20000});
  assert.equal(build.code,0,build.output);
  await fs.mkdir(path.join(root,'local'));
  const localFile=path.join(root,'local','Asset.java'),ownerFile=path.join(root,'Owner.java');
  const local=item(path.dirname(localFile),'Asset','package fixture.graph; class Asset { Owner owner; }');
  const owner=item(root,'Owner',[
    'package fixture.graph;',
    'import inventory.api.Asset;',
    'import java.io.IOException;',
    'import java.util.List;',
    'public class Owner {',
    '    Asset stored, backup;',
    '    List<? extends Asset[]> children;',
    '    fixture.graph.Asset local;',
    '    Owner(Asset item) { stored = item; }',
    '    List<Asset> lookup(fixture.graph.Asset requested) throws IOException { return List.of(new Asset()); }',
    '    public static void main(String[] args) { var item = new Asset(); System.out.print(item.value(41)); }',
    '}',''
  ].join('\n'));
  const result=await graph([local,owner],[dependency]),bindings=find(result,'fixture.graph.Owner','inventory.api.Asset','associates');
  assert.deepEqual(bindings.origins.map(occurrence=>[occurrence.role,occurrence.member,selectedText(owner.text,occurrence.location)]),
    [['field','stored','Asset'],['field','backup','Asset'],['field-argument','children','Asset']]);
  const use=find(result,'fixture.graph.Owner','inventory.api.Asset','uses');
  for(const role of ['parameter','return-argument','construct','call'])assert.ok(use.origins.some(origin=>origin.role===role),role);
  const call=use.origins.find(occurrence=>occurrence.role==='call');
  assert.equal(call.signature,'inventory.api.Asset#value(int)');
  assert.equal(selectedText(owner.text,call.location),'item.value');
  assert.ok(find(result,'fixture.graph.Owner','fixture.graph.Asset','associates'));
  assert.ok(find(result,'fixture.graph.Asset','fixture.graph.Owner','associates'));
  assert.ok(find(result,'fixture.graph.Owner','java.io.IOException','uses').origins.some(origin=>origin.role==='throws'));
  assert.equal(result.nodes.find(node=>node.id==='inventory.api.Asset').external,true);
  assert.equal(result.nodes.find(node=>node.id==='fixture.graph.Asset').external,false);
  const layout=visibleClassLayout(result,{focus:'fixture.graph.Owner',external:true});
  assert.ok(layout.nodes.some(node=>node.id==='inventory.api.Asset'));
  await fs.writeFile(localFile,local.text);await fs.writeFile(ownerFile,owner.text);
  const joined=await execute(tool('javac'),['-proc:none','-cp',dependency,'-d',application,localFile,ownerFile],{timeoutMs:20000});
  assert.equal(joined.code,0,joined.output);
  const ran=await execute(tool('java'),['-cp',[application,dependency].join(path.delimiter),'fixture.graph.Owner'],{timeoutMs:20000});
  assert.equal(ran.code,0,ran.output);assert.equal(ran.output,'42');
});

test('an imported type change refreshes Spring member associations while the actual JDBC program still runs on both engines',{
  skip:!javaConfig||!classpathFile||!dbFiles.every(([,file])=>file),timeout:135000
},async t=>{
  const {javaHome,root,graph}=await setup(t),name='DiagramProbe',namespace='fixture',from=namespace+'.'+name,results=[];
  const file=path.join(root,name+'.java');
  const before=springDiagramFixture(namespace,name),after=springDiagramFixture(namespace,name,{alternate:true});
  for(const [engine,configFile] of dbFiles){
    const classpath=await springJdbcClasspath(classpathFile,engine),config=await read(configFile);
    const original=await graph([item(root,name,before)],classpath),updated=await graph([item(root,name,after)],classpath);
    const oldType=find(original,from,'java.sql.Date','associates'),newType=find(updated,from,'java.util.Date','associates');
    assert.ok(oldType.origins.some(origin=>origin.member==='lastResult'&&origin.role==='field'));
    assert.equal(find(updated,from,'java.sql.Date','associates'),undefined);
    assert.ok(newType.origins.some(origin=>origin.member==='lastResult'&&origin.role==='field'));
    assert.equal(selectedText(after,newType.origins.find(origin=>origin.member==='lastResult').location),'Date');
    const spring=find(updated,from,'org.springframework.jdbc.core.JdbcTemplate','uses');
    assert.ok(spring.origins.some(origin=>origin.role==='call'&&origin.signature.includes('#queryForObject(')));
    const outputs=[];
    for(const text of [before,after]){
      const binaryDirectory=await fs.mkdtemp(path.join(root,'classes-'));
      await fs.writeFile(file,text);
      const actual=await executeSpringDiagram({javaHome,file,binaryDirectory,className:from,classpath,engine,config});
      assert.equal(actual.output,'42');outputs.push(actual);
    }
    assert.deepEqual(outputs[1],outputs[0]);
    results.push({...outputs[1],fieldBefore:'java.sql.Date',fieldAfter:'java.util.Date',jdbcMethodBound:true});
  }
  if(process.env.ROCKETBRAIN_JAVA_UML_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_JAVA_UML_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',springJdbc:'7.0.10',results})+'\n');
});
