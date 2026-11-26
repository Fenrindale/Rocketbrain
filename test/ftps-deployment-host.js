'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { jdbcReadback } = require('./java-source-analysis-host');
const { createFtpsDeployment } = require('../src/remote/ftps-deploy');

async function ownedFtps(root) {
  const python = process.env.ROCKETBRAIN_FTPS_TEST_PYTHON, vendor = process.env.ROCKETBRAIN_FTPS_TEST_PYFTPDLIB;
  assert.ok(path.isAbsolute(python ?? '') && path.isAbsolute(vendor ?? ''), 'Use the owned FTPS fixture runtime.');
  assert.equal((await fs.stat(python)).isFile(), true);
  assert.equal((await fs.stat(vendor)).isDirectory(), true);
  const user = 'rocketbrain-owned-ftps', credential = randomBytes(24).toString('base64url');
  const child = spawn(python, ['-I','-X','utf8','-u',path.join(__dirname, 'fixtures', 'ftps-pyftpdlib-fixture.py'),vendor],
    { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const lines = createInterface({ input: child.stdout });
  const output = lines[Symbol.asyncIterator]();
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(-1)); });
  let diagnostics = '';
  child.stderr.on('data', bytes => { if (diagnostics.length < 4000) diagnostics += bytes; });
  child.stdin.on('error', () => {});
  async function response() {
    let timer;
    try {
      const result = await Promise.race([output.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Owned FTPS peer did not answer.')), 12000);
      })]);
      assert.equal(result.done, false, 'Owned FTPS peer stopped. ' + diagnostics);
      return JSON.parse(result.value);
    } finally { clearTimeout(timer); }
  }
  async function close() {
    child.stdin.end('stop\n');
    let timer;
    try {
      const code = await Promise.race([exited, new Promise(resolve => {
        timer = setTimeout(() => { child.kill(); resolve(-1); }, 6000);
      })]);
      assert.equal(code, 0, 'Owned FTPS peer did not shut down after its input closed.');
    } finally { clearTimeout(timer); lines.close(); }
  }
  try {
    child.stdin.write(JSON.stringify({ root, user, password: credential }) + '\n');
    const published = await response();
    assert.equal(published.version, '2.2.0');
    assert.equal(new Set(published.ports).size, 3);
    assert.ok(published.ports.every(port => Number.isInteger(port) && port > 0));
    const primary = { label: 'Owned FTPS', host: '127.0.0.1', port: published.ports[0], root: '/workspace', user,
      tlsServerName: 'localhost', caFile: path.join(root,'ca.pem') };
    const wrongName = { ...primary, label: 'Wrong FTPS name', tlsServerName: 'other.rocketbrain.test' };
    const untrustedCa = { ...primary, label: 'Default FTPS CA', caFile: undefined };
    const badData = { ...primary, label: 'FTPS other data key', port: published.ports[1] };
    const plaintext = { ...primary, label: 'FTP plaintext peer', port: published.ports[2] };
    const caCopy = { ...primary, label: 'FTPS changed CA', caFile: path.join(root, 'ca-copy.pem') };
    await fs.copyFile(primary.caFile, caCopy.caFile);
    return { primary, wrongName, untrustedCa, badData, plaintext, caCopy, credential, version: published.version, close,
      async stats() { child.stdin.write('stats\n'); return response(); } };
  } catch (error) { await close().catch(() => {}); throw error; }
}

async function springRoot(vscode) {
  await fixtureConfig();
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const fixture = await fs.realpath(config.projectPath);
  if (!vscode) return fixture;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const matching = await Promise.all(['build.gradle','settings.gradle'].map(async filename => {
      try { return (await fs.readFile(path.join(fixture, filename))).equals(await fs.readFile(path.join(folder.uri.fsPath, filename))); }
      catch { return false; }
    }));
    if (matching.every(Boolean)) return fs.realpath(folder.uri.fsPath);
  }
  throw Error('Open the owned Spring fixture in the native workspace.');
}

