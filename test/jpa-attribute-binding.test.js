'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { attributeBindingReport, observedPropertyPaths } = require('../src/jpa/attribute-binding');
const { ObserverClient } = require('../src/jpa/observer-client');
const { registerObserver } = require('../src/jpa/observer-vscode');

const token = 'r'.repeat(64);
const identity = { factoryId: 'factory-2', entityJavaType: 'sample.Model', propertyPath: 'scope.code' };
const guard = { observerExecutedSql: false, applicationCallbacksInvoked: false, valuesRetained: false };
const declaration = { basis: 'jakarta-persistence-metamodel', kind: 'BASIC', javaType: 'sample.Code' };
const mapping = { basis: 'hibernate-runtime-mapping', table: 'model', column: 'sample_code',
  domainJavaType: 'sample.Code', relationalJavaType: 'java.lang.Long', jdbcTypeCode: -5, jdbcType: 'BIGINT',
  binderClass: 'org.hibernate.type.descriptor.jdbc.BigIntJdbcType$1',
  conversion: { kind: 'attribute-converter', javaType: 'sample.CodeConverter' } };
const observed = { ...identity, ...guard, state: 'observed', declaration, mapping };
const model = { javaType: identity.entityJavaType, table: 'model',
  attributes: [{ name: 'scope', kind: 'EMBEDDED' }, { name: 'id', kind: 'BASIC' }, { name: 'peers', kind: 'ONE_TO_MANY' }],
  physicalMappings: [{ property: 'scope.code' }, { property: 'peers.id' }, { property: 'scope.code;no' }] };

async function listener(t, run) {
  const server = http.createServer(run);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: 'http://127.0.0.1:' + server.address().port, token };
}

test('mapping inspection preserves explicit identity and withholds unproved or value-bearing metadata', async t => {
  const requests = [];
  let payload = { ...observed, converterInput: 'never projected', mapping: { ...mapping, sample: 'not retained' } };
  const config = await listener(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.end(JSON.stringify(payload));
  });
  const observer = new ObserverClient(config);
  t.after(() => observer.dispose());
  for (const invalid of [{ ...identity, factoryId: '' }, { ...identity, propertyPath: 'scope[*].code' },
    { ...identity, propertyPath: 'a.'.repeat(8) + 'b' }]) {
    await assert.rejects(observer.inspectAttributeBinding(invalid), error => error.code === 'INVALID_ATTRIBUTE');
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(await observer.inspectAttributeBinding({ ...identity, value: 'never sent' }), observed);
  assert.deepEqual(requests[0], { method: 'POST', path: '/attribute-binding', body: identity });
  for (const unsafe of [{ ...observed, factoryId: 'factory-1' }, { ...observed, applicationCallbacksInvoked: true },
    { ...observed, valuesRetained: true }, { ...observed, mapping: { ...mapping, binderClass: 'sample.UserTypeBinder' } },
    { ...observed, state: 'partial', reason: 'unsupported_converter' }]) {
    payload = unsafe;
    await assert.rejects(observer.inspectAttributeBinding(identity), error => error.code === 'INVALID_SCHEMA');
  }
  assert.deepEqual(attributeBindingReport({ ...identity, ...guard, state: 'partial', reason: 'unsupported_jpa_kind',
    declaration: { ...declaration, kind: 'EMBEDDED' } }, identity).state, 'partial');
  assert.deepEqual(observedPropertyPaths(model), [['id', 'BASIC'], ['peers', 'ONE_TO_MANY'],
    ['scope', 'EMBEDDED'], ['scope.code', 'Embedded attribute']]);
});

test('registered attribute inspection selects one factory and nested path and honors cancellation', async t => {
  const selections = [], documents = [], registered = new Map();
  const config = await listener(t, async (request, response) => {
    if (request.method === 'GET') {
      response.end(JSON.stringify({ capabilities: { attributeBinding: true },
        factories: ['factory-1', 'factory-2'].map(id => ({ id, factoryName: 'Same Name', provider: 'hibernate', entities: [model] })),
        events: [] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    selections.push(JSON.parse(Buffer.concat(chunks)));
    response.end(JSON.stringify(observed));
  });
  class Emitter { event() { return { dispose() {} }; } fire() {} dispose() {} }
  let cancel = true;
  const vscode = {
    EventEmitter: Emitter,
    commands: { registerCommand(name, callback) { registered.set(name, callback); return { dispose() {} }; } },
    workspace: { isTrusted: true, async openTextDocument(value) { return value; } },
    window: {
      async showQuickPick(items, settings) {
        if (settings.title === 'Select a Running JPA Factory') {
          assert.match(items[0].description, /factory-1/u);
          assert.match(items[1].description, /factory-2/u);
          return items[1];
        }
        if (settings.title === 'Select a Managed JPA Entity') return items[0];
        return cancel ? undefined : items.find(item => item.label === identity.propertyPath);
      },
      async showTextDocument(document) { documents.push(document); }
    }
  };
  const service = registerObserver({}, vscode, { appendLine() {} }, { source: async () => ({ revision: 1, entities: [] }) });
  t.after(() => service.dispose());
  await service.connect(config);
  const inspect = registered.get('rocketbrain.jpa.observer.inspectAttributeBinding');
  await inspect();
  assert.equal(selections.length, 0);
  assert.equal(documents.length, 0);
  cancel = false;
  assert.deepEqual(await inspect(), observed);
  assert.deepEqual(selections, [identity]);
  assert.deepEqual(JSON.parse(documents[0].content), observed);
});
