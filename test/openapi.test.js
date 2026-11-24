'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeOpenApi,requestTemplate}=require('../src/http/openapi');
const {requestAt,resolveRequest}=require('../src/http/client');

test('OpenAPI JSON applies local parameter references and emits a previewable executable HTTP template',async()=>{
  const document={
    openapi:'3.1.1',info:{title:'Owned fixture'},
    components:{parameters:{'full/name':{name:'item',in:'path',required:true,schema:{type:'string'}}}},
    paths:{
      '/items/{item}':{parameters:[{$ref:'#/components/parameters/full~1name'}],
        post:{operationId:'create',parameters:[{name:'page',in:'query',required:true,schema:{type:'integer'}}],
          requestBody:{required:true,content:{'application/json':{example:{ok:true}}}},responses:{202:{description:'Accepted'}}}}
    }
  };
  const result=analyzeOpenApi(JSON.stringify(document));
  assert.deepEqual(result.diagnostics,[]);
  assert.equal(result.operations[0].key,'POST /items/{item}');
  const template=requestTemplate(result.operations[0]);
  const request=requestAt(template,template.indexOf('POST'));
  const resolved=await resolveRequest(request,{baseUrl:'https://example.test/api',path_item:'a%2Fb',query_page:'2'},()=>{});
  assert.equal(resolved.url.href,'https://example.test/api/items/a%2Fb?page=2');
  assert.deepEqual(JSON.parse(resolved.body),{ok:true});
  assert.deepEqual(resolved.assertions,[{kind:'status',value:202}]);
});

test('reports missing parameters, cyclic or external references, and duplicate template shape',()=>{
  const document={openapi:'3.0.3',info:{title:'Diagnostic fixture'},paths:{
    '/unset/{id}':{get:{responses:{200:{}}}},
    '/unset/{alternative}':{get:{responses:{200:{}}}},
    '/external':{$ref:'https://example.test/spec.json'},
    '/cycle':{$ref:'#/paths/~1cycle'}
  }};
  const result=analyzeOpenApi(JSON.stringify(document));
  assert.deepEqual(result.operations,[]);
  assert.deepEqual(result.diagnostics.map(item=>item.path),['/unset/{id}','/unset/{alternative}','/external','/cycle']);
  assert.match(result.diagnostics[0].message,/placeholder/);
  assert.match(result.diagnostics[1].message,/same template/);
  assert.match(result.diagnostics[2].message,/local, acyclic/);
  assert.match(result.diagnostics[3].message,/local, acyclic/);
});
