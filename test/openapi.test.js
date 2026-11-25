'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeOpenApi,requestTemplate}=require('../src/http/openapi');
const {requestAt,resolveRequest}=require('../src/http/client');
const {javaClientSource}=require('../src/http/openapi-java-client');

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
  assert.match(result.diagnostics[3].message,/acyclic OpenAPI reference/);
});

test('YAML path items and parameters keep the declaring file as their relative reference base',async()=>{
  const text=[
    'openapi: 3.1.1',
    'info:',
    '  title: Referenced fixture',
    'paths:',
    '  /items/{item}:',
    "    $ref: './parts/operation.yaml#/paths/~1item'",
    "  '/missing':",
    "    $ref: './absent.yaml#'",
    ''].join('\n');
  const parts=[
    'paths:',
    '  /item:',
    '    parameters:',
    "      - $ref: '#/parameters/key'",
    '    put:',
    "      requestBody: { $ref: './types.json#/body' }",
    "      responses: { '202': { description: Accepted } }",
    'parameters:',
    '  key:',
    '    name: item',
    '    in: path',
    '    required: true',
    "    schema: { $ref: './types.json#/types/item' }",
    ''].join('\n');
  const types=JSON.stringify({
    types:{item:{type:['integer','null']},input:{type:'object',examples:[{enabled:true,quantity:3}]}},
    body:{required:true,content:{'application/json':{schema:{$ref:'#/types/input'}}}}
  });
  const routes=new Map([
    ['root/entry.yaml|./parts/operation.yaml',{id:'root/parts/operation.yaml',format:'yaml',text:parts}],
    ['root/parts/operation.yaml|./types.json',{id:'root/parts/types.json',format:'json',text:types}]
  ]);
  const calls=[];
  const report=analyzeOpenApi(text,{format:'yaml',sourceId:'root/entry.yaml',loadReference(reference,source) {
    calls.push(source+'|'+reference);
    return routes.get(calls.at(-1));
  }});
  assert.deepEqual(calls,[
    'root/entry.yaml|./parts/operation.yaml','root/parts/operation.yaml|./types.json','root/entry.yaml|./absent.yaml'
  ]);
  assert.equal(report.operations[0].parameters[0].type,'integer | null');
  assert.equal(report.diagnostics.length,1);
  const {start,end}=report.diagnostics[0].range;
  assert.equal(text.slice(start,end),"'/missing'");
  const draft=requestTemplate(report.operations[0]);
  const request=requestAt(draft,draft.indexOf('PUT'));
  const prepared=await resolveRequest(request,{baseUrl:'https://example.test',path_item:'7'},()=>{});
  assert.deepEqual(JSON.parse(prepared.body),{enabled:true,quantity:3});
});

test('YAML descriptions reject duplicate keys, aliases, unexpected tags, and unsafe integer rounding',()=>{
  const entry='openapi: 3.1.1\ninfo: { title: Fixture }\npaths: {}\n';
  for (const suffix of [
    'paths: {}\n',
    'x-a: &value [0, 1]\nx-b: *value\n',
    'x-a: !other text\n',
    'x-a: 9007199254740993\n',
    'x-a: .inf\n'
  ]) assert.throws(()=>analyzeOpenApi(entry+suffix,{format:'yaml'}),/exact JSON-compatible values/);
});

test('Java client generation grounds scalar values in selected operations and keeps the service address caller-owned',()=>{
  const schema={openapi:'3.1.1',info:{title:'Fixture'},servers:[{url:'https://example.invalid/private'}],paths:{
    '/items/{id}':{get:{operationId:'findItem',parameters:[
      {name:'id',in:'path',required:true,schema:{type:'string'}},
      {name:'limit',in:'query',schema:{type:'integer'}}
    ],responses:{200:{description:'Found'}}}}
  }};
  const [operation]=analyzeOpenApi(JSON.stringify(schema)).operations;
  const code=javaClientSource([operation],{className:'ItemsClient',packageName:'fixture.items'});
  assert.match(code,/public HttpResponse<byte\[\]> callFindItem\(String pathId, Long queryLimit\)/);
  assert.match(code,/if \(queryLimit != null\)/);
  assert.match(code,/HttpClient\.Redirect\.NEVER/);
  assert.equal(code.includes(schema.servers[0].url),false);
  assert.throws(()=>javaClientSource([operation,operation]),/distinct, bounded Java names/);
  assert.throws(()=>javaClientSource([operation],{className:'HttpClient'}),/valid Java class/);
  const withStyle={...operation,parameters:[{...operation.parameters[0],style:'matrix'}]};
  assert.throws(()=>javaClientSource([withStyle]),/default serialization/);
});
