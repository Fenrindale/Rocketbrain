'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runSpringActuatorHealthChecks(api, vscode, checks) {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(config.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.equal(new URL(config.runtimeUrl).hostname, '127.0.0.1');
  assert.equal(new URL(config.baseUrl).hostname, '127.0.0.1');
  const runtime = api.java.spring.runtime, health = runtime.health;
  const command = 'rocketbrain.spring.runtimeHealth';
  assert.ok((await vscode.commands.getCommands(true)).includes(command));
  const direct = async suffix => {
    const response = await fetch(config.runtimeUrl + '/health' + suffix, { signal: AbortSignal.timeout(9000) });
    return { data: await response.json(), http: response.status };
  };
  const eventStates = [];
  const subscription = health.onDidChange(snapshot => eventStates.push(snapshot.state));
  try {
    assert.equal((await vscode.commands.executeCommand(command)).state, 'disconnected');
    const connected = await runtime.connect({ url: config.runtimeUrl, timeoutMs: 10000 });
    assert.equal(connected.state, 'connected');
    assert.equal(health.snapshot().state, 'ready');
    const overview = await vscode.commands.executeCommand(command);
    const published = await direct('');
    assert.equal(overview.state, 'observed');
    assert.equal(overview.observation.status, published.data.status);
    assert.equal(overview.observation.status, 'UP');
    assert.equal(overview.observation.httpStatus, 200);
    assert.equal(overview.observation.httpStatus, published.http);
    assert.equal(overview.observation.visibility, 'components');
    const groups = overview.observation.groups.map(group => group.name).sort();
    assert.ok(groups.includes('liveness') && groups.includes('readiness'));
    assert.deepEqual(groups, [...published.data.groups].sort());
    assert.deepEqual(overview.observation.components.map(({ name, status }) => [name, status]),
      Object.entries(published.data.components).map(([name, child]) => [name, child.status]));
    const readiness = await health.select(overview.choices.findIndex(choice => choice.kind === 'group' && choice.name === 'readiness'));
    assert.deepEqual(readiness.path.map(step => step.name), ['readiness']);
    assert.equal(readiness.observation.status, 'UP');
    assert.equal(readiness.observation.status, (await direct('/readiness')).data.status);

    const returned = await health.back();
    assert.deepEqual(returned.path, []);
    const database = await health.select(returned.choices.findIndex(choice => choice.kind === 'component' && choice.name === 'db'));
    assert.deepEqual(database.path.map(step => step.name), ['db']);
    const actualDatabase = await direct('/db');
    assert.equal(database.observation.status, actualDatabase.data.status);
    assert.equal(database.observation.status, 'UP');
    assert.equal(database.observation.httpStatus, actualDatabase.http);
    assert.equal(database.observation.visibility, 'status-only');
    assert.deepEqual(database.observation.components, []);
    assert.equal(database.observation.detailsRetained, false);
    assert.equal(Object.hasOwn(database.observation, 'details'), false);
    const refreshed = await health.refresh();
    assert.equal(refreshed.observation.status, database.observation.status);
    assert.deepEqual(refreshed.path, database.path);
    assert.ok(eventStates.filter(state => state === 'observed').length >= 5);

    runtime.disconnect();
    assert.deepEqual(health.snapshot(), { state: 'disconnected', path: [], observation: null, choices: [] });
    const response = await fetch(config.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(9000) });
    assert.equal(response.ok, true);
    const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
    assert.deepEqual(await response.json(), springIsolation);
    checks.push('The native Health panel matched the actual Spring aggregate, readiness group and database contributor with read-only detail handling and explicit disconnection.');
    return { engine: config.dbEngine, overviewStatus: overview.observation.status, overviewHttpStatus: overview.observation.httpStatus,
      groups, readinessStatus: readiness.observation.status, databaseStatus: database.observation.status, databaseStatusOnly: true,
      detailsRetained: false, refreshed: true, staleCleared: true, springIsolation };
  } finally {
    subscription.dispose();
    health.close();
    runtime.disconnect();
  }
}

module.exports = { runSpringActuatorHealthChecks };