async function runFtpsDeploymentChecks(api, vscode, checks = {}) {
  const localRoot = await springRoot(vscode);
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rocketbrain-ftps-')));
  const remoteRoot = path.join(folder,'server','workspace','publish');
  const comparator = path.join(remoteRoot,'Existing.java');
  const token = randomBytes(5).toString('hex'), local = 'src/main/java/fixture/boot/RbFtps' + token + '.java';
  const filename = path.join(localRoot, ...local.split('/'));
  const localText = 'package fixture.boot;\nfinal class RbFtps' + token + '{ int reviewed = 2; }\n';
  const remoteText = 'package fixture.boot;\nfinal class RbFtps' + token + '{ int reviewed = 1; }\n';
  let peer, core, setting, prior, created = false;
  try {
    await fs.writeFile(path.join(folder,'.owned'),'RocketbrainFtpsFixture-v1', { flag: 'wx' });
    await fs.mkdir(remoteRoot,{ recursive: true });
    await fs.writeFile(comparator,remoteText);
    await fs.writeFile(path.join(remoteRoot,'keep.txt'),'unrelated remote sentinel');
    await fs.writeFile(filename,localText, { flag: 'wx' });
    created = true;
    peer = await ownedFtps(folder);
    const { primary, wrongName, untrustedCa, badData, plaintext, caCopy, credential } = peer;
    const profiles = [primary,wrongName,untrustedCa,badData,plaintext,caCopy].map(profile =>
      Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)));
    if (vscode) {
      const commands = await vscode.commands.getCommands(true);
      for (const name of ['reviewFtps','compareFtps','applyFtps','reviewSftp','reviewWebDav']) {
        assert.ok(commands.includes('rocketbrain.deploy.' + name));
      }
      assert.ok(api.ftpsDeployment);
      setting = vscode.workspace.getConfiguration('rocketbrain.deploy.ftps');
      prior = setting.inspect('profiles')?.globalValue;
      await setting.update('profiles', profiles, vscode.ConfigurationTarget.Global);
    } else core = createFtpsDeployment();
    const deployment = api?.ftpsDeployment ?? core;
    const scoped = profile => vscode ? { label: profile.label } : { profile };
    const file = vscode ? { source: vscode.Uri.file(filename) } : { localRoot, local };
    const browse = (route = primary, extra = {}) => deployment.browse({ ...scoped(route), remote: 'publish', credential, ...extra });
    const prepare = (remote = 'publish/Existing.java', action = 'upload', route = primary) =>
      deployment.prepare({ ...scoped(route), remote, action, ...file, credential });
    const apply = (review, extra = {}) => deployment.apply(review.id, { confirmed: true, hash: review.hash, credential, ...extra });

    await assert.rejects(() => browse(wrongName), /TLS identity verification failed/i);
    await assert.rejects(() => browse(untrustedCa), /TLS identity verification failed/i);
    await assert.rejects(() => browse(plaintext), /explicit TLS negotiation/i);
    await assert.rejects(() => browse(primary, { signal: AbortSignal.abort() }), /abort/i);
    await assert.rejects(() => browse(primary, { credential: credential + '\r\nUSER invalid' }), /control characters/i);
    assert.equal((await peer.stats()).loginCommands, 0);
    await assert.rejects(() => browse(badData), /TLS identity verification failed/i);
    assert.equal((await peer.stats()).loginCommands, 2);
    assert.deepEqual((await browse()).entries.map(row => row.name), ['Existing.java','keep.txt']);
    await assert.rejects(() => browse(primary, { remote: '../outside' }), /relative FTPS path/i);

    const review = await prepare();
    assert.equal(review.disposition, 'create unique');
    assert.equal(review.remoteText, remoteText);
    assert.equal(review.localText, localText);
    assert.match(review.certificateSha256,/^[a-f0-9]{64}$/u);
    assert.equal(review.prefix,'Existing.java.rb-upload');
    assert.equal((await peer.stats()).uniqueWrites,0);
    let nativeDiff = false;
    if (vscode) {
      const summary = await vscode.workspace.openTextDocument(review.uri);
      assert.match(summary.getText(), /FTPS Deployment Review/u);
      assert.ok(summary.getText().includes(review.prefix));
      assert.ok(summary.getText().includes(review.certificateSha256));
      assert.ok(!summary.getText().includes(credential));
      await vscode.window.showTextDocument(summary, { preview: false });
      const diff = await deployment.openDiff(review.id);
      assert.equal((await vscode.workspace.openTextDocument(diff.remote)).getText().replaceAll('\r\n','\n'),remoteText);
      assert.equal((await vscode.workspace.openTextDocument(diff.local)).getText().replaceAll('\r\n','\n'),localText);
      nativeDiff = true;
    }
    await assert.rejects(() => apply(review, { confirmed: false }), /approve/i);
    await assert.rejects(() => apply(review, { hash: 'other' }), /approve/i);
    const published = await apply(review);
    assert.equal(published.publication,'stou');
    assert.match(published.remote,/^publish\/Existing\.java\.rb-upload\.[\w-]+$/u);
    assert.equal(published.sha256,review.localHash);
    assert.equal(await fs.readFile(path.join(folder,'server','workspace',published.remote),'utf8'),localText);
    assert.equal(await fs.readFile(comparator,'utf8'),remoteText);
    await assert.rejects(() => apply(review), /approve/i);

    const createdFolder = await prepare('publish/releases','mkdir');
    assert.equal(await fs.stat(path.join(remoteRoot,'releases')).catch(error => error.code),'ENOENT');
    assert.equal((await apply(createdFolder)).state,'verified');
    assert.equal((await fs.stat(path.join(remoteRoot,'releases'))).isDirectory(),true);
    await assert.rejects(() => prepare('publish/releases','mkdir'), /already exists/i);
    const late = await prepare('publish/late','mkdir');
    await fs.mkdir(path.join(remoteRoot,'late'));
    await assert.rejects(() => apply(late), /appeared after review/i);
    const newFile = await prepare('publish/releases/Fresh.java');
    assert.equal(newFile.remoteHash,null);
    assert.equal((await apply(newFile)).state,'verified');
    assert.ok((await fs.readdir(path.join(remoteRoot,'releases'))).some(name => name.startsWith(newFile.prefix + '.')));

    const changedRemote = await prepare();
    await fs.writeFile(comparator,remoteText + '// changed remotely\n');
    await assert.rejects(() => apply(changedRemote), /remote file changed/i);
    const changedLocal = await prepare();
    await fs.writeFile(filename,localText + '// changed locally\n');
    await assert.rejects(() => apply(changedLocal), /local source changed/i);
    const changedCa = await prepare('publish/Existing.java','upload',caCopy);
    const beforeCa = (await peer.stats()).loginCommands;
    await fs.appendFile(caCopy.caFile,'\n');
    await assert.rejects(() => apply(changedCa), /trusted CA file changed/i);
    assert.equal((await peer.stats()).loginCommands,beforeCa);
    assert.equal(await fs.readFile(path.join(remoteRoot,'keep.txt'),'utf8'),'unrelated remote sentinel');
    assert.equal((await peer.stats()).uniqueWrites,2);
    assert.equal((await peer.stats()).createdFolders,1);
    assert.ok((await peer.stats()).protectedTransfers >= 10);

    checks.ftpsDeployment = { server: 'pyftpdlib', version: peer.version, nativeDiff, nativeRoutes: Boolean(vscode),
      strictControlCertificate: true, untrustedCaRefused: true, noPlaintextFallback: true, credentialsAfterTls: true,
      samePeerDataCertificate: true, protectedPassiveTransfers: true, approvalBoundToCa: true, nativeReviewData: true,
      reviewedUniqueUploads: 2, existingRemotePreserved: true, verifiedFolderCreation: true, localAndRemoteDriftRefused: true,
      oneShotApproval: true, routeTraversalRefused: true, jdbc: await jdbcReadback() };
    return checks;
  } finally {
    try { if (setting) await setting.update('profiles',prior,vscode.ConfigurationTarget.Global); }
    finally {
      core?.dispose();
      try { await peer?.close(); }
      finally {
        if (created) await fs.unlink(filename);
        assert.equal(await fs.realpath(folder),folder);
        assert.ok(path.basename(folder).startsWith('rocketbrain-ftps-') && (await fs.stat(path.join(folder,'.owned'))).isFile());
        await fs.rm(folder,{ recursive: true });
      }
    }
  }
}

if (require.main === module) runFtpsDeploymentChecks().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { runFtpsDeploymentChecks, ownedFtps, springRoot };
