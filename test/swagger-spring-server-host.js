'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { analyzeOpenApi, requestTemplate } = require('../src/http/openapi');
const { springServerSource } = require('../src/http/openapi-spring-server');
const { owned } = require('./schema-stored-diff-host');

const execute = promisify(execFile);
const key = 'POST /items/{id}';
const options = { className: 'FixtureOpenApiController', packageName: 'fixture.openapi' };
const source = `swagger: '2.0'
info: { title: Spring Swagger fixture, version: '1.0' }
host: '127.0.0.1:8080'
basePath: /api
schemes: [http]
consumes: [application/json]
produces: [application/json]
parameters:
  ItemId: { in: path, name: id, required: true, type: integer }
  Payload: { in: body, name: payload, required: true, schema: { $ref: '#/definitions/Body' } }
definitions:
  Body:
    type: object
    required: [note]
    properties: { note: { type: string } }
    example: { note: stored }
  Reply:
    type: object
    properties: { people: { type: integer } }
responses:
  ItemStored: { description: Stored, schema: { $ref: '#/definitions/Reply' } }
paths:
  /items/{id}:
    parameters: [ { $ref: '#/parameters/ItemId' } ]
    post:
      operationId: persistItem
      parameters:
        - { in: query, name: amount, required: true, type: number }
        - { in: query, name: flag, type: boolean }
        - { in: header, name: X-Trace, required: true, type: string }
        - { $ref: '#/parameters/Payload' }
      responses: { '201': { $ref: '#/responses/ItemStored' } }
  /unsupported:
    post:
      parameters: [ { in: formData, name: file, type: file } ]
      responses: { '200': { description: Empty } }
`;

const consumer = String.raw`package fixture.openapi;
import java.math.BigDecimal;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

public class RouteProbe {
    public static void main(String[] args) throws Exception {
        var database = new DriverManagerDataSource(System.getenv("RB_OPENAPI_JDBC_URL"),
            System.getenv("RB_OPENAPI_JDBC_USER"), System.getenv("RB_OPENAPI_JDBC_PASSWORD"));
        var jdbc = JdbcClient.create(database);
        var handler = new FixtureOpenApiController((id, amount, flag, trace, body) -> {
            if (id != 7L || amount.compareTo(new BigDecimal("9007199254740993.125")) != 0 || flag != null ||
                !"owned-route".equals(trace) || !(body instanceof Map<?,?> values) || !"stored".equals(values.get("note"))) {
                throw new AssertionError("Request conversion did not reach the generated handler.");
            }
            int people = jdbc.sql("SELECT COUNT(*) FROM rb_spring_person").query(Integer.class).single();
            return ResponseEntity.status(201).body(Map.of("people", people));
        });
        var mvc = MockMvcBuilders.standaloneSetup(handler).build();
        var request = post("/api/items/{id}", 7).contentType(MediaType.APPLICATION_JSON).accept(MediaType.APPLICATION_JSON)
            .param("amount", "9007199254740993.125").header("X-Trace", "owned-route").content("{\"note\":\"stored\"}");
        var response = mvc.perform(request).andReturn().getResponse();
        var missing = mvc.perform(post("/api/items/{id}", 7).contentType(MediaType.APPLICATION_JSON)
            .param("amount", "9007199254740993.125").content("{\"note\":\"stored\"}")).andReturn().getResponse();
        if (response.getStatus() != 201 || missing.getStatus() != 400) throw new AssertionError("MVC route or required header was not enforced.");
        System.out.println("RB_OPENAPI " + response.getContentAsString());
    }
}
`;

function generatedSwagger(report) {
  assert.equal(report.version, '2.0');
  assert.equal(report.operations.length, 1);
  assert.ok(report.diagnostics.some(item => item.path === '/unsupported' && /form-data/.test(item.message)));
  const operation = report.operations[0];
  assert.equal(operation.key, key);
  assert.deepEqual(operation.servers, ['http://127.0.0.1:8080/api']);
  assert.deepEqual(operation.requestBody.example, { note: 'stored' });
  assert.equal(operation.responseBodies[0].status, '201');
  assert.match(requestTemplate(operation), /POST \{\{baseUrl\}\}\/items\/\{\{path_id\}\}/);
  return operation;
}

