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
