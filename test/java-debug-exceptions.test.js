'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { DEBUG_BUILD, resolveDebugBundle } = require('../src/java/debug-runtime');
const { exceptionPolicy, debugSettings, createExceptionControls } = require('../src/java/debug-exceptions');
const { exceptionFixture } = require('./helpers/java-exception-fixture');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');

const defaultPolicy = { exceptionTypes: [], allowClasses: [], skipClasses: [] };
const configPath = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('Java exception policy validates exact types and the real JDI class pattern grammar', () => {
  assert.deepEqual(exceptionPolicy(), defaultPolicy);
  const value = { exceptionTypes: [' pkg.예외$Inner ', 'pkg.예외$Inner'], allowClasses: ['pkg.*'], skipClasses: ['*.Generated', 'java.util.Date'] };
  assert.deepEqual(exceptionPolicy(value), {
    exceptionTypes: ['pkg.예외$Inner'], allowClasses: ['pkg.*'], skipClasses: ['*.Generated', 'java.util.Date']
  });
  assert.throws(() => exceptionPolicy({ exceptionTypes: ['pkg.*'] }), /exact Java exception class names/);
  assert.throws(() => exceptionPolicy({ skipClasses: ['pkg.*.Generated'] }), /one leading\/trailing wildcard/);
  assert.throws(() => exceptionPolicy({ allowClasses: new Array(25).fill('pkg.*') }), /up to 24/);
  assert.throws(() => exceptionPolicy({ expression: 'true' }), /exceptionTypes, allowClasses and skipClasses/);
  assert.equal(JSON.parse(debugSettings(value, { mode: 'never', updated: true })).exceptionFiltersUpdated, true);
});

test('workspace-wide Java filters update once after settings change and survive a second debug launch', async () => {
  const calls = [];
  let policy;
  let hasSessions = false;
  let listener;
  let answers = [];
  const engine = { state: 'running', javaHome: '/standalone/java', debugBuild: '0.53.1.rocketbrain2' };
  const vscode = { ConfigurationTarget: { Workspace: 2 }, window: {
    async showInputBox(prompt) {
      const answer = answers.shift();
      if (answer !== undefined) assert.equal(prompt.validateInput(answer), undefined);
      return answer;
    },
    showInformationMessage() {}
  }, workspace: {
    isTrusted: true, workspaceFolders: [{}],
    onDidChangeConfiguration(callback) { listener = callback; return { dispose() {} }; },
    getConfiguration() {
      return {
        get: key => key === 'exceptionBreakpoints' ? policy : 'never',
        async update(key, value, target) {
          assert.equal(key, 'exceptionBreakpoints');
          assert.equal(target, 2);
          policy = value;
          listener({ affectsConfiguration: key => key === 'rocketbrain.java.exceptionBreakpoints' });
        }
      };
    }
  } };
  const controls = createExceptionControls(vscode, {
    ensureTrusted() {}, engineState: () => engine,
    hasSessions: () => hasSessions,
    async run(command, settings) {
      assert.equal(command, 'vscode.java.updateDebugSettings');
      calls.push(JSON.parse(settings));
    },
    output: { appendLine(message) { assert.fail(message); } }
  });
  try {
    const selected = { ...defaultPolicy, exceptionTypes: ['java.lang.IllegalStateException'] };
    assert.deepEqual(await controls.update(selected), selected);
    assert.equal(calls.length, 0);
    await controls.sync();
    assert.deepEqual(calls[0].exceptionFilters, selected);
    assert.equal(calls[0].hotCodeReplace, 'never');
    assert.equal(calls[0].exceptionFiltersUpdated, false);
    hasSessions = true;
    const filtered = { ...selected, skipClasses: ['java.*'] };
    await controls.update(filtered);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].exceptionFiltersUpdated, true);
    await controls.sync();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].exceptionFilters, filtered);
    assert.equal(calls[2].exceptionFiltersUpdated, false);
    const multi = { ...filtered, exceptionTypes: [...filtered.exceptionTypes, 'java.io.IOException'] };
    await assert.rejects(controls.update(multi), /update the debugger/);
    assert.deepEqual(controls.get(), filtered);
    engine.debugBuild = DEBUG_BUILD;
    answers = [multi.exceptionTypes.join(', '), undefined];
    assert.equal(await controls.edit(), undefined);
    assert.deepEqual(controls.get(), filtered);
    answers = [multi.exceptionTypes.join(', '), '', 'java.*'];
    assert.deepEqual(await controls.edit(), multi);
    assert.deepEqual(calls[3].exceptionFilters, multi);
  } finally { controls.dispose(); }
});

