'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { sameWslPath, wslUnc } = require('../src/remote/wsl-paths');
const { until } = require('./helpers/stdio-lsp');

const execute = promisify(execFile);
const sourceFile = 'src/main/java/fixture/WslSpringConfiguration.java';

async function linuxCommand(distribution, command, ...args) {
  const wslExe = path.join(process.env.SystemRoot, 'System32', 'wsl.exe');
  const result = await execute(wslExe, ['--distribution', distribution, '--exec', command, ...args],
    { windowsHide: true, timeout: 12000, maxBuffer: 4096 });
  return result.stdout.trim();
}

async function awaitCancellationMarker(file) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    if (await fs.access(file).then(() => true, () => false)) return;
    await delay(200);
  }
  throw Error('Gradle did not reach the cancellation fixture.');
}

async function verifyWslDebugger(debug, vscode, folder, source, document) {
  const jar = vscode.Uri.joinPath(folder.uri, 'target', 'spring-workbench-1.0.0-debug.jar');
  const result = vscode.Uri.joinPath(folder.uri, 'wsl-debug-result.txt');
  const originalJar = await fs.readFile(jar.fsPath);
  const stale = await debug.review(source, jar);
  const approve = item => ({ token: item.token, allowWslJavaDebug: true });
  try {
    await fs.appendFile(jar.fsPath, '\n');
    await assert.rejects(debug.start(source, approve(stale)), /changed after review/u);
  } finally { await fs.writeFile(jar.fsPath, originalJar); }
  await assert.rejects(debug.start(source, approve(stale)), /current WSL Java debug launch review/u);
  await assert.rejects(fs.access(result.fsPath), { code: 'ENOENT' });

  const line = document.getText().split(/\r?\n/u).findIndex(item => item.includes('// DEBUG_GATE'));
  assert.ok(line > 0);
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(line, 0)));
  const events = [];
  const sessions = new Map();
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', { createDebugAdapterTracker(session) {
    sessions.set(session.id, session);
    console.log('WSL debugger created its session.');
    return { onDidSendMessage(message) {
      if (message.type === 'event') events.push({ session, message });
      if (message.type === 'response' && ['initialize', 'attach'].includes(message.command)) {
        console.log('WSL debugger', message.command, 'success:', message.success, message.message || '');
      }
    } };
  } });
  vscode.debug.addBreakpoints([breakpoint]);
  try {
    const approval = await debug.review(source, jar);
    assert.equal(approval.jarSha256, createHash('sha256').update(originalJar).digest('hex'));
    const opened = await debug.start(source, approve(approval));
    const session = await until(() => sessions.get(opened.sessionId), 20000);
    const stop = reason => until(() => events.find(item => item.session.id === session.id && item.message.event === 'stopped' &&
      item.message.body.reason === reason)?.message.body, 50000);
    const paused = await stop('breakpoint');
    const stack = (await session.customRequest('stackTrace', { threadId: paused.threadId })).stackFrames;
    assert.match(stack[0].name, /WslSpringConfiguration\.main/u);
    assert.equal(stack[0].line, line + 1);
    assert.ok(sameWslPath(wslUnc(stack[0].source?.path), wslUnc(source.fsPath)));
    const { scopes } = await session.customRequest('scopes', { frameId: stack[0].id });
    const variables = await Promise.all(scopes.filter(scope => scope.variablesReference).map(scope =>
      session.customRequest('variables', { variablesReference: scope.variablesReference })));
    assert.ok(variables.flatMap(scope => scope.variables).some(entry => entry.name === 'answer' && entry.value === '42'));
    await session.customRequest('next', { threadId: paused.threadId });
    const stepped = await stop('step');
    const stepStack = (await session.customRequest('stackTrace', { threadId: stepped.threadId })).stackFrames;
    assert.equal(stepStack[0].line, line + 2);
    vscode.debug.removeBreakpoints([breakpoint]);
    await session.customRequest('continue', { threadId: stepped.threadId });
    await until(async () => await fs.readFile(result.fsPath, 'utf8') === 'wsl-spring-linux-verified:42:Linux', 20000);
    return { loopbackManagedDebugger: true, exactLinuxSourceBreakpoint: true, localValue: 42, stepped: true,
      actualSpringProcessResumed: true, changedJarRejected: true, replayRejected: true };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    tracker.dispose();
    await debug.stop();
  }
}

