'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {ObserverClient} = require('../src/jpa/observer-client');
const {registerJpaConsole,htmlForResult} = require('../src/jpa/console-vscode');

const QUERY='select p.id as id from Person p where p.id >= :floor';
const FACTORY='factory-1';
const description={state:'described',factoryId:FACTORY,
  columns:[{alias:'id',javaType:'java.lang.Long'}],parameters:[{key:':floor',javaType:'java.lang.Long'}],sqlExecuted:false};
const result={state:'executed',factoryId:FACTORY,columns:description.columns,rows:[['9007199254740993']],rowCount:1,hasMore:false,
  sqlExecuted:true,queryExecuted:true,databaseReadOnlyTransaction:true,rolledBack:true,boundParameterValuesRetained:false};

test('console protocol keeps describe and select separate and preserves exact typed binding and result text',async()=>{
  const token='a'.repeat(48),requests=[];
  const host=http.createServer(async(req,res)=>{
    let body='';
    for await (const part of req) body+=part;
    requests.push({path:req.url,authorization:req.headers.authorization,body:JSON.parse(body)});
    const reply=req.url==='/console/describe'?description:req.url==='/console/select'&&requests.length<3
      ? result : {...result,rows:[[1]]};
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({...reply,bindings:{shouldNotExist:'fixture'}}));
  });
  await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
  const client=new ObserverClient({url:'http://127.0.0.1:'+host.address().port,token});
  try{
    assert.deepEqual(await client.describeSelect(QUERY,FACTORY),description);
    const executed=await client.select(QUERY,FACTORY,{':floor':'9007199254740993'},1);
    assert.deepEqual(executed.rows,[['9007199254740993']]);
    assert.equal(executed.bindings,undefined);
    assert.deepEqual(requests.map(({path,body})=>[path,body]),[
      ['/console/describe',{query:QUERY,factoryId:FACTORY}],
      ['/console/select',{query:QUERY,factoryId:FACTORY,values:{':floor':'9007199254740993'},limit:1}]
    ]);
    assert.ok(requests.every(request=>request.authorization==='Bearer '+token));
    await assert.rejects(()=>client.select(QUERY,FACTORY,{':floor':12},1),error=>error.code==='INVALID_BINDINGS');
    await assert.rejects(()=>client.select(QUERY,'factory/other',{':floor':'12'},1),error=>error.code==='INVALID_FACTORY');
    await assert.rejects(()=>client.select(QUERY,FACTORY,{':floor':'12'},101),error=>error.code==='INVALID_BINDINGS');
    await assert.rejects(()=>client.select(QUERY,FACTORY,{':floor':'12'},1),error=>error.code==='INVALID_SCHEMA');
  }finally{client.dispose();await new Promise(resolve=>host.close(resolve));}
});

