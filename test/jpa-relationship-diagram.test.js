'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const vm=require('node:vm');
const { analyzeJPA }=require('../src/jpa/model');
const { buildDiagram,chooseScope,observedScopes,sourceScope,layoutFor,editLayout,MAX_POSITION,NODE_LIMIT }=require('../src/jpa/relationship-diagram');
const { registerRelationshipDiagram }=require('../src/jpa/relationship-diagram-vscode');
const { diagramHtml }=require('../src/jpa/relationship-diagram-view');

const files=['A','B','C'].map(name=>({uri:`file:///fixture/${name}.java`,text:`package fixture; import jakarta.persistence.*; import java.util.List;
@Entity class ${name}${name==='C'?' extends B':''} { ${name==='C'?'':'@Id Long id;'} ${name==='A'?'@OneToMany(mappedBy="owner") List<B> items;':''}
${name==='B'?'@ManyToOne A owner; @OneToOne B linked; @ManyToOne External unresolved;':''} }`}));
const model=analyzeJPA(files);
const entity=(name,attributes=[],extra={})=>({name,javaType:'fixture.'+name,table:name.toLowerCase(),attributes,...extra});
const factory=(id,name,entities)=>({id,provider:'hibernate',version:'7.4.13.Final',state:'observed',factoryName:name,entities});
const attribute=(name,kind,target,collection=false,extra={})=>({name,kind,association:true,collection,
  javaType:collection?'java.util.List':'fixture.'+target, targetEntityJavaType:'fixture.'+target,...extra});
const a=entity('A',[attribute('items','ONE_TO_MANY','B',true,{inverse:true})]);
const b=entity('B',[attribute('owner','MANY_TO_ONE','A'),attribute('linked','ONE_TO_ONE','B')]);
const c=entity('C',[attribute('owner','MANY_TO_ONE','A',false,{declaredIn:'fixture.B'})],{superEntityJavaType:'fixture.B'});
const primary=factory('factory-1','application',[a,b,c]), secondary=factory('factory-2','secondary',[c]);
const observed=(...factories)=>({state:'observed',processId:23,fetchedAt:'2026-11-26T01:00:00.000Z',factories});

test('static and observed graphs select only exact managed scopes and avoid inferred cross-factory relationships',()=>{
  const scopes=observedScopes(observed(primary,secondary));
  assert.equal(chooseScope(scopes,model,files[0].uri).key,'factory-1');
  assert.equal(chooseScope(scopes,model,files[2].uri),null);
  assert.equal(chooseScope(scopes,model,'file:///Other.java'),null);
  assert.equal(chooseScope(observedScopes(observed(primary)),model,'file:///Other.java').key,'factory-1');
  const ambiguous=observedScopes(observed(primary,{...primary,id:'factory-3'}));
  assert.notEqual(ambiguous[0].identity,ambiguous[1].identity);
  assert.ok(ambiguous.every(scope=>scope.layoutSessionOnly));
  const diagram=buildDiagram(model,scopes[0]);
  assert.equal(diagram.sourceRevisionMatched,false);
  assert.deepEqual(diagram.edges.map(({name,kind})=>[name,kind]),[['items','oneToMany'],['owner','manyToOne'],['linked','oneToOne'],['extends','inheritance']]);
  assert.equal(diagram.edges[0].ownership,'inverse');
  assert.equal(diagram.edges[0].source.uri,files[0].uri);
  assert.equal(diagram.edges.find(edge=>edge.name==='linked').from,diagram.edges.find(edge=>edge.name==='linked').to);
  const separate=buildDiagram(model,scopes[1]);
  assert.deepEqual(separate.nodes.map(node=>node.fqn),['fixture.C']);
  assert.deepEqual(separate.edges,[]);
  assert.equal(separate.coverage.unresolved,1);
  const local=buildDiagram(model,sourceScope);
  assert.equal(local.mode,'source');
  assert.ok(local.edges.some(edge=>edge.kind==='inheritance'));
  assert.ok(local.unresolved.some(edge=>edge.property==='unresolved'));
  const legacy=buildDiagram(model,observedScopes(observed(factory('factory-1',null,[{...a,attributes:a.attributes.map(value=>({...value,targetEntityJavaType:undefined}))},b])))[0]);
  assert.ok(legacy.unresolved.some(item=>item.property==='items'));
  assert.ok(legacy.edges.some(edge=>edge.name==='owner'));
});

