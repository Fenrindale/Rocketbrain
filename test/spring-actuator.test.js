'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ActuatorClient, compareRuntime } = require('../src/spring/runtime-client');
const { analyzeSpring } = require('../src/spring/model');
const { filesUnder } = require('./spring-fixture');

test('real Spring Boot Actuator enriches source unknowns without retaining configuration values', { skip: !process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG, timeout: 45000 }, async t => {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG, 'utf8'));
  assert.ok(config.runtimeUrl && config.projectPath);
  const observer = new ActuatorClient({ url: config.runtimeUrl, timeoutMs: 10000, maxResponseBytes: 4 * 1024 * 1024 }); t.after(() => observer.dispose());
  const runtime = await observer.refresh();
  assert.equal(runtime.state, 'connected', JSON.stringify(runtime.endpoints));
  assert.ok(runtime.counts.beans > 10); assert.ok(runtime.counts.conditions > 0); assert.ok(runtime.counts.configurationProperties > 0); assert.ok(runtime.counts.propertyKeys > 0); assert.ok(runtime.counts.mappings > 0);
  const sources = filesUnder(path.join(config.projectPath, 'src/main/java'), /\.java$/);
  const propertiesRoot = path.join(config.projectPath, 'src/main/resources');
  const properties = fs.existsSync(propertiesRoot) ? filesUnder(propertiesRoot, /^application.*\.(?:properties|ya?ml)$/) : [];
  const local = analyzeSpring(sources, properties, { activeProfiles: runtime.environment.activeProfiles, closedWorld: false });
  const comparison = compareRuntime(local, runtime);
  const observedBeans = runtime.contexts.flatMap(context => context.beans);
  const expected = config.expectations || {};
  for (const key of ['conditionalBean', 'dynamicBean', 'factoryBean', 'proxiedBean']) if (expected[key]) assert.ok(observedBeans.some(bean => bean.name === expected[key]), `Runtime Bean ${expected[key]} is observed`);
  if (expected.conditionalBean) {
    const candidate = comparison.beans.find(bean => bean.name === expected.conditionalBean);
    assert.ok(candidate); assert.equal(candidate.staticState, 'unknown'); assert.equal(candidate.observation, 'present');
  }
  if (expected.dynamicBean) assert.equal(comparison.beans.find(bean => bean.name === expected.dynamicBean)?.observation, 'runtime-only');
  if (expected.configurationPrefix) assert.ok(runtime.configurationProperties.some(bean => bean.prefix === expected.configurationPrefix));
  if (expected.mappingPath) assert.ok(runtime.mappings.some(mapping => mapping.paths.includes(expected.mappingPath)));
  assert.equal(runtime.privacy.propertyValuesRetained, false); assert.equal(runtime.privacy.rawResponsesRetained, false);
  assert.ok(runtime.configurationProperties.every(bean => !Object.hasOwn(bean, 'properties') && !Object.hasOwn(bean, 'inputs')));
  assert.ok(runtime.conditions.every(condition => !Object.hasOwn(condition, 'message')));
  assert.ok(runtime.environment.sources.every(source => !Object.hasOwn(source, 'properties')));
  const engine = String(config.dbEngine || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  const report = { asOf: new Date().toISOString(), dbEngine: engine, runtimeUrl: runtime.baseUrl, projectPath: config.projectPath, endpoints: runtime.endpoints, counts: runtime.counts, activeProfiles: runtime.environment.activeProfiles, expectations: expected, observedExpectedBeans: observedBeans.filter(bean => Object.values(expected).includes(bean.name)).map(bean => ({ name: bean.name, type: bean.type, scope: bean.scope })), comparison: { summary: comparison.summary, sameSourceRevisionVerified: false, expectedBeans: comparison.beans.filter(bean => Object.values(expected).includes(bean.name)) }, privacy: runtime.privacy, checks: ['five real Actuator GET endpoints available', 'runtime Bean/condition/configprops/env/mapping metadata normalized', 'source model kept separate from execution observations', 'configuration values and raw condition messages discarded'], limitations: runtime.limitations };
  fs.mkdirSync(path.resolve(__dirname, '../test-output'), { recursive: true }); fs.writeFileSync(path.resolve(__dirname, `../test-output/`+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.4")+`-spring-runtime-${engine}.json`), JSON.stringify(report, null, 2));
});
