'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { testNgInvocationSource, assertObservedInvocations, assertRetry, assertOnlySelectedRow } = require('./helpers/java-testng-invocation-fixture');

async function observed(project, output) {
  const directory = project.runDirectory;
  assert.ok(path.isAbsolute(directory));
  const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
  assert.equal(owner.kind, 'RocketbrainJavaTestingRun-v1');
  assert.equal(owner.id, path.basename(directory));
  const eventFile = path.join(directory, 'events.jsonl');
  assert.ok((await fs.stat(eventFile)).size < 1024 * 1024);
  const events = (await fs.readFile(eventFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const tests = new Map(events.filter(event => event.test).map(event => [event.test.id, event.test]));
  return { ...project, events, tests: [...tests.values()], output };
}

async function runTestNgInvocationChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api, workspace);
  const className = 'RbTestNgInvocations' + randomBytes(5).toString('hex');
  const qualified = 'fixture.boot.' + className;
  const source = path.join(workspace, 'src/test/java/fixture/boot', className + '.java');
  const scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-testng-native-'));
  const marker = path.join(scratch, 'selected-row.txt');
  const markerOption = '-Drocketbrain.fixture.markerPath=' + marker;
  let written = false;
  try {
    await fs.writeFile(source, testNgInvocationSource('fixture.boot', className), { flag: 'wx' });
    written = true;
    await vscode.workspace.openTextDocument(vscode.Uri.file(source));
    const installed = await vscode.commands.executeCommand('rocketbrain.java.testing.install');
    assert.equal(installed.testngVersion, '7.11.0');
    const discovery = await api.javaTesting.discover();
    const current = () => api.javaTesting.snapshot().tests.filter(item => item.className === qualified && item.framework === 'testng');
    const owner = discovery.tests.find(item => item.className === qualified && item.framework === 'testng' && !item.methodName);
    assert.ok(owner && current().some(item => item.kind === 'container' && item.methodName === 'duplicate'));
    const run = (item, jvmArgs = []) => api.javaTesting.run({ includeIds: [item.nativeId], jvmArgs, build: false });
    const full = await run(owner);
    const { duplicate, retry } = assertObservedInvocations(await observed(full.projects[0]));
    const find = id => current().find(item => item.id === id);
    assert.ok(find(duplicate.id)?.rerunnable && find(retry.id)?.rerunnable);
    const selected = await run(find(duplicate.id), [markerOption]);
    assertOnlySelectedRow(await observed(selected.projects[0], await fs.readFile(marker, 'utf8')), duplicate);
    await fs.rm(marker);
    await assert.rejects(run(find(duplicate.id), [markerOption, '-Drocketbrain.fixture.changedOrder=true']), /no longer matches|cannot be replayed/);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    const failed = await run(find(retry.id), ['-Drocketbrain.fixture.retryFails=true']);
    assert.equal(failed.projects[0].summary.testsFailed, 1);
    assertRetry(await observed(failed.projects[0]), retry.id, 'failed');
    const recovered = await api.javaTesting.rerunFailed({ jvmArgs: [], build: false });
    assert.equal(recovered.projects.length, 1);
    assert.equal(recovered.projects[0].summary.testsSucceeded, 1);
    assert.equal(recovered.projects[0].summary.testsFound, 1);
    assertRetry(await observed(recovered.projects[0]), retry.id, 'passed');
    const jdbc = await jdbcReadback();
    assert.ok(jdbc, 'Use the owned Spring JDBC fixture for native invocation verification.');
    checks.push('Native TestNG reruns the selected second duplicate from the observed provider stream and refuses changed row order.');
    checks.push('Native failed-only rerun selects one TestNG invocation and observes its real retry analyzer through the terminal attempt.');
    return { springWorkspace: true, testng: installed.testngVersion, jdbc, duplicateOrdinal: duplicate.providerOccurrence,
      duplicateOriginalIndex: duplicate.providerIndex, exactDuplicateSelected: true, changedScheduleRefused: true,
      logicalInvocations: full.projects[0].summary.testsFound, attempts: full.projects[0].summary.testAttempts,
      terminalRetryFailure: true, nativeFailedOnlyRerun: true };
  } finally {
    try { if (written) await fs.rm(source, { force: true }); }
    finally { await fs.rm(marker, { force: true }); await fs.rmdir(scratch); }
  }
}

module.exports = { runTestNgInvocationChecks };
