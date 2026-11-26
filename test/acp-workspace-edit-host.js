'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const { prepareIsolatedAgent, runIsolatedAgent } = require('../src/ai/acp-isolated-peer');
const { prepareWorkspacePrompt, reviewWorkspaceEdit, normalize } = require('../src/ai/acp-workspace-edit');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { observePeer } = require('./acp-database-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const source = [
  { type: 'RbAcpGreetingFixture', before: '"blue"', after: '"green"', text:
    'package fixture.boot;\nimport org.springframework.stereotype.Component;\n@Component\npublic class RbAcpGreetingFixture {\n' +
    '  public String color() { return "blue"; }\n' +
    '  public static void main(String[] args) { System.out.println(new RbAcpLabelFixture().label() + ":" + new RbAcpGreetingFixture().color()); }\n}\n' },
  { type: 'RbAcpLabelFixture', before: '"local"', after: '"owned"', text:
    'package fixture.boot;\nimport org.springframework.stereotype.Component;\n@Component\npublic class RbAcpLabelFixture {\n' +
    '  public String label() { return "local"; }\n}\n' }
];
const request = 'In file1, change the exact quoted Java literal "blue" to "green". In file2, change the exact quoted Java literal "local" to "owned". Include both double quotes in find and replace. Preserve all other code.';

async function fixtureWorkspace(vscode) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const own = await fs.realpath(runtime.projectPath);
  if (!vscode) return { root: own, runtime };
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
  const roots = [];
  for (const folder of folders) {
    const match = await Promise.all(['build.gradle','settings.gradle'].map(async name => {
      try { return (await fs.readFile(path.join(folder.uri.fsPath, name))).equals(await fs.readFile(path.join(own, name))); }
      catch { return false; }
    }));
    if (match.every(Boolean)) roots.push(folder.uri.fsPath);
  }
  assert.equal(roots.length, 1, 'The native test requires the same owned Spring project in the active workspace.');
  return { root: await fs.realpath(roots[0]), runtime };
}

