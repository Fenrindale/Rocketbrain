'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeOpenApi, requestTemplate } = require('../src/http/openapi');
const { springServerSource } = require('../src/http/openapi-spring-server');
const { javaClientSource } = require('../src/http/openapi-java-client');
const { source, options, generatedSwagger, exerciseSpringController } = require('./swagger-spring-server-host');

test('Swagger 2 reuses referenced parameters, definitions, media and diagnostic locations', () => {
  const report = analyzeOpenApi(source, { format: 'yaml' });
  const operation = generatedSwagger(report);
  assert.deepEqual(operation.parameters.map(item => [item.in, item.name, item.type, item.required]), [
    ['path', 'id', 'integer', true], ['query', 'amount', 'number', true], ['query', 'flag', 'boolean', false],
    ['header', 'X-Trace', 'string', true]
  ]);
  assert.deepEqual(report.diagnostics.map(item => source.slice(item.range.start, item.range.end)), ['/unsupported']);
  assert.match(javaClientSource([operation], options), /callPersistItem\(Long pathId, BigDecimal queryAmount/);
  const generated = springServerSource([operation], options);
  assert.match(generated, /path = "\/api\/items\/\{id\}", method = RequestMethod.POST/);
  assert.match(generated, /@RequestHeader\(name = "X-Trace", required = true\) String headerXTrace/);
  assert.match(generated, /return handler.handlePersistItem\(pathId, queryAmount, queryFlag, headerXTrace, body\);/);
});

test('OpenAPI 3 keeps actual status and source capabilities for ordinary Spring routes', () => {
  const document = { openapi: '3.1.1', info: { title: 'Example' }, paths: { '/catalog/{item}': { get: {
    operationId: 'fetchItem', responses: { 200: { description: 'Catalog item' } }, parameters: [
      { in: 'path', name: 'item', required: true, schema: { type: 'string' } },
      { in: 'cookie', name: 'tag', schema: { type: 'string' } }
    ]
  } } } };
  const report = analyzeOpenApi(JSON.stringify(document));
  assert.equal(report.version, '3.1.1');
  assert.deepEqual(report.diagnostics, []);
  const [operation] = report.operations;
  assert.match(requestTemplate(operation), /@expect status 200/);
  const code = springServerSource([operation], options);
  assert.match(code, /@CookieValue\(name = "tag", required = false\)/);
  assert.match(code, /path = "\/catalog\/\{item\}", method = RequestMethod.GET/);
  assert.throws(() => springServerSource([{ ...operation, security: true }], options), /declared authorization/);
  assert.throws(() => springServerSource([{ ...operation, path: '/catalog/**' }], options), /simple variable segments/);
  assert.throws(() => springServerSource([operation, operation], options), /distinct Java handler names/);
});

const runtime = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG && process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
test('the exact generated Spring MVC controller reaches live JDBC from the declared Swagger route',
  { skip: !runtime && 'Run an owned Spring application and database fixture.', timeout: 90000 }, async () => {
    const operation = generatedSwagger(analyzeOpenApi(source, { format: 'yaml' }));
    console.log(JSON.stringify(await exerciseSpringController(springServerSource([operation], options))));
  });
