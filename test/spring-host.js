'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

async function eventually(action, timeout = 15000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { try { const result = await action(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 150)); } throw last || new Error('Spring editor check timed out.'); }
function positionOf(document, marker, offset = 0) { const start = document.getText().indexOf(marker); assert.ok(start >= 0, `Missing Spring fixture marker: ${marker}`); return document.positionAt(start + offset); }

async function runSpringChecks(api, vscode, checks) {
  assert.ok(api.java?.spring?.analyze, 'Independent Spring semantic API is available');
  const model = await api.java.spring.refresh();
  assert.equal(model.mode, 'local-semantic-index');
  assert.ok(model.profiles.includes('prod'), 'Host profile must explicitly select prod');
  assert.equal(model.beans.find(bean => bean.name === 'redPort')?.state, 'active');
  assert.equal(model.beans.find(bean => bean.name === 'devPort')?.state, 'inactive');
  const preferred = model.injections.find(item => item.owner === 'fixtures.valid.Consumer' && item.name === 'preferred');
  assert.equal(model.beans.find(bean => bean.id === preferred?.resolution.selected[0])?.name, 'redPort');
  assert.equal(model.beans.find(bean => bean.name === 'unknownThing')?.state, 'unknown');
  checks.push('Spring editor model resolves Primary/Profile candidates and leaves custom runtime Conditions unknown.');
  const source = vscode.Uri.file(path.join(__dirname, 'fixtures/spring-analysis/src/fixtures/valid/Consumer.java'));
  const document = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(document);
  const original = document.getText();
  const beanLocations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', source, positionOf(document, '@Qualifier("blue")', '@Qualifier("'.length));
  assert.ok(beanLocations.some(item => (item.uri || item.targetUri).path.endsWith('/BluePort.java')));
  const valueLocations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', source, positionOf(document, '${app.greeting', 3));
  assert.ok(valueLocations.some(item => (item.uri || item.targetUri).path.endsWith('/application.properties')));
  assert.ok(valueLocations.some(item => (item.uri || item.targetUri).path.endsWith('/application-prod.properties')));
  checks.push('Spring @Qualifier and @Value definition providers navigate across Java and active-profile configuration files.');
  const settingsUri = vscode.Uri.file(path.join(__dirname, 'fixtures/spring-analysis/src/fixtures/valid/Settings.java'));
  const settings = await vscode.workspace.openTextDocument(settingsUri);
  const settingsLocations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', settingsUri, positionOf(settings, 'String person', 8));
  assert.ok(settingsLocations.some(item => (item.uri || item.targetUri).path.endsWith('/application-prod.properties')));
  checks.push('Spring ConfigurationProperties scalar JavaBean fields navigate to their local configuration source.');
  const badQualifier = positionOf(document, '@Qualifier("blue")', '@Qualifier("'.length), end = badQualifier.translate(0, 4);
  const edit = new vscode.WorkspaceEdit(); edit.replace(source, new vscode.Range(badQualifier, end), 'notDeclared');
  await vscode.workspace.applyEdit(edit);
  try {
    await api.java.spring.refresh();
    const diagnostic = await eventually(() => vscode.languages.getDiagnostics(source).find(item => item.source === 'Rocketbrain Spring (local model)' && item.code === 'spring.bean.missing'));
    assert.match(diagnostic.message, /closed local model/);
    checks.push('An unsaved qualifier change publishes a real Spring diagnostic under the explicitly closed fixture model.');
  } finally {
    const restore = new vscode.WorkspaceEdit(); restore.replace(source, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
    await vscode.workspace.applyEdit(restore); await api.java.spring.refresh();
  }
  assert.equal(vscode.languages.getDiagnostics(source).some(item => item.source === 'Rocketbrain Spring (local model)' && item.code === 'spring.bean.missing'), false);
  return { springMode: model.mode, activeProfiles: model.profiles, localBeanCount: model.beans.length, unresolvedConditionsAreUnknown: true, realContainerComparison: 'test-output/spring-runtime/report.json', fullSpringParityVerified: false };
}

async function runSpringRuntimeChecks(api, vscode, checks, explicitConfig) {
  const config = explicitConfig || JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG, 'utf8'));
  assert.ok(api.java?.spring?.runtime, 'Independent Spring runtime observer is registered');
  const observer = api.java.spring.runtime, events = [];
  const subscription = observer.onDidChange(value => events.push(value.state));
  try {
    const runtime = await observer.connect({ url: config.runtimeUrl, timeoutMs: 10000, maxResponseBytes: 4 * 1024 * 1024 });
    assert.equal(runtime.state, 'connected', JSON.stringify(runtime.endpoints));
    assert.ok(events.includes('connecting') && events.includes('connected'));
    assert.ok(runtime.counts.beans > 10 && runtime.counts.mappings > 0);
    if (api.analysis) {
      const visible = await api.analysis.snapshot();
      assert.equal(visible.runtimeState, 'connected'); assert.equal(visible.observedBeans, runtime.counts.beans);
    }
    const expected = config.expectations || {}, beans = runtime.contexts.flatMap(context => context.beans);
    for (const key of ['conditionalBean', 'dynamicBean', 'factoryBean', 'proxiedBean']) if (expected[key]) assert.ok(beans.some(bean => bean.name === expected[key]));
    checks.push('Spring runtime observer explicitly connects to five real loopback Actuator endpoints and publishes sanitized observation events.');
    assert.equal(runtime.privacy.propertyValuesRetained, false); assert.equal(runtime.privacy.conditionMessagesRetained, false);
    assert.ok(runtime.environment.sources.every(source => Object.hasOwn(source, 'keys') && !Object.hasOwn(source, 'properties')));
    assert.ok(runtime.configurationProperties.every(bean => !Object.hasOwn(bean, 'properties') && !Object.hasOwn(bean, 'inputs')));
    const comparison = await observer.compare(); assert.equal(comparison.mode, 'static-runtime-comparison'); assert.equal(comparison.sameSourceRevisionVerified, false);
    const local = await api.java.spring.analyze();
    for (const bean of comparison.beans.filter(bean => bean.staticState === 'unknown')) assert.equal(local.beans.find(candidate => candidate.id === bean.staticId)?.state, 'unknown');
    checks.push('Spring runtime comparison preserves static unknowns and keeps actual metadata separate without property values or raw condition messages.');
    await observer.refresh(); observer.disconnect();
    assert.equal(observer.snapshot().state, 'disconnected'); assert.equal(observer.snapshot().contexts.length, 0);
    checks.push('Spring runtime refresh and explicit disconnect update the live observer without retaining stale observations.');
    return { dbEngine: config.dbEngine, endpoints: runtime.endpoints, counts: runtime.counts, privacy: runtime.privacy, comparison: comparison.summary, fullSpringParityVerified: false };
  } finally { observer.disconnect(); subscription.dispose(); }
}

module.exports = { runSpringChecks, runSpringRuntimeChecks };