test('focused layouts stay bounded, reject stale IDs and retain visibility across a larger graph',()=>{
  const all=Array.from({length:80},(_,index)=>({name:'Type'+index,fqn:'example.Type'+index,attributes:[]}));
  const diagram=buildDiagram({entities:all},sourceScope);
  assert.equal(diagram.nodes.length,NODE_LIMIT);
  assert.equal(diagram.coverage.excluded,16);
  const focus=buildDiagram({entities:all},sourceScope,'example.Type79');
  assert.equal(focus.nodes[0].fqn,'example.Type79');
  const key=focus.nodes[0].id;
  let saved=editLayout(focus,{},{type:'move',id:key,x:800,y:900});
  saved=editLayout(focus,saved,{type:'visibility',id:key,hidden:true});
  assert.deepEqual(layoutFor(focus,saved)[key],{x:800,y:900,hidden:true});
  const exposed=layoutFor(focus,saved);exposed[key].x=0;
  assert.equal(saved[key].x,800);
  assert.throws(()=>editLayout(focus,saved,{type:'move',id:key,x:MAX_POSITION+1,y:0}),/outside/);
  assert.throws(()=>editLayout(focus,saved,{type:'move',id:diagram.nodes[0].id,x:0,y:0}),/shown/);
  assert.equal(Object.keys(editLayout(focus,saved,{type:'reset'})).length,0);
});

test('the native diagram controller publishes data separately, persists layout and rejects stale mappings',async()=>{
  let activePanel, receive, changed, command, container, selected;
  let rev=1, runtime=observed(primary,secondary), picked=false;
  const events=[], folder={uri:{toString:()=> 'file:///fixture'}};
  const vscode={workspace:{isTrusted:true,workspaceFolders:[folder],getWorkspaceFolder(uri){return uri.scheme==='file'&&folder;},
    async openTextDocument(uri){return {uri};}},ViewColumn:{One:1}, Uri:{parse(address){return {scheme:'file',toString:()=>address};}},
    Range:class{constructor(...points){this.points=points;}},window:{activeTextEditor:{document:{uri:{toString:()=>files[0].uri}}},
      async showTextDocument(document,options){selected={document,options};},showErrorMessage(message){throw Error(message);},
      async showQuickPick(values){picked=true;return values.find(item=>item.scope?.key==='factory-2');},
      createWebviewPanel(_id,title,_column,options){
        assert.equal(title,'JPA Relationships');assert.deepEqual(options,{enableScripts:true,localResourceRoots:[],enableCommandUris:false});
        return activePanel={webview:{postMessage(message){events.push(message);return true;},onDidReceiveMessage(handler){receive=handler;return {dispose(){}};}},
          reveal(){},onDidDispose(handler){this.disposeHandler=handler;},dispose(){activePanel=undefined;this.disposeHandler();}};
      }},commands:{registerCommand(_name,handler){command=handler;return {dispose(){}};}}};
  const context={workspaceState:{get:()=>container,async update(_key,value){container=structuredClone(value);}}};
  const controller=registerRelationshipDiagram(vscode,context,{source:async()=>model,revision:()=>rev,getObserver:()=>runtime,
    refreshObserver:async()=>{},onChange(handler){changed=handler;return {dispose(){}};}});
  try {
    const first=await command();
    assert.equal(first.diagram.scope,'factory-1');assert.equal(picked,false);
    assert.match(activePanel.webview.html,/script-src 'nonce-/);
    receive({type:'ready'});
    assert.equal(events.at(-1).diagram.nodes.some(node=>node.hasSource),true);
    assert.equal(events.at(-1).diagram.nodes.some(node=>node.source),false);
    assert.equal(controller.isRendered(first.token),false);
    receive({type:'rendered',token:first.token});
    assert.equal(controller.isRendered(first.token),true);
    const id=first.diagram.nodes[0].id;
    await controller.changeLayout(first.token,{type:'move',id,x:320,y:400});
    controller.close();
    const reopened=await command({scope:'factory-1'});
    assert.deepEqual(reopened.layout[id],{x:320,y:400,hidden:false});
    await controller.openSource(reopened.token,first.diagram.edges[0].id);
    assert.equal(selected.document.uri.toString(),files[0].uri);
    rev++;changed();
    assert.equal(events.at(-1).stale,true);
    await assert.rejects(() => controller.openSource(reopened.token,id),/changed/);
    await assert.rejects(() => controller.changeLayout(reopened.token,{type:'reset'}),/changed/);
    vscode.window.activeTextEditor.document.uri={toString:()=>files[2].uri};
    const separate=await command();
    assert.equal(picked,true);
    assert.equal(separate.diagram.scope,'factory-2');
    runtime={state:'disconnected',factories:[]};changed();
    assert.equal(activePanel,undefined);
    assert.equal((await command()).diagram.mode,'source');
  } finally {controller.dispose();}
});

test('the packaged diagram uses a local scripted canvas with no dynamic HTML sinks',()=>{
  const html=diagramHtml();
  const code=/<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(html)[1];
  assert.doesNotThrow(()=>new vm.Script(code));
  assert.doesNotMatch(code,/\.innerHTML\s*=|fetch\(|new WebSocket/);
  assert.match(html,/<canvas id="edges"/);
  assert.match(html,/default-src 'none'/);
});