async function verifyLinuxWorkspace(wsl, vscode, distribution, folders, build, javaDebugOnly = false) {
  const linux = process.env.ROCKETBRAIN_WSL_TEST_LINUX_PROJECT;
  const windows = process.env.ROCKETBRAIN_WSL_TEST_UNC_WORKSPACE;
  assert.match(linux, /^\/tmp\/rocketbrain-wsl-[a-z0-9]{8}\/Case Project$/iu);
  assert.deepEqual(wslUnc(windows), { distribution, linux });
  const folder = folders.find(({ uri }) => sameWslPath(wslUnc(uri.fsPath), { distribution, linux }));
  assert.ok(folder, 'The owned Linux project UNC root must be opened in Windows VS Code.');
  const options = { projectUri: folder.uri };
  const mapping = await wsl.mapping(distribution, folder.uri);
  assert.equal(mapping.storage, 'wsl');
  assert.equal(mapping.linux, linux);
  assert.deepEqual(wslUnc(mapping.windows), { distribution, linux });
  assert.match(mapping.directoryIdentity, /^\d+:\d+$/u);
  await assert.rejects(wsl.review({ ...options, distribution: distribution + 'Wrong', system: 'maven', goal: 'package' }),
    /different WSL distribution/u);
  const wrongCase = vscode.Uri.file(folder.uri.fsPath.replace('Case Project', 'case Project'));
  await assert.rejects(wsl.review({ projectUri: wrongCase, system: 'maven', goal: 'package' }), /exact WSL project root/u);

  const source = vscode.Uri.joinPath(folder.uri, ...sourceFile.split('/'));
  const document = await vscode.workspace.openTextDocument(source);
  const editor = await vscode.window.showTextDocument(document);
  assert.equal(editor.document, document);
  const oldMarker = '"wsl-spring"';
  const newMarker = '"wsl-spring-linux-verified"';
  const offset = document.getText().indexOf(oldMarker);
  assert.ok(offset > 0);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + oldMarker.length)), newMarker);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await document.save(), true);
  const bytes = await fs.readFile(source.fsPath);
  assert.ok(bytes.includes(newMarker));
  const linuxObservation = await linuxCommand(distribution, '/usr/bin/sha256sum', '--', linux + '/' + sourceFile);
  assert.equal(linuxObservation.split(/\s/u, 1)[0], createHash('sha256').update(bytes).digest('hex'));
  const gitDiff = await linuxCommand(distribution, '/usr/bin/git', '-C', linux, 'diff', '--no-ext-diff', '--', sourceFile);
  assert.ok(gitDiff.split(/\r?\n/u).some(line => line.startsWith('+') && line.includes(newMarker)));
  assert.ok(gitDiff.split(/\r?\n/u).some(line => line.startsWith('-') && line.includes(oldMarker)));

  const pom = vscode.Uri.joinPath(folder.uri, 'pom.xml').fsPath;
  const original = await fs.readFile(pom);
  const stale = await wsl.review({ ...options, system: 'maven', goal: 'package' });
  try {
    await fs.appendFile(pom, '\n<!-- Linux descriptor edited after approval. -->\n');
    await assert.rejects(wsl.apply(stale.token, { approved: true }), /changed after review/u);
  } finally { await fs.writeFile(pom, original); }

  const jar = 'target/spring-workbench-1.0.0.jar';
  const compiled = 'build/classes/java/main/fixture/WslSpringConfiguration.class';
  await build(options, mapping.windows, 'maven', 'package', jar, /BUILD SUCCESS/u);
  const basic = { openedInWindowsVscode: true, exactDistroAndPath: true, caseMismatchRejected: true,
    crossDistroRejected: true, editorSavedAndLinuxDigestMatched: true, linuxGitObservedEditorChange: true,
    rejectedChangedDescriptor: true, mavenGoal: 'package' };
  if (javaDebugOnly) return { ...basic, javaDebug: await verifyWslDebugger(wsl.javaDebug, vscode, folder, source, document) };
  await build(options, mapping.windows, 'gradle', 'classes', compiled, /BUILD SUCCESSFUL/u);
  for (const produced of [jar, compiled]) await linuxCommand(distribution, '/usr/bin/test', '-s', linux + '/' + produced);
  assert.ok((await fs.readFile(path.join(mapping.windows, compiled))).includes('wsl-spring-linux-verified'));
  return { ...basic, gradleGoal: 'classes', artifactsObservedFromLinux: true, compiledEditedSpringConfiguration: true };
}

