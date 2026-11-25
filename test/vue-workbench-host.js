'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectVueProject, selectNode, checkVueProject, vueDefinition, startVueServer } = require('../src/web/vue-tools');
const { ownedVueFixture } = require('./helpers/vue-workspace-fixture');

async function verifyVueWorkbench(root, node) {
  const file = path.join(root, 'src', 'App.vue');
  assert.equal(await fs.realpath(file), file);
  const original = await fs.readFile(file, 'utf8');
  const project = await inspectVueProject(root, file);
  const versions = Object.fromEntries(Object.entries(project.installed).map(([name, item]) => [name, item.version]));
  assert.deepEqual(versions, { '@vue/compiler-sfc': '3.5.46', typescript: '5.9.3', 'vue-tsc': '3.3.14', vite: '8.3.8' });
  const definition = offset => vueDefinition(project, node, { file, source: original, offset });
  const component = await definition(original.indexOf('<CountBadge') + 3);
  assert.equal(component.file, path.join(root, 'src', 'CountBadge.vue'));
  assert.equal(original.slice(component.origin.start, component.origin.end), 'CountBadge');
  const binding = await definition(original.indexOf('{{ count') + 4);
  assert.equal(binding.file, file);
  assert.equal(binding.target.start, original.indexOf('const count') + 'const '.length);
  const directive = await definition(original.indexOf('="count"') + 3);
  assert.deepEqual(directive.target, binding.target);
  const shadowed = original.replace('<output>{{ count }}</output>', '<output v-for="count in [1]">{{ count }}</output>');
  assert.equal(await vueDefinition(project, node, { file, source: shadowed, offset: shadowed.indexOf('{{ count') + 4 }), null);
  const clean = await checkVueProject(project, node);
  assert.deepEqual(clean, { diagnostics: [], projectDiagnostics: [], skipped: 0, clean: true });
  const invalid = original.replace(':count="count"', ':count="\'wrong\'"').replace('{{ count }}', '{{ missingBinding }}');
  let errors;
  try {
    await fs.writeFile(file, invalid);
    const report = await checkVueProject(project, node);
    assert.equal(report.clean, false);
    assert.equal(report.skipped, 0);
    errors = report.diagnostics.map(({ code, line, column }) => ({ code, line, column }));
    assert.deepEqual(errors.map(item => item.code).sort(), ['TS2322', 'TS2339']);
    for (const item of report.diagnostics) assert.equal(item.file, file);
    assert.match(invalid.split(/\r?\n/)[errors.find(item => item.code === 'TS2339').line], /missingBinding/);
  } finally { await fs.writeFile(file, original); }
  assert.equal((await checkVueProject(project, node)).clean, true);
  const server = await startVueServer(project, node);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(server.url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Rocketbrain Vue fixture/);
    const sfc = await fetch(new URL('/src/App.vue', server.url), { redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(sfc.status, 200);
    const compiled = await sfc.text();
    assert.match(compiled, /createElementVNode|createElementBlock/);
    assert.match(compiled, /CountBadge/);
  } finally { await server.stop(); }
  await assert.rejects(fetch(server.url, { signal: AbortSignal.timeout(2000) }));
  return { versions, strictTemplateDiagnostics: errors, cleanAfterRestore: true, templateComponentLink: true, templateBindingLink: true,
    directiveBindingLink: true, noLinkForShadowedBinding: true, authenticViteLoopback: true, transformedVueModule: true, stoppedOwnedServer: true };
}

async function runVueWorkbenchChecks(api, vscode, checks) {
  const root = await ownedVueFixture(process.env.ROCKETBRAIN_VUE_FIXTURE);
  const node = await selectNode(process.env.ROCKETBRAIN_VUE_NODE_PATH);
  const uri = vscode.Uri.file(path.join(root, 'src', 'App.vue'));
  assert.ok(vscode.workspace.getWorkspaceFolder(uri), 'Stage the Vue fixture inside the native test workspace.');
  const document = await vscode.workspace.openTextDocument(uri);
  assert.equal(document.languageId, 'vue');
  const settings = vscode.workspace.getConfiguration('rocketbrain.vue', uri);
  const values = { enableDefinitions: true, nodePath: node };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, settings.inspect(key)?.workspaceValue]));
  try {
    for (const [key, value] of Object.entries(values)) await settings.update(key, value, vscode.ConfigurationTarget.Workspace);
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['checkProject', 'startDevServer', 'stopDevServer']) assert.ok(commands.includes('rocketbrain.vue.' + name));
    assert.equal(path.relative((await api.vue.inspect(uri)).root, root), '');
    const source = document.getText();
    const location = async offset => (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, document.positionAt(offset)))[0];
    const component = await location(source.indexOf('<CountBadge') + 3);
    assert.equal(path.relative((component.targetUri ?? component.uri).fsPath, path.join(root, 'src', 'CountBadge.vue')), '');
    const binding = await location(source.indexOf('{{ count') + 4);
    assert.equal(path.relative((binding.targetUri ?? binding.uri).fsPath, uri.fsPath), '');
    const range = binding.targetSelectionRange ?? binding.range;
    assert.equal(document.getText(range), 'count');
    const report = await verifyVueWorkbench(root, node);
    checks.push('Installed Vue Go to Definition resolved a component and its script setup binding. Real vue-tsc checked strict template types and Vite served a transformed module.');
    return { ...report, nativeVueLanguage: true, nativeGoToDefinition: true };
  } finally {
    for (const [key, value] of Object.entries(previous)) await settings.update(key, value, vscode.ConfigurationTarget.Workspace);
  }
}

if (require.main === module) (async () => {
  const root = await ownedVueFixture(process.env.ROCKETBRAIN_VUE_FIXTURE);
  const node = await selectNode(process.env.ROCKETBRAIN_VUE_NODE_PATH ?? process.execPath);
  console.log(JSON.stringify(await verifyVueWorkbench(root, node)));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runVueWorkbenchChecks, verifyVueWorkbench };