test('pinned Java debugger filters real caught and uncaught exceptions by subtype and throw location', {
  skip: !configPath && 'Configure the independent JDT LS debug runtime.', timeout: 240000
}, async context => {
  const runtime = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const config = runtime.settings || runtime;
  const javaHome = runtime.javaHome || config['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || config['rocketbrain.java.serverPath'];
  const debugBundlePath = runtime.debugBundlePath || config['rocketbrain.java.debugBundlePath'];
  const engine = resolveDebugBundle(debugBundlePath);
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'rb-java-exception-'));
  context.after(async () => {
    const real = await fs.realpath(root);
    assert.equal(real, root);
    assert.equal(path.dirname(real), temp);
    assert.match(path.basename(real), /^rb-java-exception-/);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.copyFile(path.join(__dirname, 'fixtures/java/debugger/pom.xml'), path.join(project, 'pom.xml'));
  const fixture = exceptionFixture('dev.rocketbrain.exceptions');
  for (const [relative, source] of fixture.files) {
    const file = path.join(project, 'src/main/java', relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source, { flag: 'wx' });
  }
  const uri = pathToFileURL(project).href;
  const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
  const lsp = new StdioLsp(resolveLaunch({ javaHome, serverPath, debugBundlePath, storagePath: path.join(root, 'jdt') }));
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args });
  const update = (policy, updated = false) => command('vscode.java.updateDebugSettings', debugSettings(policy, { javaHome, updated }));
  const receipt = { debugBuild: engine.build };
  try {
    await lsp.request('initialize', { processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'exceptions' }],
      capabilities: { workspace: { configuration: true } }, initializationOptions: { bundles: [debugBundlePath], workspaceFolders: [uri], settings }
    }, 75000);
    lsp.notify('initialized', {});
    lsp.notify('workspace/didChangeConfiguration', { settings });
    const main = await until(async () => (await command('vscode.java.resolveMainClass', uri))?.find(item => item.mainClass === fixture.mainClass), 85000);
    const built = await command('vscode.java.buildWorkspace', JSON.stringify({ mainClass: fixture.mainClass, projectName: main.projectName, isFullBuild: false }));
    assert.ok(built === 1 || built === 'SUCCEED', JSON.stringify(built));
    const [modulePaths, classPaths] = await command('vscode.java.resolveClasspath', fixture.mainClass, main.projectName);
    const javaExec = await command('vscode.java.resolveJavaExecutable', fixture.mainClass, main.projectName);
    const modes = engine.build === DEBUG_BUILD ? ['caught', 'uncaught', 'multiple'] : ['caught', 'uncaught'];
    for (const mode of modes) {
      const filter = mode === 'uncaught' ? 'uncaught' : 'caught';
      const policy = mode === 'multiple' ? {
        ...fixture.policy, exceptionTypes: [fixture.childType, ...fixture.policy.exceptionTypes, fixture.alternateType]
      } : fixture.policy;
      await update(mode === 'caught' ? defaultPolicy : policy);
      const dap = new DapClient(await command('vscode.java.startDebugSession'));
      try {
        const capabilities = await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'exception-policy-tests',
          pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsRunInTerminalRequest: false });
        assert.ok(capabilities.supportsExceptionInfoRequest);
        assert.ok(capabilities.exceptionBreakpointFilters.some(item => item.filter === filter));
        const launched = dap.request('launch', { mainClass: fixture.mainClass, projectName: main.projectName,
          type: 'rocketbrain-java', name: 'Java exception filter fixture', javaExec, cwd: project, modulePaths,
          classPaths, args: mode === 'multiple' ? mode : 'uncaught', console: 'internalConsole', sourcePaths: [], stopOnEntry: true });
        launched.catch(() => {});
        await dap.event('initialized');
        await dap.request('setExceptionBreakpoints', { filters: [filter] });
        await dap.request('configurationDone');
        await launched;
        let stop = await dap.event('stopped');
        assert.equal(stop.reason, 'entry');
        if (mode === 'caught') await update(policy, true);
        const expected = mode === 'multiple' ? ['caught', 'alternate'] : [filter];
        const observed = [];
        for (const marker of expected) {
          const before = dap.events.length;
          await dap.request('continue', { threadId: stop.threadId });
          stop = await dap.event('stopped', before, 18000);
          assert.equal(stop.reason, 'exception');
          const { stackFrames } = await dap.request('stackTrace', { threadId: stop.threadId });
          const info = await dap.request('exceptionInfo', { threadId: stop.threadId });
          assert.match(info.exceptionId, marker === 'alternate' ? /AlternateFailure/ : /ChildFailure/);
          assert.equal(stackFrames[0].line, fixture.line('wanted-' + marker));
          observed.push({ line: stackFrames[0].line, subtype: info.exceptionId });
        }
        const after = dap.events.length;
        await dap.request('continue', { threadId: stop.threadId });
        const next = await until(() => dap.events.slice(after).find(event => ['stopped', 'terminated'].includes(event.event)), 18000);
        assert.equal(next.event, 'terminated', JSON.stringify(next.body));
        assert.equal(dap.events.filter(event => event.event === 'stopped' && event.body.reason === 'exception').length, expected.length);
        receipt[mode] = { filters: [filter], observed, liveUpdate: mode === 'caught', terminatedWithoutExtraStops: true };
      } finally { await dap.close(); }
    }
  } finally { await lsp.close(); }
  if (process.env.ROCKETBRAIN_JAVA_EXCEPTIONS_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_JAVA_EXCEPTIONS_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  }
});
