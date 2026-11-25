'use strict';

const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const fs=require('node:fs/promises');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const {analyzeOpenApi}=require('../src/http/openapi');
const {javaClientSource}=require('../src/http/openapi-java-client');

const exec=promisify(execFile);
const options={className:'SpringProbeClient',packageName:'fixture.client'};
const operations=['GET /probe/testing-state','POST /items/{id}'];
const source=[
  'openapi: 3.1.1',
  'info: { title: SDK probe }',
  'paths:',
  '  /probe/testing-state:',
  '    get:',
  '      operationId: springState',
  "      parameters: [{ in: query, name: sample, required: true, schema: { type: integer } }]",
  "      responses: { '200': { description: JDBC values } }",
  '  /items/{id}:',
  '    post:',
  '      operationId: sendItem',
  '      parameters:',
  '        - { in: path, name: id, required: true, schema: { type: string } }',
  '        - { in: query, name: quantity, required: true, schema: { type: number } }',
  '        - { in: query, name: flag, schema: { type: boolean } }',
  '        - { in: header, name: X-Request, required: true, schema: { type: string } }',
  '        - { in: cookie, name: sample, schema: { type: string } }',
  '      requestBody:',
  '        required: true',
  '        content: { application/json: { schema: { type: object } } }',
  "      responses: { '201': { description: Stored } }",
  ''
].join('\n');
const consumer=[
  'package fixture.client;',
  'import java.math.BigDecimal;',
  'import java.net.URI;',
  'import java.nio.charset.StandardCharsets;',
  'import java.util.Map;',
  'public class Consumer {',
  '    public static void main(String[] args) throws Exception {',
  '        var local = new SpringProbeClient(URI.create(args[0]), Map.of("X-Identity", "sdk-fixture"));',
  '        var first = local.callSendItem("item/one + two", new BigDecimal("9007199254740993.125"), null, "given", "active item", "{\\"ok\\":true}");',
  '        if (first.statusCode() != 201) throw new IllegalStateException("POST status: " + first.statusCode());',
  '        System.out.println(first.body()[0] + "," + first.body()[1] + "," + first.body()[2]);',
  '        if (args.length > 1) {',
  '            var remote = new SpringProbeClient(URI.create(args[1]), Map.of());',
  '            var result = remote.callSpringState(3L);',
  '            if (result.statusCode() != 200) throw new IllegalStateException("GET status: " + result.statusCode());',
  '            System.out.println(new String(result.body(), StandardCharsets.UTF_8));',
  '        }',
  '    }',
  '}',''
].join('\n');

async function exercise(code) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
  const spring=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG?
    JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8')):null;
  if (spring) {
    assert.match(spring.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(spring.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  }
  const local=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(local,'rb-openapi-java-'));
  let seen;
  const server=http.createServer(async (request,response)=>{
    const chunks=[];
    for await (const chunk of request) chunks.push(chunk);
    seen={method:request.method,url:request.url,headers:request.headers,body:Buffer.concat(chunks).toString('utf8')};
    response.writeHead(201,{'Content-Type':'application/octet-stream'});
    response.end(Buffer.from([0,128,255]));
  });
  try {
    const java=tool=>path.join(config.javaHome,'bin',tool+(process.platform==='win32'?'.exe':''));
    const client=path.join(root,options.className+'.java'), call=path.join(root,'Consumer.java');
    await fs.writeFile(client,code,{flag:'wx'});
    await fs.writeFile(call,consumer,{flag:'wx'});
    await exec(java('javac'),['--release','11','-proc:none','-d',root,client,call],{timeout:25000,windowsHide:true});
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const transport='http://127.0.0.1:'+server.address().port+'/sdk/';
    const result=await exec(java('java'),['-cp',root,'fixture.client.Consumer',transport,...(spring?[spring.baseUrl]:[])],
      {timeout:40000,windowsHide:true,maxBuffer:65536});
    const [binary,body]=result.stdout.trim().split(/\r?\n/);
    assert.equal(binary,'0,-128,-1');
    assert.equal(seen.method,'POST');
    assert.equal(seen.url,'/sdk/items/item%2Fone%20%2B%20two?quantity=9007199254740993.125');
    assert.equal(seen.headers['x-request'],'given');
    assert.equal(seen.headers['x-identity'],'sdk-fixture');
    assert.equal(seen.headers.cookie,'sample=active%20item');
    assert.equal(seen.headers['content-type'],'application/json');
    assert.deepEqual(JSON.parse(seen.body),{ok:true});
    const jdbc=spring?JSON.parse(body):undefined;
    if (spring) assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
    return {compiledJava11:true,requestEncoding:true,optionalParameterOmitted:true,decimalExact:true,binaryResponse:true,
      bodyAndHeaders:true,...(spring&&{engine:spring.dbEngine,jdbc,springRequestSucceeded:true})};
  } finally {
    await new Promise(resolve=>server.close(resolve));
    const actual=await fs.realpath(root);
    assert.equal(path.dirname(actual),local);
    assert.match(path.basename(actual),/^rb-openapi-java-[a-zA-Z0-9]+$/);
    await fs.rm(actual,{recursive:true,force:true});
  }
}

const generateFixtureClient=()=>javaClientSource(analyzeOpenApi(source,{format:'yaml'}).operations,options);

async function runOpenApiJavaClientChecks(api,vscode,checks) {
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file=path.join(root,'rb-openapi-sdk-'+randomUUID()+'.yaml');
  await fs.writeFile(file,source,{flag:'wx'});
  try {
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const available=await vscode.commands.getCommands(true);
    assert.ok(available.includes('rocketbrain.openapi.createJavaClient'));
    const generated=api.openApi.createJavaClient(document,operations,options);
    assert.equal(generated,generateFixtureClient());
    const result=await exercise(generated);
    assert.ok(result.springRequestSucceeded);
    checks.push('The installed OpenAPI Java generator produced a Java 11 client that compiled and called the owned Spring/JDBC endpoint.');
    return {...result,nativeGenerator:true,observedOperationSelection:true};
  } finally { await fs.rm(file,{force:true}); }
}

if (require.main===module) exercise(generateFixtureClient()).then(result=>console.log(JSON.stringify(result)),error=>{
  console.error(error.stack);
  process.exitCode=1;
});

module.exports={exercise,generateFixtureClient,runOpenApiJavaClientChecks};
