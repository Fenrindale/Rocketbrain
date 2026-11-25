'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {analyzeOpenApi,requestTemplate}=require('../src/http/openapi');
const {requestAt,resolveRequest,sendRequest}=require('../src/http/client');

const readings={people:2,departments:1,rolledBackNames:0};
const operation='GET /probe/testing-state';

function description(suffix) {
  const entry='rb-openapi-'+suffix+'.yaml';
  const operations='src/main/resources/rb-operations-'+suffix+'.yaml';
  const schema='src/main/resources/rb-types-'+suffix+'.json';
  const files=new Map([
    [entry,[
      'openapi: 3.1.1',
      'info: { title: Spring probe }',
      'paths:',
      '  /probe/testing-state:',
      "    $ref: './"+operations+"#/operations/probe'",
      '  /missing:',
      "    $ref: './rb-absent-"+suffix+".yaml'",
      '  /external:',
      "    $ref: 'https://example.invalid/openapi.yaml'",
      ''
    ].join('\n')],
    [operations,[
      'operations:',
      '  probe:',
      "    parameters: [{ $ref: '#/parameters/hint' }]",
      '    get:',
      '      operationId: observeDatabase',
      "      responses: { '200': { description: JDBC counts } }",
      'parameters:',
      '  hint:',
      '    name: hint',
      '    in: query',
      '    required: true',
      "    schema: { $ref: './"+path.posix.basename(schema)+"#/schemas/hint' }",
      ''
    ].join('\n')],
    [schema,JSON.stringify({schemas:{hint:{type:'integer'}}})]
  ]);
  return {entry,schema,files};
}

async function liveConfig() {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  return config;
}

function assertReport(report) {
  assert.equal(report.operations.length,1);
  assert.equal(report.operations[0].id,'observeDatabase');
  assert.deepEqual(report.operations[0].parameters,[{key:'query:hint',name:'hint',in:'query',required:true,type:'integer'}]);
  assert.deepEqual(report.diagnostics.map(item=>item.path),['/missing','/external']);
}

function verifyHttp(result) {
  assert.equal(result.status,200);
  assert.deepEqual(result.assertions.map(item=>item.passed),[true]);
  assert.deepEqual(JSON.parse(result.body),readings);
}

async function runOpenApiYamlChecks(api,vscode,checks) {
  const config=await liveConfig();
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const suffix=randomUUID(), fixture=description(suffix);
  const file=relative=>path.join(root,relative);
  const uri=relative=>vscode.Uri.file(file(relative));
  const generated='rb-openapi-generated-'+suffix+'.http';
  const created=[];
  async function write(relative,contents) {
    await fs.writeFile(file(relative),contents,{flag:'wx'});
    created.push(relative);
  }
  let typeDocument;
  try {
    for (const [name,contents] of fixture.files) await write(name,contents);
    const entry=await vscode.workspace.openTextDocument(uri(fixture.entry));
    assert.equal(entry.languageId,'yaml');
    const report=api.openApi.analyze(entry);
    assertReport(report);
    const diagnostics=vscode.languages.getDiagnostics(entry.uri).filter(item=>item.source==='Rocketbrain OpenAPI');
    assert.deepEqual(diagnostics.map(item=>entry.getText(item.range)),['/missing','/external']);
    assert.match(diagnostics[0].message,/file is missing/);
    assert.match(diagnostics[1].message,/same trusted workspace/);
    const contents='@baseUrl = '+config.baseUrl+'\n@query_hint = 4\n'+api.openApi.createRequest(entry,operation);
    await write(generated,contents);
    const draft=await vscode.workspace.openTextDocument(uri(generated));
    verifyHttp(await api.httpTools.run(draft,contents.indexOf('GET')));
    typeDocument=await vscode.workspace.openTextDocument(uri(fixture.schema));
    const changed=typeDocument.getText().replace('"integer"','"number"');
    const edit=new vscode.WorkspaceEdit();
    edit.replace(typeDocument.uri,new vscode.Range(typeDocument.positionAt(0),typeDocument.positionAt(typeDocument.getText().length)),changed);
    assert.equal(await vscode.workspace.applyEdit(edit),true);
    assert.equal(typeDocument.isDirty,true);
    assert.ok(api.openApi.analyze(entry).diagnostics.some(item=>/Save the referenced OpenAPI file/.test(item.message)));
    assert.equal(await typeDocument.save(),true);
    assert.equal(api.openApi.analyze(entry).operations[0].parameters[0].type,'number');
    checks.push('A YAML OpenAPI entry resolved nested local YAML and JSON references, then ran its generated HTTP request against the owned Spring/JDBC endpoint.');
    return {yamlEntry:true,loadedJsonAndYaml:true,exactDiagnosticRanges:true,remoteReferenceRefused:true,
      dirtyReferenceRefused:true,savedReferenceReanalyzed:true,nativeGeneratedRequest:true,jdbc:readings};
  } finally {
    if (typeDocument?.isDirty) await typeDocument.save();
    await Promise.all(created.map(name=>fs.rm(file(name),{force:true})));
  }
}

async function verifyLiveOpenApiYaml() {
  const config=await liveConfig();
  const fixture=description('headless');
  const report=analyzeOpenApi(fixture.files.get(fixture.entry),{format:'yaml',sourceId:fixture.entry,
    loadReference(reference,source) {
      const id=path.posix.normalize(path.posix.join(path.posix.dirname(source),reference));
      const text=fixture.files.get(id);
      if (text===undefined) throw Error('This reference is outside the owned fixture.');
      return {id,text,format:id.endsWith('.yaml')?'yaml':'json'};
    }});
  assertReport(report);
  const draft=requestTemplate(report.operations[0]);
  const request=requestAt(draft,draft.indexOf('GET'));
  const prepared=await resolveRequest(request,{baseUrl:config.baseUrl,query_hint:'4'},()=>{});
  assert.equal(prepared.url.search,'?hint=4');
  verifyHttp(await sendRequest(prepared));
  return {engine:config.dbEngine,operation:report.operations[0].id,yamlAndJson:true,
    referencedType:report.operations[0].parameters[0].type,generatedRequestRan:true,jdbc:readings};
}

if (require.main===module) verifyLiveOpenApiYaml().then(result=>console.log(JSON.stringify(result)),error=>{
  console.error(error.stack);
  process.exitCode=1;
});

module.exports={runOpenApiYamlChecks,verifyLiveOpenApiYaml};
