'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { graphRegistry, registeredGraphApplications, appliedGraph } = require('../src/jpa/entity-graphs');
const { summarizePerformance } = require('../src/jpa/fetch-performance');
const { registerObserver } = require('../src/jpa/observer-vscode');

const graph = { name: 'Order.lines', rootJavaType: 'sample.Order', paths: ['lines', 'lines.quantity'], complete: true };
const factoryId = 'factory-2';
const guard = { observerExecutedSql: false, valuesRetained: false, applicationCallbacksInvoked: false };
const applied = { factoryId, semantic: 'FETCH', graph };
const complete = { requestId: 2, select: 1, phase: 'request', route: '/orders', completeRequest: true };
const namedActivity = { ...complete, applied };
const rawRegistry = activity => ({ factoryId, ...guard, state: 'observed', graphs: [graph],
  basis: 'jakarta-named-entity-graphs', activity: { state: 'observed', applications: activity } });

test('only same-factory exact registered graph shapes link to captured SELECTs', () => {
  const raw = rawRegistry([
    namedActivity,
    { ...complete, requestId: 3, applied: { ...applied, graph: { ...graph, name: null } } },
    { ...complete, requestId: 4, applied: { ...applied, graph: { ...graph, paths: ['lines'] } } },
    { ...complete, requestId: 5, applied: { ...applied, graph: { ...graph, complete: false } } },
    { ...complete, requestId: 6, applied: { ...applied, graph: { ...graph, rootJavaType: 'sample.Incompatible' } } }
  ]);
  const registry = graphRegistry(raw, factoryId);
  assert.deepEqual(registeredGraphApplications(registry, graph), [{ ...complete, semantic: 'FETCH' }]);
  assert.deepEqual(registeredGraphApplications(registry, { ...graph, complete: false }), []);
  for (const activity of [
    [{ ...namedActivity, route: '/orders?id=private' }],
    [{ ...namedActivity, applied: { ...applied, factoryId: 'factory-1' } }],
    [namedActivity, namedActivity]
  ]) assert.throws(() => graphRegistry(rawRegistry(activity), factoryId), /scoped|Duplicate/);
  assert.throws(() => graphRegistry({ ...raw, applicationCallbacksInvoked: true }, factoryId), /registry/);
  assert.equal(appliedGraph({ ...applied, graph: { ...graph, paths: ['lines;SELECT'] } }), undefined);
});

test('graph metadata in fetch activity remains separate from ordinary SELECT and bind evidence', () => {
  const sample = {
    id:1, complete:true, route:'/orders', durationMicros:20, dispatch:'synchronous',
    omittedSelects:0, omittedGraphApplications:2,
    selects:[
      { sequence:1, session:1, sql:'select o.id from orders o where o.id=?', durationMicros:10, phase:'request', entityGraph:applied },
      { sequence:2, session:1, sql:'select o.id from orders o', durationMicros:10, phase:'request',
        entityGraph:{...applied, semantic:'unsupported'} }
    ]
  };
  const observed = summarizePerformance({ enabled:true, available:true, callableObservation:true, scope:'spring-mvc',
    rawBindValuesRetained:false, observerExecutedSql:false, entityGraphObservation:'hibernate-applied-query-graph-v1', requests:[sample] });
  assert.equal(observed.requests[0].coverage,'complete-within-supported-hooks');
  assert.equal(observed.requests[0].omittedGraphApplications,2);
  assert.equal(observed.requests[0].selectCount,2);
  assert.deepEqual(observed.requests[0].selects[0].entityGraph,applied);
  assert.equal(observed.requests[0].selects[1].entityGraph,undefined);
});

test('registered VS Code action selects a factory, previews a name and displays only scoped evidence', async t => {
  const requests = [], commands = new Map(), documents = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.method + ' ' + request.url);
    if (request.method === 'GET') {
      response.end(JSON.stringify({ capabilities:{entityGraphs:true}, events:[],
        factories:['factory-1', factoryId].map(id => ({ id, factoryName:'Same Name', provider:'hibernate' })) }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { factoryId });
    response.end(JSON.stringify(rawRegistry([namedActivity])));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  class Emitter { event() { return { dispose() {} }; } fire() {} dispose() {} }
  let cancel = true, checkName = false;
  const vscode = {
    EventEmitter: Emitter,
    commands: { registerCommand(name, run) { commands.set(name, run); return { dispose() {} }; } },
    workspace: { isTrusted:true, async openTextDocument(value) { return value; } },
    window: {
      async showQuickPick(items, settings) {
        if (settings.title === 'Select a Running JPA Factory') return cancel ? undefined : items.find(item => item.value === factoryId);
        assert.equal(items[0].label, graph.name);
        return checkName ? items.at(-1) : items[0];
      },
      async showInputBox() { return 'Order.missing'; },
      async showTextDocument(document) { documents.push(document); }
    }
  };
  const observer = registerObserver({}, vscode, { appendLine() {} }, { source: async () => ({ entities: [] }) });
  t.after(() => observer.dispose());
  await observer.connect({ url:'http://127.0.0.1:' + server.address().port, token:'e'.repeat(64) });
  const inspect = commands.get('rocketbrain.jpa.observer.inspectEntityGraph');
  await inspect();
  assert.deepEqual(requests, ['GET /snapshot']);
  cancel = false;
  const report = await inspect();
  assert.equal(report.registration, 'observed');
  assert.deepEqual(report.retainedApplications, [{ ...complete, semantic: 'FETCH' }]);
  assert.deepEqual(JSON.parse(documents[0].content), report);
  assert.deepEqual(requests, ['GET /snapshot','POST /entity-graphs']);
  checkName = true;
  const absent = await inspect();
  assert.equal(absent.registration, 'absent');
  assert.deepEqual(absent.retainedApplications, []);
});
