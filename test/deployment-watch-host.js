'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { createWebDavDeployment } = require('../src/http/webdav-deploy');
const { createDeploymentWatch } = require('../src/remote/deployment-watch');
const { startSftp } = require('./sftp-deployment-host');
const { ownedFtps, springRoot } = require('./ftps-deployment-host');
const { jdbcReadback } = require('./java-source-analysis-host');

async function ownedWebDav(root) {
  const python = process.env.ROCKETBRAIN_WEBDAV_TEST_PYTHON, vendor = process.env.ROCKETBRAIN_WEBDAV_TEST_WSGIDAV;
  assert.ok(path.isAbsolute(python ?? '') && path.isAbsolute(vendor ?? ''), 'Use the owned WsgiDAV fixture runtime.');
  assert.equal((await fs.stat(python)).isFile(), true);
  assert.equal((await fs.stat(vendor)).isDirectory(), true);
  const user = 'rocketbrain-owned-webdav', credential = randomBytes(24).toString('base64url');
  const child = spawn(python, ['-I','-X','utf8','-u',path.join(__dirname,'fixtures','webdav-wsgidav-fixture.py'),vendor],
    { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const lines = createInterface({ input: child.stdout }), replies = lines[Symbol.asyncIterator]();
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(-1)); });
  let diagnostics = '';
  child.stderr.on('data', data => { if (diagnostics.length < 4000) diagnostics += data; });
  child.stdin.on('error', () => {});
  async function result() {
    let timer;
    try {
      const next = await Promise.race([replies.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('The owned WsgiDAV fixture did not answer.')), 10000);
      })]);
      assert.equal(next.done, false, 'WsgiDAV fixture stopped. ' + diagnostics);
      return JSON.parse(next.value);
    } finally { clearTimeout(timer); }
  }
  async function close() {
    child.stdin.end('stop\n');
    let timer;
    try {
      assert.equal(await Promise.race([exited, new Promise(resolve => {
        timer = setTimeout(() => { child.kill(); resolve(-1); }, 5000);
      })]), 0, 'The owned WsgiDAV process did not stop cleanly.');
    } finally { clearTimeout(timer); lines.close(); }
  }
  try {
    child.stdin.write(JSON.stringify({ root, user, password: credential }) + '\n');
    const arrived = await result();
    assert.equal(arrived.version, '4.4.1');
    assert.ok(Number.isInteger(arrived.port) && arrived.port > 0);
    return { profile: { url: 'http://127.0.0.1:' + arrived.port + '/dav', user, remoteDirectory: 'workspace', exclusions: [] },
      version: arrived.version, credential, close, async stats() { child.stdin.write('stats\n'); return result(); } };
  } catch (error) { await close().catch(() => {}); throw error; }
}

async function checkStopped(folder, token) {
  assert.equal(await fs.realpath(folder), folder);
  assert.ok(path.basename(folder).startsWith(token) && (await fs.stat(path.join(folder, '.owned'))).isFile());
  await fs.rm(folder, { recursive: true });
}

async function configure(vscode, workspace, protocol, profile) {
  if (protocol === 'webdav') {
    const config = vscode.workspace.getConfiguration('rocketbrain.deploy.webdav', vscode.Uri.file(workspace));
    const entries = Object.entries({ ...profile, localDirectory: '' });
    const target = vscode.ConfigurationTarget.Workspace;
    const prior = entries.map(([key]) => [key, config.inspect(key)?.workspaceValue]);
    for (const [key, value] of entries) await config.update(key, value, target);
    return async () => { for (const [key, value] of prior) await config.update(key, value, target); };
  }
  const config = vscode.workspace.getConfiguration('rocketbrain.deploy.' + protocol);
  const prior = config.inspect('profiles')?.globalValue, target = vscode.ConfigurationTarget.Global;
  await config.update('profiles', [profile], target);
  return () => config.update('profiles', prior, target);
}

async function observedPoll(service, id, from) {
  const deadline = Date.now() + 26000;
  while (Date.now() < deadline) {
    const current = service.view(id);
    if (current.status === 'paused') throw Error(current.failure);
    if (current.revision > from) return current;
    await delay(100);
  }
  throw Error('The deployment poll did not refresh both folders.');
}

function expectedRow(view, name, direction, localChange, remoteChange, canReviewUpload) {
  const row = view.rows.find(value => value.name === name);
  assert.ok(row, 'Missing observed deployment row ' + name);
  assert.deepEqual({ direction: row.direction, localChange: row.localChange, remoteChange: row.remoteChange,
    canReviewUpload: row.canReviewUpload }, { direction, localChange, remoteChange, canReviewUpload });
}