async function runWslChecks(api, vscode, checks) {
  const distribution = process.env.ROCKETBRAIN_WSL_TEST_DISTRIBUTION;
  assert.match(distribution, /^RocketbrainFixture-[a-f0-9]{12}$/u);
  const workspace = await fs.realpath(process.env.ROCKETBRAIN_WSL_TEST_WORKSPACE);
  assert.ok(vscode.workspace.isTrusted);
  const folders = (vscode.workspace.workspaceFolders || []).filter(item => item.uri.scheme === 'file');
  const { wsl } = api;
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['rocketbrain.wsl.distributions', 'rocketbrain.wsl.openProject', 'rocketbrain.wsl.reviewBuild', 'rocketbrain.wsl.cancelBuild', 'rocketbrain.wsl.debugJava']) {
    assert.ok(commands.includes(id), id);
  }
  assert.ok((await wsl.distributions()).includes(distribution));

  async function build(target, root, system, goal, expectedFile, expectedOutput) {
    const review = await wsl.review({ ...target, system, goal });
    assert.equal(review.distribution, distribution);
    const result = await wsl.apply(review.token, { approved: true });
    assert.equal(result.code, 0, result.output.slice(-4500));
    assert.equal(result.cancelled, false);
    assert.match(result.output, expectedOutput);
    assert.ok((await fs.stat(path.join(root, expectedFile))).size > 0);
  }

  if (process.env.ROCKETBRAIN_WSL_TEST_JAVA_DEBUG === '1') {
    checks.wsl = { javaDebugOnly: true, linuxOwned: await verifyLinuxWorkspace(wsl, vscode, distribution, folders, build, true) };
    return;
  }
  let folder;
  for (const candidate of folders.filter(item => !item.uri.authority)) {
    const canonical = await fs.realpath(candidate.uri.fsPath);
    if (canonical.toLowerCase() === workspace.toLowerCase()) folder = candidate;
  }
  assert.ok(folder, 'The owned Windows WSL fixture must be opened in VS Code. Open local folders: '
    + (folders.map(item => path.basename(item.uri.fsPath)).join(', ') || '(none)'));
  const mapping = await wsl.mapping(distribution, folder.uri);
  assert.equal(mapping.windows.toLowerCase(), workspace.toLowerCase());
  assert.match(mapping.linux, /^\/mnt\/[a-z]\/.*\/Spring workspace$/u);
  await assert.rejects(wsl.mapping(distribution, vscode.Uri.file(path.dirname(workspace))), /inside an open local workspace/u);
  const options = { distribution, projectUri: folder.uri };
  const pom = path.join(workspace, 'pom.xml');
  const original = await fs.readFile(pom);
  const stale = await wsl.review({ ...options, system: 'maven', goal: 'package' });
  try {
    await fs.appendFile(pom, '\n<!-- Changed after test approval. -->\n');
    await assert.rejects(wsl.apply(stale.token, { approved: true }), /changed after review/u);
  } finally { await fs.writeFile(pom, original); }

  await build(options, workspace, 'maven', 'package', 'target/spring-workbench-1.0.0.jar', /BUILD SUCCESS/u);
  await build(options, workspace, 'gradle', 'classes', 'build/classes/java/main/fixture/WslSpringConfiguration.class', /BUILD SUCCESSFUL/u);
  const running = await wsl.review({ ...options, system: 'gradle', goal: 'build' });
  const buildExecution = wsl.apply(running.token, { approved: true });
  try {
    await Promise.race([awaitCancellationMarker(path.join(workspace, 'cancel-started')), buildExecution.then(result => {
      throw Error('Build exited before cancellation: ' + result.output.slice(-4500));
    })]);
    assert.equal(await wsl.cancel(), true);
    const result = await buildExecution;
    assert.equal(result.cancelled, true);
    assert.notEqual(result.code, 0);
    await assert.rejects(fs.access(path.join(workspace, 'cancel-finished')), { code: 'ENOENT' });
  } finally {
    await wsl.cancel().catch(() => false);
    await buildExecution.catch(() => {});
  }
  assert.deepEqual(await wsl.mapping(distribution, folder.uri), mapping);
  const linuxOwned = await verifyLinuxWorkspace(wsl, vscode, distribution, folders, build);
  checks.wsl = { commandCount: 5, mavenGoal: 'package', gradleGoal: 'classes', compiledSpringConfiguration: true,
    workspaceRoundTrip: true, rejectedOutsideWorkspace: true, rejectedChangedDescriptor: true,
    cancelledManagedBuild: true, distroStillAvailable: true, linuxOwned };
}

async function run() {
  const vscode = require('vscode');
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const api = await extension.activate();
  const checks = {};
  await runWslChecks(api, vscode, checks);
  await fs.writeFile(process.env.ROCKETBRAIN_TEST_OUTPUT, JSON.stringify({ vscode: vscode.version, checks }, null, 2) + '\n');
}

module.exports = { runWslChecks, run };
