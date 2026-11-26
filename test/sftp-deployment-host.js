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
const { createSftpDeployment } = require('../src/remote/sftp-deploy');

async function fixtureRuntime() {
  const python = process.env.ROCKETBRAIN_SFTP_TEST_PYTHON, vendor = process.env.ROCKETBRAIN_SFTP_TEST_ASYNCSSH;
  assert.ok(path.isAbsolute(python ?? '') && path.isAbsolute(vendor ?? ''), 'Use the owned CPython and AsyncSSH fixture paths.');
  assert.equal((await fs.stat(python)).isFile(), true);
  assert.equal((await fs.stat(vendor)).isDirectory(), true);
  return { python, vendor };
}

async function startSftp(root) {
  const { python, vendor } = await fixtureRuntime();
  const credential = randomBytes(22).toString('hex'), user = 'rocketbrain-owned-sftp';
  const passphrase = randomBytes(22).toString('hex'), privateKeyPath = path.join(root, 'client-key');
  const { private: encrypted, public: publicKey } = require('ssh2').utils.generateKeyPairSync('ed25519', {
    passphrase, cipher: 'aes256-ctr', rounds: 8,
  });
  await fs.writeFile(privateKeyPath, encrypted, { flag: 'wx', mode: 0o600 });
  const child = spawn(python, ['-I', '-X', 'utf8', '-u', path.join(__dirname, 'fixtures', 'sftp-asyncssh-fixture.py'), vendor],
    { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const lines = createInterface({ input: child.stdout });
  const output = lines[Symbol.asyncIterator]();
  let errorOutput = '';
  child.stderr.on('data', bytes => { if (errorOutput.length < 4000) errorOutput += bytes; });
  child.stdin.on('error', () => {});
  const exit = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(-1)); });
  async function next() {
    let timer;
    try {
      const result = await Promise.race([output.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned AsyncSSH fixture response timed out.')), 12000); })]);
      assert.equal(result.done, false, 'Owned AsyncSSH fixture stopped. ' + errorOutput);
      return JSON.parse(result.value);
    } finally { clearTimeout(timer); }
  }
  async function close() {
    child.stdin.end('stop\n');
    let timer;
    try {
      const result = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(-1); }, 6000); })]);
      assert.equal(result, 0, 'Owned AsyncSSH fixture did not stop cleanly. ' + errorOutput);
    } finally { clearTimeout(timer); lines.close(); }
  }
  try {
    child.stdin.write(JSON.stringify({ root, user, password: credential, publicKey }) + '\n');
    const published = await next();
    assert.equal(published.version, '2.24.1');
    assert.ok(Number.isInteger(published.port) && published.port > 0);
    assert.match(published.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/u);
    const profile = { label: 'Owned SFTP Fixture', host: '127.0.0.1', port: published.port, user,
      root: '/workspace', authentication: 'password', hostFingerprint: published.fingerprint };
    const keyProfile = { ...profile, label: 'Owned Key SFTP Fixture', authentication: 'encrypted-key', privateKeyPath };
    return { profile, credential, keyProfile, passphrase, version: published.version,
      async stats() { child.stdin.write('stats\n'); return next(); }, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

async function getSpringFolder(vscode) {
  await fixtureConfig();
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const fixture = await fs.realpath(spring.projectPath);
  if (!vscode) return fixture;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const files = await Promise.all(['build.gradle','settings.gradle'].map(async file => {
      try { return (await fs.readFile(path.join(fixture, file))).equals(await fs.readFile(path.join(folder.uri.fsPath, file))); }
      catch { return false; }
    }));
    if (files.every(Boolean)) return fs.realpath(folder.uri.fsPath);
  }
  throw Error('Open the owned Spring fixture in the native workspace.');
}

async function runSftpDeploymentChecks(api, vscode, checks = {}) {
  const localRoot = await getSpringFolder(vscode);
  const suffix = randomBytes(5).toString('hex');
  const local = 'src/main/java/fixture/boot/RbSftp' + suffix + '.java';
  const sourceFile = path.join(localRoot, ...local.split('/'));
  const source = 'package fixture.boot;\nfinal class RbSftp' + suffix + ' { String state = "local review"; }\n';
  const baseline = 'package fixture.boot;\nfinal class RbSftp' + suffix + ' { String state = "remote review"; }\n';
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-sftp-')));
  const directory = path.join(temporary, 'server', 'workspace', 'deploy');
  const target = path.join(directory, 'Existing.java');
  const untouched = path.join(directory, 'keep.txt');
  let server, core, prior, setting, created = false;
  try {
    await fs.writeFile(path.join(temporary,'.owned'), 'RocketbrainSftpFixture-v1', { flag: 'wx' });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(target, baseline, { mode: 0o640 });
    await fs.writeFile(untouched, 'unrelated fixture');
    await fs.writeFile(sourceFile, source, { flag: 'wx' });
    created = true;
    server = await startSftp(temporary);
    const { profile, credential, keyProfile, passphrase } = server;
    const wrong = { ...profile, label: 'Wrong Owned Pin', hostFingerprint: 'SHA256:' + randomBytes(32).toString('base64').slice(0,-1) };
    if (vscode) {
      const commands = await vscode.commands.getCommands(true);
      for (const command of ['reviewSftp','compareSftp','applySftp','reviewWebDav']) assert.ok(commands.includes('rocketbrain.deploy.' + command));
      assert.ok(api.sftpDeployment);
      setting = vscode.workspace.getConfiguration('rocketbrain.deploy.sftp');
      prior = setting.inspect('profiles')?.globalValue;
      await setting.update('profiles', [profile, wrong, keyProfile], vscode.ConfigurationTarget.Global);
    } else core = createSftpDeployment();
    const deployment = api?.sftpDeployment ?? core;
    const scoped = selected => vscode ? { label: selected.label } : { profile: selected };
    const fileInput = vscode ? { source: vscode.Uri.file(sourceFile) } : { localRoot, local };
    const browse = (selected, options = {}) => deployment.browse({ ...scoped(selected), credential, ...options });
    const prepare = (remote, action = 'upload') => deployment.prepare({ ...scoped(profile), remote, action, ...fileInput, credential });
    const apply = (review, overrides = {}) => deployment.apply(review.id, { confirmed: true, hash: review.hash, credential, ...overrides });

    await assert.rejects(() => browse(wrong), /host-key verification failed/i);
    assert.equal((await server.stats()).attempts, 0);
    await assert.rejects(() => browse(profile, { signal: AbortSignal.abort() }), /cancel/i);
    assert.equal((await server.stats()).attempts, 0);
    const listing = await browse(profile, { remote: 'deploy' });
    assert.deepEqual(listing.entries.map(row => [row.name, row.kind]), [['Existing.java','file'],['keep.txt','file']]);
    await assert.rejects(() => browse(keyProfile), /could not be unlocked/i);
    assert.equal((await server.stats()).keyAttempts, 0);
    const keyListing = await browse(keyProfile, { remote: 'deploy', credential: passphrase });
    assert.deepEqual(keyListing, listing);
    assert.ok((await server.stats()).keyAttempts > 0);
    await assert.rejects(() => browse(profile, { remote: '../outside' }), /relative SFTP path/);

    const replace = await prepare('deploy/Existing.java');
    assert.equal(replace.disposition, 'replace');
    assert.equal(replace.atomicReplace, true);
    assert.equal(replace.localText, source);
    assert.equal(replace.remoteText, baseline);
    let nativeDiff = false;
    if (vscode) {
      const summary = await vscode.workspace.openTextDocument(replace.uri);
      assert.match(summary.getText(), /SFTP Deployment Review/);
      assert.ok(summary.getText().includes(replace.remoteHash));
      assert.ok(!summary.getText().includes(credential));
      await vscode.window.showTextDocument(summary, { preview: false });
      const diff = await deployment.openDiff(replace.id);
      assert.equal((await vscode.workspace.openTextDocument(diff.remote)).getText().replaceAll('\r\n','\n'), baseline);
      assert.equal((await vscode.workspace.openTextDocument(diff.local)).getText().replaceAll('\r\n','\n'), source);
      nativeDiff = true;
    }
    assert.equal(await fs.readFile(target, 'utf8'), baseline);
    assert.equal((await server.stats()).replacement, 0);
    await assert.rejects(() => apply(replace, { confirmed: false }), /approve/i);
    await assert.rejects(() => apply(replace, { hash: 'incorrect' }), /approve/i);
    assert.equal((await apply(replace)).publication, 'posix-rename');
    assert.equal(await fs.readFile(target, 'utf8'), source);
    await assert.rejects(() => apply(replace), /approve/i);
    assert.equal((await prepare('deploy/Existing.java')).canApply, false);

    const folder = await prepare('deploy/releases', 'mkdir');
    assert.equal(await fs.stat(path.join(directory, 'releases')).catch(error => error.code), 'ENOENT');
    assert.equal((await apply(folder)).state, 'verified');
    await assert.rejects(() => prepare('deploy/releases', 'mkdir'), /already exists/i);
    const createdFile = await prepare('deploy/releases/New.java');
    assert.equal(createdFile.disposition, 'create');
    assert.equal(createdFile.remoteHash, null);
    assert.equal((await apply(createdFile)).publication, 'sftp-create-rename');
    assert.equal(await fs.readFile(path.join(directory, 'releases', 'New.java'), 'utf8'), source);
    const duringRename = await prepare('deploy/Race.java');
    await assert.rejects(() => apply(duringRename), error => error.code === 'ROCKETBRAIN_SFTP_UNCONFIRMED' && error.target === 'deploy/Race.java');
    assert.equal(await fs.readFile(path.join(directory, 'Race.java'), 'utf8'), 'concurrent new file');

    const staleDirectory = await prepare('deploy/late-folder', 'mkdir');
    await fs.mkdir(path.join(directory, 'late-folder'));
    await assert.rejects(() => apply(staleDirectory), /appeared after review/);
    const staleCreation = await prepare('deploy/Appeared.java');
    await fs.writeFile(path.join(directory, 'Appeared.java'), 'outside review');
    await assert.rejects(() => apply(staleCreation), /remote file changed/i);
    assert.equal(await fs.readFile(path.join(directory, 'Appeared.java'), 'utf8'), 'outside review');
    await fs.writeFile(target, baseline);
    const staleRemote = await prepare('deploy/Existing.java');
    await fs.writeFile(target, 'remote changed during review');
    await assert.rejects(() => apply(staleRemote), /remote file changed/i);
    assert.equal(await fs.readFile(target, 'utf8'), 'remote changed during review');

    const staleLocal = await prepare('deploy/Existing.java');
    await fs.writeFile(sourceFile, source + '// locally changed\n');
    await assert.rejects(() => apply(staleLocal), /local source changed/i);
    assert.equal(await fs.readFile(target, 'utf8'), 'remote changed during review');
    const cleanLocal = await prepare('deploy/Existing.java');
    let unsavedSourceRefused = false;
    if (vscode) {
      const document = await vscode.workspace.openTextDocument(fileInput.source);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      assert.equal(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// unsaved SFTP check\n')), true);
      try {
        assert.equal(document.isDirty, true);
        await assert.rejects(() => apply(cleanLocal), /save the local source/i);
        assert.equal(await fs.readFile(target, 'utf8'), 'remote changed during review');
        unsavedSourceRefused = true;
      } finally { await vscode.commands.executeCommand('workbench.action.files.revert'); }
      await setting.update('profiles', [{ ...profile, root: '/' }, wrong, keyProfile], vscode.ConfigurationTarget.Global);
    } else core.invalidate();
    await assert.rejects(() => apply(cleanLocal), /review/i);

    assert.equal(await fs.readFile(untouched, 'utf8'), 'unrelated fixture');
    assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.rocketbrain-upload-')), false);
    assert.deepEqual((({ creation, replacement, mkdir }) => ({ creation, replacement, mkdir }))(await server.stats()),
      { creation: 2, replacement: 1, mkdir: 1 });
    checks.sftpDeployment = { version: server.version, nativeDiff, unsavedSourceRefused, commandRoutes: Boolean(vscode), hostPinBeforeCredentials: true,
      canceledBeforeAuth: true, encryptedKeyAuthentication: true, previewOnlyUntilApproval: true, atomicReplacement: true, noReplaceCreation: true,
      folderCreation: true, unchangedTargetRefused: true, appliedOnce: true, savedLocalDriftRefused: true, remoteDriftRefused: true,
      lateTargetRefused: true, existingDestinationAtRenamePreserved: true, profileDriftRefused: true, stagingClean: true,
      jdbc: await jdbcReadback() };
    return checks;
  } finally {
    try { if (setting) await setting.update('profiles', prior, vscode.ConfigurationTarget.Global); }
    finally {
      core?.dispose();
      try { await server?.close(); }
      finally {
        if (created) await fs.unlink(sourceFile);
        assert.equal(await fs.realpath(temporary), temporary);
        assert.ok(path.basename(temporary).startsWith('rocketbrain-sftp-') && (await fs.stat(path.join(temporary, '.owned'))).isFile());
        await fs.rm(temporary, { recursive: true });
      }
    }
  }
}

if (require.main === module) runSftpDeploymentChecks().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { runSftpDeploymentChecks, startSftp };