test('JPQL console authoring marks the editor language, reviews exact content and drops stale editor input',async()=>{
  const registered=new Map(),prompts=[],calls=[];
  const document={languageId:'rocketbrain-jpql',version:1,getText:()=>QUERY};
  let cancelled=false,changed=false,shown,webview;
  const vscode={ViewColumn:{Beside:2},
    workspace:{async openTextDocument(input){return input;}},
    window:{
      activeTextEditor:{selection:{isEmpty:true},document},
      async showTextDocument(value){shown=value;},
      async showQuickPick(values,options){
        if(options.title.includes('workspace source'))return values[1];
        if(options.title.includes('Hibernate factory'))return values[0];
        return values[0];
      },
      async showInputBox(options){assert.equal(options.password,true);return '9007199254740993';},
      async showWarningMessage(message,options,accept){
        prompts.push({message,detail:options.detail});
        if(changed)document.version++;
        return cancelled?undefined:accept;
      },
      createWebviewPanel(_id,_title,_column,options){
        assert.deepEqual(options,{enableScripts:false,localResourceRoots:[],enableCommandUris:false});
        webview={};
        return {webview,onDidDispose(){},dispose(){webview=undefined;}};
      }
    }};
  const view=registerJpaConsole(vscode,{source:async()=>({queries:[{text:QUERY}]}),command:(key,callback)=>registered.set(key,callback),
    target:()=>({factories:[{id:FACTORY}],assertCurrent(){},client:{
      async describeSelect(query,factoryId){calls.push(['describe',query,factoryId]);return description;},
      async select(query,factoryId,values,limit){calls.push(['select',query,factoryId,{...values},limit]);return result;}
    }})});
  await registered.get('rocketbrain.jpa.console.open')();
  assert.deepEqual(shown,{language:'rocketbrain-jpql',content:QUERY});
  const run=registered.get('rocketbrain.jpa.console.run');
  await assert.rejects(()=>run({query:QUERY}),error=>error.code==='REVIEW_REQUIRED');
  cancelled=true;await run();
  assert.equal(calls.filter(item=>item[0]==='select').length,0);
  changed=true;cancelled=false;
  await assert.rejects(()=>run(),error=>error.code==='STALE');
  assert.equal(calls.filter(item=>item[0]==='select').length,0);
  changed=false;assert.equal((await run()).view,'rocketbrain.jpql.result');
  assert.deepEqual(calls.at(-1),['select',QUERY,FACTORY,{':floor':'9007199254740993'},25]);
  assert.ok(prompts.every(item=>item.detail.includes(QUERY)&&!item.detail.includes('9007199254740993')));
  assert.match(webview.html,/9007199254740993/);
  view.clear();assert.equal(webview,undefined);
});

test('JPQL grid escapes query, aliases and data in a static webview',()=>{
  const html=htmlForResult({...result,columns:[{alias:'<syntax>',javaType:'java.lang.String'}],
    rows:[['<literal>&']]},'<selection>');
  assert.match(html,/&lt;syntax&gt;/);
  assert.match(html,/&lt;literal&gt;&amp;/);
  assert.match(html,/&lt;selection&gt;/);
  assert.match(html,/default-src 'none'/);
  assert.doesNotMatch(html,/<script|<literal>|<syntax>|<selection>/);
});

test('managed fetch preview validates nested typed rows and distinguishes an empty collection from a null association',async()=>{
  const fetchSnapshot={rootType:'fixture.Person',targetType:'fixture.Dog',association:'dogs',path:'fixture.Person.dogs',
    toMany:true,maxRoots:25,maxChildren:16,columns:[{alias:'name',javaType:'java.lang.String'},{alias:'trained',javaType:'java.lang.Boolean'}]};
  const fetched={...result,rows:[['1'],['2']],rowCount:2,fetchSnapshot:{...fetchSnapshot,joinedRows:2,linked:[
    {state:'loaded',rows:[['<dog>',false]],hasMore:false},
    {state:'loaded',rows:[],hasMore:false}
  ]}};
  let response=fetched;
  const host=http.createServer((req,res)=>{
    req.resume();
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url==='/console/describe'?{...description,fetchSnapshot}:response));
  });
  await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
  const client=new ObserverClient({url:'http://127.0.0.1:'+host.address().port,token:'d'.repeat(48)});
  const query='select p from Person p left join fetch p.dogs where p.id >= :floor';
  try{
    assert.deepEqual((await client.describeSelect(query,FACTORY)).fetchSnapshot,fetchSnapshot);
    const run=()=>client.select(query,FACTORY,{':floor':'1'},2);
    const validated=await run();
    assert.deepEqual(validated.fetchSnapshot,fetched.fetchSnapshot);
    const html=htmlForResult(validated,query);
    assert.match(html,/&lt;dog&gt;/);
    assert.match(html,/<td>false<\/td>/);
    assert.match(html,/<em>Empty collection<\/em>/);
    assert.doesNotMatch(html,/<dog>|<em>NULL<\/em>/);
    response={...fetched,fetchSnapshot:{...fetched.fetchSnapshot,toMany:false,linked:[fetched.fetchSnapshot.linked[0],
      {state:'null',rows:[],hasMore:false}]}};
    const nullable=await run();
    assert.match(htmlForResult(nullable,query),/<em>NULL<\/em>/);
    assert.doesNotMatch(htmlForResult(nullable,query),/Empty collection/);
    for(const linked of [ [{state:'loaded',rows:[['dog','false']],hasMore:false},response.fetchSnapshot.linked[1]],
      [{state:'null',rows:[['dog',false]],hasMore:false},response.fetchSnapshot.linked[1]] ]){
      response={...response,fetchSnapshot:{...response.fetchSnapshot,linked}};
      await assert.rejects(run,error=>error.code==='INVALID_SCHEMA');
    }
  }finally{client.dispose();await new Promise(resolve=>host.close(resolve));}
});

