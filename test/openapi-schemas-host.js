'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {analyzeOpenApi,requestTemplate}=require('../src/http/openapi');
const {schemaLines}=require('../src/http/openapi-schema-shapes');
const {requestAt,resolveRequest,sendRequest}=require('../src/http/client');

const schema=name=>({$ref:'#/components/schemas/'+name});
const integer={type:'integer'};
const reading='GET /probe/testing-state';
const posted='POST /shapes';
const source=JSON.stringify({
  openapi:'3.1.1',info:{title:'Shape probe'},
  paths:{
    '/probe/testing-state':{
      get:{responses:{200:{$ref:'#/components/responses/Counts'}}}
    },
    '/shapes':{
      post:{
        requestBody:{content:{'application/json':{schema:{oneOf:[schema('List'),{type:'null'}],example:null}}}},
        responses:{202:{content:{'application/json':{schema:{anyOf:[schema('List'),{type:'string'}]}}}}}
      }
    }
  },
  components:{
    responses:{Counts:{content:{'application/json':{schema:schema('AllCounts')}}}},
    schemas:{
      CoreCounts:{type:'object',required:['people'],properties:{people:integer}},
      TransactionCounts:{type:'object',required:['departments','rolledBackNames'],properties:{departments:integer,rolledBackNames:integer}},
      AllCounts:{allOf:[schema('CoreCounts'),schema('TransactionCounts')]},
      List:{type:'object',required:['values'],properties:{values:{type:'array',items:integer},next:schema('List')}}
    }
  }
},null,2);

function assertShapes(report) {
  assert.deepEqual(report.diagnostics,[]);
  const jdbc=report.operations.find(item=>item.key===reading);
  const draft=report.operations.find(item=>item.key===posted);
  assert.equal(jdbc.responseBodies[0].status,'200');
  const composed=jdbc.responseBodies[0].schema;
  assert.equal(composed.kind,'allOf');
  assert.deepEqual(composed.merged.fields.map(field=>[field.name,field.required,field.schema.type]),[
    ['people',true,'integer'],['departments',true,'integer'],['rolledBackNames',true,'integer']
  ]);
  assert.equal(draft.requestBody.schema.kind,'oneOf');
  assert.equal(draft.requestBody.schema.parts[0].fields[0].schema.items.type,'integer');
  assert.equal(draft.requestBody.schema.parts[0].fields[1].schema.kind,'recursive');
  assert.equal(draft.requestBody.schema.parts[1].type,'null');
  assert.equal(draft.responseBodies[0].schema.kind,'anyOf');
  assert.ok(schemaLines(composed).some(line=>line.includes('rolledBackNames (required) integer')));
  assert.ok(schemaLines(draft.requestBody.schema).some(line=>line.includes('next recursive reference')));
  return {jdbc,draft};
}

async function compareResponse(template) {
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.match(runtime.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const request=requestAt(template,template.indexOf('GET'));
  const prepared=await resolveRequest(request,{baseUrl:runtime.baseUrl},()=>{});
  const result=await sendRequest(prepared);
  assert.equal(result.status,200);
  assert.deepEqual(result.assertions.map(item=>item.passed),[true]);
  const jdbc=JSON.parse(result.body);
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  assert.ok(Object.values(jdbc).every(Number.isInteger));
  return {engine:runtime.dbEngine,jdbc,actualShapeMatches:true,allOfMerged:true,
    distinctOneOfAndAnyOf:true,recursiveShape:true,explicitNullExample:true};
}

async function verifyOpenApiSchemas() {
  const {jdbc,draft}=assertShapes(analyzeOpenApi(source));
  assert.match(requestTemplate(draft),/\n\nnull\n$/);
  return compareResponse(requestTemplate(jdbc));
}

async function runOpenApiSchemaChecks(api,vscode,checks) {
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file=path.join(root,'rb-openapi-shapes-'+randomUUID()+'.json');
  await fs.writeFile(file,source,{flag:'wx'});
  try {
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assertShapes(api.openApi.analyze(document));
    const text=api.openApi.previewText(document,reading);
    assert.match(text,/JSON response 200\nallOf\n  combined object/);
    assert.match(text,/people \(required\) integer/);
    const variants=api.openApi.previewText(document,posted);
    assert.match(variants,/JSON request\noneOf/);
    assert.match(variants,/JSON response 202\nanyOf/);
    assert.match(variants,/next recursive reference/);
    assert.match(api.openApi.createRequest(document,posted),/\n\nnull\n$/);
    const result=await compareResponse(api.openApi.createRequest(document,reading));
    checks.push('The installed OpenAPI operation preview explained exact composed response fields, alternatives and recursive schemas against the real Spring/JDBC endpoint.');
    return {...result,nativeSchemaPreview:true};
  } finally { await fs.rm(file,{force:true}); }
}

if (require.main===module) verifyOpenApiSchemas().then(result=>console.log(JSON.stringify(result)),error=>{
  console.error(error.stack);
  process.exitCode=1;
});

module.exports={runOpenApiSchemaChecks,verifyOpenApiSchemas};
