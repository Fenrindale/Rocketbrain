'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { connectWorkspace } = require('../src/remote/ssh-workspace');
const { createSshJavaMapping } = require('../src/remote/ssh-java-mapping');
const { createSshJava } = require('../src/remote/ssh-java');
const { fixtureStep } = require('./devcontainer-port-fixture');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');

const python = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON;
const pythonPackage = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH;
const javaHome = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_JDK;
const serverPath = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_JDT;
const protocol = createRequire(require.resolve('vscode-languageclient/node'))('vscode-languageserver-protocol/node');

test('SSH Java URI mapping binds an exact remote root and rejects traversal or another provider', () => {
  const linux = createSshJavaMapping('/workspaces/my project');
  const windows = createSshJavaMapping('C:\\workspace\\my project');
  for (const mapping of [linux, windows]) {
    const file = '/src/자료.java';
    assert.equal(mapping.toHost(mapping.toRemote(file)), file);
    assert.throws(() => mapping.toRemote('/../elsewhere.java'), /physical Java/);
    assert.throws(() => mapping.toHost(mapping.workspaceUri + '/src%2Fhidden.java'), /outside the reviewed/);
    assert.throws(() => mapping.toHost('jdt://contents/source.java'), /outside the reviewed/);
  }
  assert.equal(windows.toHost('file:///c%3A/workspace/my%20project/src/Example.java'), '/src/Example.java');
  assert.throws(() => windows.toHost('file:///D:/workspace/my%20project/src/Example.java'), /outside the reviewed/);
});

const allowed = review => ({ token: review.token, allowRemoteProcess: true });

test('Owned AsyncSSH verifies explicit terminal and JDT streams under the exact host fingerprint and saved source', {
  skip: !python || !pythonPackage || !javaHome || !serverPath, timeout: 130000
}, async context => {
  const owned = await startSshProcessFixture({ python, pythonPackage }, cleanup => context.after(cleanup));
  await assert.rejects(connectWorkspace({ ...owned.profile, knownHostsPath: owned.wrongPin }), /Verify the SSH host key/);
  const peer = await connectWorkspace(owned.profile);
  let java, terminal;
  try {
    const review = await peer.inspectProcess('terminal');
    await assert.rejects(peer.openProcess('terminal', { token: review.token }), /Review and approve/);
    terminal = await peer.openProcess('terminal', allowed(review));
    const terminalExit = once(terminal, 'close');
    let terminalOutput = '';
    terminal.stdout.on('data', chunk => { terminalOutput = (terminalOutput + chunk).slice(-8192); });
    terminal.stderr.on('data', chunk => { terminalOutput = (terminalOutput + chunk).slice(-8192); });
    terminal.stdin.write(process.platform === 'win32' ? 'cd\r\necho RB_SSH_TERMINAL\r\n' : 'pwd\nprintf RB_SSH_TERMINAL\\n\n');
    for (let attempt = 0; attempt < 30 && !terminalOutput.includes('RB_SSH_TERMINAL'); attempt++) await delay(250);
    assert.match(terminalOutput, /RB_SSH_TERMINAL/u);
    assert.ok(terminalOutput.toLowerCase().includes(peer.root.toLowerCase()), terminalOutput);
    await assert.rejects(peer.openProcess('terminal', allowed(review)), /current SSH process review/);

    const plan = await peer.inspectProcess('java', { javaHome, serverPath });
    assert.equal(plan.jdk, 25);
    java = await createSshJava({ client: peer, approval: allowed(plan), protocol });
    const document = { file: '/src/fixture/Example.java', version: 1, text: owned.sourceText };
    const position = { line: 0, character: owned.sourceText.indexOf('Target') + 1 };
    let target;
    for (let attempt = 0; attempt < 28; attempt++) {
      target = await java.definition(document, position);
      if (target.some(item => item.file === '/src/fixture/Target.java')) break;
      await delay(350);
    }
    assert.ok(target.some(item => item.file === '/src/fixture/Target.java'));
    const field = { line: 0, character: owned.sourceText.indexOf('field') + 1 };
    let hover;
    for (let attempt = 0; attempt < 18; attempt++) {
      hover = await java.hover(document, field);
      if (hover.includes('field')) break;
      await delay(350);
    }
    assert.match(hover, /Target.*field/u);
    await fs.appendFile(owned.example, '\n// remote source intentionally changed\n');
    await assert.rejects(java.hover(document, field), /SSH Java source changed/);
    await java.stop();
    await assert.rejects(java.hover(document, field), /changed|stopped/);
    terminal.stdin.write(process.platform === 'win32' ? 'echo RB_SSH_LIVE\r\nexit\r\n' : 'printf RB_SSH_LIVE\\n\nexit\n');
    assert.equal((await fixtureStep('closing the approved SSH terminal via its own shell', () => terminalExit))[0], 0);
    assert.match(terminalOutput, /RB_SSH_LIVE/u);
    const fingerprint = await fs.readFile(owned.profile.knownHostsPath);
    await fs.copyFile(owned.wrongPin, owned.profile.knownHostsPath);
    await assert.rejects(peer.inspectProcess('terminal'), /known_hosts file changed/);
    await assert.rejects(peer.read('/src/fixture/Target.java'), /known_hosts file changed/);
    await fs.writeFile(owned.profile.knownHostsPath, fingerprint);
    assert.ok((await peer.list('/')).some(([name]) => name === 'src'));
    const evidence = { runtime: { openSshClient: true, asyncssh: owned.asyncssh, jdt: '1.63.0', jdk: 25 },
      terminal: { exactPhysicalRoot: true, explicitUserInput: true, continuedAfterJavaStop: true, normalExit: true },
      java: { realDefinition: true, realHover: true, remoteEditorPreimageVerified: true, staleSourceRefused: true },
      trust: { wrongHostRefused: true, knownHostsDriftRefused: true, oneShot: true } };
    context.diagnostic(JSON.stringify(evidence));
    if (process.env.ROCKETBRAIN_SSH_PROCESS_TEST_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SSH_PROCESS_TEST_RECEIPT,
      JSON.stringify(evidence, null, 2) + '\n');
  } finally { java?.dispose(); terminal?.kill(); peer.close(); }
});