test('multiple fetch paths preserve reviewing order, set identity and the shared physical row budget',async()=>{
  const owner='fixture.Person';
  const association=(name,collection,linked)=>({association:name,path:owner+'.'+name,targetType:'fixture.Related',toMany:!!collection,
    columns:[{alias:'id',javaType:'java.lang.Long'}],...(collection?{collection}:{}),linked:[linked]});
  const left=association('leftSet','SET',{state:'loaded',rows:[['1'],['2']],hasMore:false});
  const right=association('rightSet','SET',{state:'loaded',rows:[['2'],['3'],['4']],hasMore:false});
  const note=association('note',null,{state:'null',rows:[],hasMore:false});
  const roots={rootType:owner,maxRoots:25,maxChildren:16};
  const described={...description,fetchSnapshots:{...roots,associations:[left,right,note].map(({linked,...path})=>path)}};
  const executed={...result,fetchSnapshots:{...roots,joinedRows:6,associations:[left,right,note]}};
  let response=executed;
  const server=http.createServer((req,res)=>{
    req.resume();res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url==='/console/describe'?described:response));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new ObserverClient({url:'http://127.0.0.1:'+server.address().port,token:'e'.repeat(48)});
  const query='select p from Person p left join fetch p.leftSet left join fetch p.rightSet left join fetch p.note where p.id >= :floor';
  const run=()=>client.select(query,FACTORY,{':floor':'1'},25);
  try{
    assert.deepEqual((await client.describeSelect(query,FACTORY)).fetchSnapshots,described.fetchSnapshots);
    const valid=await run();
    assert.deepEqual(valid.fetchSnapshots,executed.fetchSnapshots);
    const html=htmlForResult(valid,query);
    assert.match(html,/<span>leftSet<\/span>[\s\S]*<span>rightSet<\/span>[\s\S]*<span>note<\/span>/);
    assert.match(html,/6 joined rows/);
    assert.match(html,/<em>NULL<\/em>/);
    for(const invalid of [ report=>report.fetchSnapshots.joinedRows=5,
      report=>report.fetchSnapshots.associations[0].linked[0].rows[1]=['1'],
      report=>report.fetchSnapshots.associations[0].collection='BAG',
      report=>report.fetchSnapshots.associations[1]=report.fetchSnapshots.associations[0],
      report=>report.fetchSnapshot=left ]){
      response=structuredClone(executed);invalid(response);
      await assert.rejects(run,error=>error.code==='INVALID_SCHEMA');
    }

    const registered=new Map();
    let changed;
    registerJpaConsole({window:{}},{command:(key,fn)=>registered.set(key,fn),target:()=>({factories:[{id:FACTORY}],assertCurrent(){},
      client:{async describeSelect(){return described;},async select(){return changed;}}})});
    changed=structuredClone(executed);
    changed.fetchSnapshots.associations.reverse();
    await assert.rejects(()=>registered.get('rocketbrain.jpa.console.run')({query,factoryId:FACTORY,values:{':floor':'1'},approved:true}),
      error=>error.code==='STALE');
  }finally{client.dispose();await new Promise(resolve=>server.close(resolve));}
});