async function checkProtocol(api, vscode, workspace, protocol) {
  const remoteToken = 'rocketbrain-' + protocol + '-';
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), remoteToken)));
  const localToken = 'rocketbrain-deployment-watch-';
  const local = await fs.realpath(await fs.mkdtemp(path.join(workspace, localToken)));
  const remote = path.join(root, 'server', 'workspace', 'publish');
  let peer, service, webdav, restore;
  try {
    await fs.writeFile(path.join(root,'.owned'),'RocketbrainRemoteWatchFixture-v1', { flag: 'wx' });
    await fs.writeFile(path.join(local,'.owned'),'RocketbrainLocalWatchFixture-v1', { flag: 'wx' });
    await fs.mkdir(remote, { recursive: true });
    const writeLocal = (name, bytes) => fs.writeFile(path.join(local, name), bytes);
    const writeRemote = (name, bytes) => fs.writeFile(path.join(remote, name), bytes);
    for (const filename of ['Aligned.txt','Outgoing.java','Incoming.java','Conflict.java','LocalGone.txt','RemoteGone.txt','Converged.txt']) {
      await writeLocal(filename, 'baseline\n');
      await writeRemote(filename, 'baseline\n');
    }
    await writeLocal('Different.txt', 'old local\n');
    await writeRemote('Different.txt', 'old remote\n');
    await fs.mkdir(path.join(remote, 'Blocked.txt'));
    peer = protocol === 'webdav' ? await ownedWebDav(root) : protocol === 'sftp' ? await startSftp(root) : await ownedFtps(root);
    const profile = peer.profile ?? peer.primary;
    const label = profile.label ?? 'Owned WebDAV';
    if (vscode) {
      restore = await configure(vscode, workspace, protocol, profile);
      service = api.deploymentChanges;
      assert.ok(service);
    } else {
      webdav = createWebDavDeployment();
      service = createDeploymentWatch({ webdav, pollMs: 5000, durationMs: 90000 });
    }
    const poll = protocol === 'sftp', folder = path.basename(local);
    const input = vscode ? { localFolder: vscode.Uri.file(local) } : { profile, workspaceRoot: workspace, localDirectory: folder };
    const started = await service.start({ ...input, protocol, label, credential: peer.credential, remoteDirectory: 'publish', poll });
    assert.equal(started.status, poll ? 'monitoring' : 'ready');
    expectedRow(started, 'Different.txt', 'baseline-difference', 'unchanged', 'unchanged', true);
    expectedRow(started, 'Aligned.txt', 'aligned', 'unchanged', 'unchanged', false);
    assert.ok(!JSON.stringify(started).includes(peer.credential));
    assert.ok(started.skipped.remote.some(row => row.name === 'Blocked.txt'));
    await Promise.all([
      writeLocal('Outgoing.java', 'outgoing local\n'), writeRemote('Incoming.java', 'incoming remote\n'),
      writeLocal('Conflict.java', 'local conflict\n'), writeRemote('Conflict.java', 'remote conflict\n'),
      fs.unlink(path.join(local,'LocalGone.txt')), fs.unlink(path.join(remote,'RemoteGone.txt')),
      writeLocal('Converged.txt','same new bytes\n'), writeRemote('Converged.txt','same new bytes\n'),
      writeLocal('LocalNew.txt',Buffer.from([4,0,9])), writeRemote('RemoteNew.txt','new remote\n'),
      writeLocal('Blocked.txt','file on local side only\n'),
    ]);
    const current = poll ? await observedPoll(service, started.id, started.revision) : await service.refresh(started.id);
    expectedRow(current, 'Outgoing.java', 'local', 'modified', 'unchanged', true);
    expectedRow(current, 'Incoming.java', 'remote', 'unchanged', 'modified', false);
    expectedRow(current, 'Conflict.java', 'conflict', 'modified', 'modified', false);
    expectedRow(current, 'LocalGone.txt', 'local', 'deleted', 'unchanged', false);
    expectedRow(current, 'RemoteGone.txt', 'remote', 'unchanged', 'deleted', false);
    expectedRow(current, 'Converged.txt', 'aligned', 'modified', 'modified', false);
    expectedRow(current, 'LocalNew.txt', 'local', 'added', 'unchanged', true);
    expectedRow(current, 'RemoteNew.txt', 'remote', 'unchanged', 'added', false);
    expectedRow(current, 'Blocked.txt', 'type-conflict', 'added', 'unchanged', false);
    const compare = service.compare ?? service.diff;
    assert.throws(() => compare(current.id, started.revision, 'Outgoing.java'), /latest observed/);
    const exact = compare(current.id, current.revision, 'Outgoing.java');
    assert.equal(exact.local, 'outgoing local\n');
    assert.equal(exact.remote, 'baseline\n');
    assert.match(compare(current.id, current.revision, 'LocalNew.txt').local, /Binary or large file · 3 bytes · SHA-256/u);
    const incoming = compare(current.id, current.revision, 'Incoming.java');
    assert.equal(incoming.remote,'incoming remote\n');
    assert.equal(incoming.local,'baseline\n');
    let nativeDiff = false, guardedHandoff = false;
    if (vscode) {
      const summary = await vscode.workspace.openTextDocument(started.uri);
      assert.match(summary.getText(), /Both sides changed/u);
      assert.match(summary.getText(), /Incoming\.java · Remote change/u);
      await vscode.window.showTextDocument(summary, { preview: false });
      const diff = await service.openDiff(current.id, current.revision, 'Incoming.java');
      assert.equal((await vscode.workspace.openTextDocument(diff.remote)).getText().replaceAll('\r\n','\n'), incoming.remote);
      assert.equal((await vscode.workspace.openTextDocument(diff.local)).getText().replaceAll('\r\n','\n'), incoming.local);
      nativeDiff = true;
      await assert.rejects(() => service.openUploadReview(current.id,current.revision,'Incoming.java'), /observed local change/i);
      await writeLocal('Outgoing.java','changed after observation\n');
      await assert.rejects(() => service.openUploadReview(current.id,current.revision,'Outgoing.java'), /file changed/i);
      await writeLocal('Outgoing.java',exact.local);
      const review = await service.openUploadReview(current.id,current.revision,'Outgoing.java');
      assert.equal(review.scheme, 'rocketbrain-' + protocol + '-review');
      guardedHandoff = true;
    } else {
      assert.throws(() => service.uploadInput(current.id,current.revision,'Incoming.java'), /observed local change/i);
      assert.equal(service.uploadInput(current.id,current.revision,'Outgoing.java').selection.local.sha256, exact.row.local.sha256);
    }
    assert.equal(await fs.readFile(path.join(remote,'Outgoing.java'),'utf8'),'baseline\n');
    assert.equal(await fs.readFile(path.join(local,'Incoming.java'),'utf8'),'baseline\n');
    const reset = service.reset(current.id);
    expectedRow(reset,'Conflict.java','baseline-difference','unchanged','unchanged',true);
    assert.equal(reset.baselineTime,current.observedAt);
    if (protocol === 'sftp') {
      await Promise.all([writeLocal('CaseOnly.txt','local index'),writeRemote('caseonly.txt','remote index')]);
      await assert.rejects(() => service.refresh(current.id), /ambiguous case/i);
      assert.equal(service.view(current.id).status,'paused');
    }
    service.stop();
    assert.throws(() => service.view(current.id), /active deployment change review/);
    const stats = await peer.stats();
    if (protocol === 'webdav') {
      assert.ok(stats.PROPFIND > 0 && stats.GET > 0);
      for (const name of ['PUT','MKCOL','MOVE','DELETE']) assert.equal(stats[name],undefined);
    } else if (protocol === 'ftps') {
      assert.ok(stats.protectedTransfers > 0);
      assert.equal(stats.uniqueWrites + stats.createdFolders,0);
    } else {
      assert.ok(stats.attempts > 0);
      assert.equal(stats.creation + stats.replacement + stats.mkdir,0);
    }
    return { vendor: peer.version, observedDirections: ['local','remote','conflict','aligned'], noWrites: true,
      typeConflictsRefused: true, snapshotDiff: true, resetBaseline: true, nativeDiff, guardedHandoff,
      pollObserved: poll, caseCollisionRefused: poll };
  } finally {
    try { service?.stop(); if (!vscode) service?.dispose(); webdav?.dispose(); await restore?.(); }
    finally {
      try { await peer?.close(); }
      finally { await checkStopped(local, localToken); await checkStopped(root, remoteToken); }
    }
  }
}

async function runDeploymentWatchChecks(api, vscode, checks = {}) {
  const workspace = await springRoot(vscode);
  if (vscode) {
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['watchChanges','refreshChanges','compareChange','reviewChangeUpload','resetChanges','stopWatchingChanges']) {
      assert.ok(commands.includes('rocketbrain.deploy.' + name));
    }
  }
  const protocols = {};
  for (const protocol of ['sftp','ftps','webdav']) protocols[protocol] = await checkProtocol(api,vscode,workspace,protocol);
  checks.deploymentWatch = { protocols, nativeCommands: Boolean(vscode), jdbc: await jdbcReadback() };
  return checks;
}

if (require.main === module) runDeploymentWatchChecks().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { runDeploymentWatchChecks, ownedWebDav };
