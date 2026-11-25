'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { ObserverClient } = require('../src/jpa/observer-client');
const { startReactiveSecurityFixture } = require('./helpers/spring-reactive-security-fixture');

const view = 'rocketbrain.spring.reactiveSecurityTrace';
const title = 'Reactive Spring Security Trace';
const canary = 'request-private-reactive-security';
const expectedHooks = ['proxy', 'filter-execution', 'web-verification', 'method-before', 'method-after'];

async function verify(config, showNative, observerJar) {
  const off = await startReactiveSecurityFixture(config, { enabled: false, observerJar });
  const disabled = new ObserverClient(off.observer);
  try {
    assert.deepEqual(await disabled.reactiveSecurityTrace(), {
      schemaVersion: 1, enabled: false, state: 'disabled', hooks: [], dropped: 0, traces: []
    });
  } finally { disabled.dispose(); await off.close(); }

  const fixture = await startReactiveSecurityFixture(config, { observerJar });
  const client = new ObserverClient({ ...fixture.observer, timeoutMs: 10000 });
  const send = (route, method, account) => fetch(fixture.baseUrl + '/rb/' + route + '?private=' + canary, {
    method, headers: { Authorization: fixture.authorization(account), 'X-Private': canary },
    redirect: 'manual', signal: AbortSignal.timeout(10000)
  });
  const newestId = report => Math.max(0, ...report.traces.map(sample => sample.id));
  async function waitFor(check) {
    const deadline = Date.now() + 8000;
    let value;
    while (Date.now() < deadline) {
      try { value = await client.reactiveSecurityTrace(); }
      catch (error) {
        if (error.code !== 'HTTP_ERROR' && error.code !== 'TIMEOUT') throw error;
      }
      if (value && check(value)) return value;
      await delay(80);
    }
    const status = (await client.refresh()).warnings;
    assert.fail('No expected reactive trace: ' + JSON.stringify({value, status}));
  }
  try {
    const history = await waitFor(report => report.traces.length > 0);
    const cut = newestId(history);
    const web = await send('web-denied', 'GET', fixture.viewer);
    assert.equal(web.status, 403);
    await web.text();
    const deniedWeb = (await waitFor(report => newestId(report) > cut)).traces.find(sample => sample.id > cut);
    assert.equal(deniedWeb.verification, 'denied');
    assert.equal(deniedWeb.status, 403);
    assert.equal(deniedWeb.methodDecisions.length, 0);
    assert.ok(deniedWeb.entered < deniedWeb.configured.length, JSON.stringify(deniedWeb));

    async function testPair(account, status, decision) {
      const cutoff = newestId(await client.reactiveSecurityTrace());
      const responses = await Promise.all([send('pre', 'GET', account), send('post', 'POST', account)]);
      for (const response of responses) {
        assert.equal(response.status, status);
        if (status === 200) {
          assert.deepEqual(await response.json(), { value: 42, jdbc: Boolean(config), schedulerChanged: true });
        } else await response.text();
      }
      const report = await waitFor(value => value.traces.filter(sample => sample.id > cutoff).length === 2);
      assert.deepEqual(new Set(report.hooks), new Set(expectedHooks), JSON.stringify((await client.refresh()).warnings));
      const traces = report.traces.filter(sample => sample.id > cutoff);
      for (const [method, phase] of [['GET', 'before'], ['POST', 'after']]) {
        const trace = traces.find(item => item.method === method);
        assert.ok(trace, JSON.stringify(report));
        assert.equal(trace.status, status, JSON.stringify(trace));
        assert.equal(trace.verification, 'passed', JSON.stringify(trace));
        assert.equal(trace.terminal, 'completed', JSON.stringify(trace));
        assert.equal(trace.coverage, 'observed', JSON.stringify(trace));
        assert.deepEqual(trace.matches.map(item => item.matched), [false, true]);
        assert.equal(trace.selectedChain, 1);
        assert.equal(trace.entered, trace.configured.length);
        assert.equal(trace.configured.filter(name => name === 'fixture.reactive.ReactiveSecurityFixture$HopFilter').length, 2);
        assert.deepEqual(trace.methodDecisions, [{ phase, owner: 'fixture.reactive.Permissions', method: phase, decision,
          parameterTypes: phase === 'before' ? ['java.lang.String'] : [] }]);
      }
      return report;
    }
    await testPair(fixture.viewer, 403, 'denied');
    const report = await testPair(fixture.ops, 200, 'granted');
    const counters = await send('counters', 'GET', fixture.ops);
    assert.equal(counters.status, 200);
    assert.deepEqual(await counters.json(), { before: 1, after: 2 });

    const endpoint = fixture.observer.url + '/reactive-security-trace';
    const unauthorized = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    assert.equal(unauthorized.status, 401);
    const request = await fetch(endpoint, {
      headers: { Authorization: 'Bearer ' + fixture.observer.token }, signal: AbortSignal.timeout(5000)
    });
    assert.equal(request.status, 200);
    const raw = await request.text();
    for (const privateValue of [canary, '/rb/', 'ROLE_', fixture.ops.name, fixture.ops.password, fixture.viewer.name,
      fixture.viewer.password, fixture.authorization(fixture.ops), fixture.observer.token])
      assert.equal(raw.includes(privateValue), false, 'Private value leaked from observer endpoint');

    if (showNative) await showNative(fixture.observer);
    return { engine: config?.dbEngine ?? null, actualJdbc: Boolean(config), webDenied: true, beforeDecisions: ['denied', 'granted'],
      afterDecisions: ['denied', 'granted'], schedulerHop: true, concurrentCorrelation: true, duplicateFilterInstances: true,
      hooks: report.hooks, optedIn: true, disabledByDefault: true, privateValuesDiscarded: true, beforeReads: 1, afterReads: 2,
      nativeReactiveSecurity: Boolean(showNative) };
  } finally { client.dispose(); await fixture.close(); }
}

async function runReactiveSpringSecurityChecks(api, vscode, checks) {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.ok(['mysql', 'mariadb'].includes(config.dbEngine));
  const prepared = await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
  assert.equal(prepared.securityReactiveTraceEnabled, false);
  const defaults = JSON.parse(await fs.readFile(prepared.configFile, 'utf8'));
  assert.equal(defaults.securityReactiveTrace, false);
  const receipt = await verify(config, async observer => {
    await api.jpa.observer.connect(observer);
    try {
      const opened = await vscode.commands.executeCommand(view);
      assert.equal(opened?.view, view);
      assert.ok(opened.traces.some(trace => trace.verification === 'denied'));
      const decisions = opened.traces.flatMap(trace => trace.methodDecisions);
      assert.ok(decisions.some(item => item.phase === 'before' && item.decision === 'denied'));
      assert.ok(decisions.some(item => item.phase === 'after' && item.decision === 'granted'));
      const visible = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === title));
      const deadline = Date.now() + 5000;
      while (!visible() && Date.now() < deadline) await delay(50);
      assert.ok(visible());
    } finally { api.jpa.observer.disconnect(); }
  }, prepared.jar);
  checks.push('The installed reactive Spring Security observer shows bounded WebFlux and method decisions across actual scheduler hops.');
  return receipt;
}

module.exports = { verify, runReactiveSpringSecurityChecks };
if (require.main === module) {
  const file = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
  (file ? fs.readFile(file, 'utf8').then(JSON.parse) : Promise.resolve(undefined))
    .then(config => verify(config)).then(report => console.log(JSON.stringify(report)), error => {
      console.error(error.stack);
      process.exitCode = 1;
    });
}