async function compileActualSpring(folder, runtime, files, expected) {
  const classpath = await fs.readFile(path.join(runtime.projectPath, 'build', 'runtime-classpath.txt'), 'utf8');
  const workbench = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG && JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const home = process.env.ROCKETBRAIN_SPRING_JAVA_HOME || workbench?.javaHome ||
    path.resolve(__dirname, '../research/implementation/runtimes/temurin25/extracted/jdk-25.0.5+8');
  const version = await fs.readFile(path.join(home, 'release'), 'utf8');
  assert.match(version, /JAVA_VERSION="25\./);
  assert.doesNotMatch(version, /JetBrains|JBR/i);
  const exe = name => path.join(home, 'bin', process.platform === 'win32' ? name + '.exe' : name);
  const output = await fs.mkdtemp(path.join(folder, 'rb-acp-compiled-'));
  try {
    const spring = classpath.trim().split(path.delimiter).find(entry => /^spring-context-[\d.]+\.jar$/i.test(path.basename(entry)));
    assert.ok(spring && (await fs.stat(spring)).isFile(), 'Use the real Spring application compiler classpath.');
    const options = { cwd: folder, windowsHide: true, encoding: 'utf8', timeout: 30000 };
    const built = spawnSync(exe('javac'), ['-encoding', 'UTF-8', '-cp', spring, '-d', output, ...files], options);
    assert.equal(built.status, 0, built.stderr || built.error?.message);
    const run = spawnSync(exe('java'), ['-cp', [output, spring].join(path.delimiter), 'fixture.boot.RbAcpGreetingFixture'], options);
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.equal(run.stdout.trim(), expected);
  } finally {
    const cleanup = await fs.realpath(output);
    assert.equal(path.dirname(cleanup), folder);
    assert.match(path.basename(cleanup), /^rb-acp-compiled-/);
    await fs.rm(cleanup, { recursive: true, maxRetries: 6, retryDelay: 150 });
  }
}

async function exercise(peer, model, vscode, adapter) {
  const { root, runtime } = await fixtureWorkspace(vscode);
  const originals = new Map(), documents = [];
  try {
    const folder = path.join(root, 'src/main/java/fixture/boot');
    for (const [index, item] of source.entries()) {
      const file = path.join(folder, item.type + '.java');
      const text = index ? item.text.replaceAll('\n', '\r\n') : item.text;
      await fs.writeFile(file, text, { flag: 'wx' });
      originals.set(file, text);
    }
    const files = [...originals.keys()];
    await compileActualSpring(root, runtime, files, 'local:blue');
    if (adapter) {
      const uris = files.map(file => vscode.Uri.file(file));
      for (const uri of uris) documents.push(await vscode.workspace.openTextDocument(uri));
      const preview = await adapter.stage({ uris, input: request, agentLabel: 'Local OpenCode' });
      assert.equal(preview.agent.endpoint, model.endpoint);
      assert.match(preview.text, /RbAcpGreetingFixture/);
      for (const original of originals.values()) assert.ok(preview.text.includes(JSON.stringify(normalize(original)).slice(1,-1)));
      await assert.rejects(adapter.generate(preview.id, { confirmed: false }), /Review the exact executable/);
      const result = await adapter.generate(preview.id, { confirmed: true });
      await assert.rejects(adapter.generate(preview.id, { confirmed: true }), /expired/);
      assert.equal(result.files.length, 2);
      for (const file of result.files) {
        const diff = await adapter.openDiff(result.id, file.id);
        const before = await vscode.workspace.openTextDocument(diff.before), after = await vscode.workspace.openTextDocument(diff.after);
        const index = Number(file.id.replace('file','')) - 1;
        assert.equal(normalize(before.getText()), source[index].text);
        assert.equal(normalize(after.getText()), source[index].text.replace(source[index].before, source[index].after));
      }
      await assert.rejects(adapter.apply(result.id, { confirmed: false, fingerprint: result.fingerprint }), /Approve the exact set/);
      await assert.rejects(adapter.apply(result.id, { confirmed: true, fingerprint: 'changed' }), /Approve the exact set/);
      assert.deepEqual(await adapter.apply(result.id, { confirmed: true, fingerprint: result.fingerprint }), { applied: true, files: 2, saved: false });
      await assert.rejects(adapter.apply(result.id, { confirmed: true, fingerprint: result.fingerprint }), /expired/);
      for (const [index, doc] of documents.entries()) {
        const deadline = Date.now() + 2000;
        while (!doc.isDirty && Date.now() < deadline) await wait(25);
        assert.equal(doc.isDirty, true);
        assert.equal(await fs.readFile(files[index], 'utf8'), originals.get(files[index]));
        assert.equal(normalize(doc.getText()), source[index].text.replace(source[index].before, source[index].after));
      }
      for (const doc of documents) assert.equal(await doc.save(), true);
    } else {
      const agent = await prepareIsolatedAgent({ label: 'Local OpenCode', executable: peer.executable, adapter: 'opencode-local' }, model);
      const ready = prepareWorkspacePrompt(files.map((file, index) => ({ name: path.relative(root, file), text: source[index].text })), request);
      const response = await runIsolatedAgent(agent, { text: ready.text, schema: ready.schema, schemaName: ready.schemaName });
      assert.equal(response.denied, 0);
      const reviewed = reviewWorkspaceEdit(ready, response);
      for (const [index, edit] of reviewed.edits.entries()) {
        assert.equal(edit.after, source[index].text.replace(source[index].before, source[index].after));
        assert.equal(await fs.readFile(files[index], 'utf8'), originals.get(files[index]));
        await fs.writeFile(files[index], index ? edit.after.replaceAll('\n','\r\n') : edit.after);
      }
    }
    await compileActualSpring(root, runtime, files, 'owned:green');
    return { engine: runtime.dbEngine, openCodeVersion: peer.version, realLocalModel: true, sources: 2, springCompiledBefore: true,
      springCompiledAfter: true, expectedRuntimeResult: 'owned:green', reviewedReadOnlyDiffs: Boolean(adapter), savedOnlyByExplicitAction: true,
      realNativeMultiEdit: Boolean(adapter), jdbc: await jdbcReadback() };
  } finally {
    for (const document of documents) if (document.isDirty) await document.save();
    for (const file of originals.keys()) await fs.unlink(file);
  }
}

async function runAcpWorkspaceEditChecks(api, vscode, checks) {
  await fixtureConfig();
  const peer = await observePeer(), model = await startLocalModel();
  const code = vscode.workspace.getConfiguration('rocketbrain.localCodeModel');
  const acp = vscode.workspace.getConfiguration('rocketbrain.acp');
  const keys = ['endpoint', 'model'];
  const before = Object.fromEntries(keys.map(key => [key, code.inspect(key)?.workspaceValue]));
  const configured = acp.inspect('workspaceEditOpenCodePath')?.workspaceValue;
  try {
    for (const key of keys) await code.update(key, model[key], vscode.ConfigurationTarget.Workspace);
    await acp.update('workspaceEditOpenCodePath', peer.executable, vscode.ConfigurationTarget.Workspace);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.acp.reviewWorkspaceEdit'));
    const result = await exercise(peer, model, vscode, api.acpReview.workspaceEdits);
    checks.push('The installed ACP workflow received two local OpenCode/Qwen edits, showed exact immutable diffs, applied one approved WorkspaceEdit, then compiled and ran both saved Spring components against real dependencies.');
    return result;
  } finally {
    try {
      await acp.update('workspaceEditOpenCodePath', configured, vscode.ConfigurationTarget.Workspace);
      for (const key of keys) await code.update(key, before[key], vscode.ConfigurationTarget.Workspace);
    } finally { await model.close(); }
  }
}

if (require.main === module) fixtureConfig().then(async () => {
  const peer = await observePeer(), model = await startLocalModel();
  try { console.log(JSON.stringify(await exercise(peer, model))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runAcpWorkspaceEditChecks };