function runtimeClasspath(file) {
  return file.split(path.delimiter).map(entry => entry.replaceAll('\\', '/')).join(path.delimiter);
}

async function exerciseSpringController(code) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const javaRuntime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  await actor.end();
  const runtimeFile = path.join(runtime.projectPath, 'build/test-runtime-classpath.txt');
  const classpath = runtimeClasspath((await fs.readFile(runtimeFile, 'utf8')).trim());
  assert.match(classpath, /spring-test-[^;]+\.jar/);
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'rb-openapi-mvc-'));
  const portable = file => file.replaceAll('\\', '/');
  const java = name => path.join(javaRuntime.javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const controller = path.join(directory, options.className + '.java'), probe = path.join(directory, 'RouteProbe.java');
  const argumentFiles = async (name, values) => {
    const args = path.join(directory, name);
    await fs.writeFile(args, values.map(arg => JSON.stringify(arg)).join('\n') + '\n', { flag: 'wx' });
    return ['@' + args];
  };
  try {
    await fs.writeFile(controller, code, { flag: 'wx' });
    await fs.writeFile(probe, consumer, { flag: 'wx' });
    await execute(java('javac'), await argumentFiles('javac.args', ['-proc:none', '-cp', classpath, '-d', portable(directory), portable(controller), portable(probe)]),
      { timeout: 35000, windowsHide: true });
    assert.ok((await fs.stat(path.join(directory, 'fixture/openapi/RouteProbe.class'))).isFile());
    const vendor = runtime.dbEngine === 'mysql' ? 'mysql' : 'mariadb';
    const command = ['-cp', [portable(directory), classpath].join(path.delimiter), 'fixture.openapi.RouteProbe'];
    const result = await execute(java('java'), command, { timeout: 40000, windowsHide: true,
      env: { ...process.env, RB_OPENAPI_JDBC_URL: `jdbc:${vendor}://127.0.0.1:${config.port}/${config.database}`,
        RB_OPENAPI_JDBC_USER: config.user, RB_OPENAPI_JDBC_PASSWORD: config.password } })
      .catch(error => { throw Error('The generated Spring MVC probe failed to run. ' + String(error.stderr ?? '').slice(0, 2500)); });
    const response = result.stdout.split(/\r?\n/).find(line => line.startsWith('RB_OPENAPI '));
    assert.ok(response);
    assert.deepEqual(JSON.parse(response.slice('RB_OPENAPI '.length)), { people: 2 });
    const spring = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(spring.status, 200);
    const jdbc = await spring.json();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    return { engine: runtime.dbEngine, version, compiledSpringController: true, mappedSwaggerBasePath: true,
      preciseDecimalAndOptionalBoolean: true, requiredHeaderRejected: true, actualGeneratedHandlerJdbc: true, jdbc };
  } finally {
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.match(path.basename(directory), /^rb-openapi-mvc-/);
    await fs.rm(directory, { recursive: true });
  }
}

async function runSwaggerSpringServerChecks(api, vscode, checks) {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = path.join(root, 'rb-swagger-spring-' + randomUUID() + '.yaml');
  await fs.writeFile(file, source, { flag: 'wx' });
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.openapi.createSpringServer'));
    generatedSwagger(api.openApi.analyze(document));
    assert.match(api.openApi.previewText(document, key), /JSON response 201/);
    assert.match(api.openApi.createJavaClient(document, [key], options), /callPersistItem/);
    const generated = api.openApi.createSpringServer(document, [key], options);
    assert.equal(generated, springServerSource([generatedSwagger(analyzeOpenApi(source, { format: 'yaml' }))], options));
    const proof = await exerciseSpringController(generated);
    checks.push('The installed Swagger document generated client and Spring MVC controller source. Its exact controller compiled, enforced a required header, dispatched the declared base path, and queried live JDBC.');
    return { ...proof, nativeGenerator: true, legacySwaggerDiagnostics: true, nativeClientCompatible: true };
  } finally { await fs.unlink(file); }
}

module.exports = { source, key, options, generatedSwagger, exerciseSpringController, runSwaggerSpringServerChecks };
