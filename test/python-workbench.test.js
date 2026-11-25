'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { inspectPythonSource, launchArguments } = require('../src/python/python-vscode');
const { pythonEnvironment } = require('../src/python/local-python');
const { DapClient, freePort } = require('./java-debug-dap');

const python = process.env.ROCKETBRAIN_JUPYTER_TEST_PYTHON;

test('Python inspector source is embedded verbatim and program arguments remain individual strings', async () => {
  assert.equal(require('../src/python/python-inspector-source.json'),
    await fs.readFile(path.join(__dirname, '../runtime/python/source_inspector.py'), 'utf8'));
  assert.deepEqual(launchArguments(['one argument', '', '--marker']), ['one argument', '', '--marker']);
  assert.throws(() => launchArguments(['x\0y']), /program arguments/);
});

test('actual Python AST reports class, async method and syntax positions', { skip: !python, timeout: 20000 }, async () => {
  const result = await inspectPythonSource(python, 'class Panel:\n    async def update(self):\n        return "✓"\n');
  assert.deepEqual(result.symbols[0].selection, [[0, 6], [0, 11]]);
  const method = result.symbols[0].children[0];
  assert.equal(method.kind, 'async function');
  assert.deepEqual(method.selection, [[1, 14], [1, 20]]);
  const invalid = await inspectPythonSource(python, 'def sample(:\n    pass\n');
  assert.equal(invalid.error.position[0], 0);
  assert.match(invalid.error.message, /syntax/);
});

test('actual debugpy pauses, steps and returns Python locals', { skip: !python, timeout: 35000 }, async () => {
  const temp = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temp, 'rocketbrain-py-'));
  const program = path.join(directory, 'program.py');
  await fs.writeFile(program, 'def calculate():\n    amount = 21\n    result = amount * 2\n    return result\n\nprint(calculate())\n');
  const port = await freePort();
  const adapter = spawn(python, ['-I', '-m', 'debugpy.adapter', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: directory, env: pythonEnvironment(), windowsHide: true, stdio: 'ignore'
  });
  const exited = once(adapter, 'close');
  void exited.catch(() => {});
  let client;
  try {
    for (let attempt = 0; attempt < 25; attempt++) {
      const candidate = new DapClient(port);
      try { await candidate.ready; client = candidate; break; }
      catch { candidate.socket.destroy(); await delay(100); }
    }
    assert.ok(client, 'The owned debugpy adapter did not start.');
    await client.request('initialize', { clientID: 'rocketbrain-test', adapterID: 'python', linesStartAt1: true, columnsStartAt1: true }, 5000);
    const launching = client.request('launch', { program, cwd: directory, python: [python], console: 'internalConsole', justMyCode: true }, 10000);
    void launching.catch(() => {});
    await client.event('initialized', 0, 6000);
    const hit = await client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] }, 5000);
    assert.equal(hit.breakpoints[0].verified, true);
    await client.request('configurationDone', {}, 5000);
    await launching;
    const first = await client.event('stopped', 0, 8000);
    const before = await locals(client, first.threadId);
    assert.equal(before.frame.line, 3);
    assert.equal(before.values.find(item => item.name === 'amount').value, '21');
    const previous = client.events.length;
    await client.request('next', { threadId: first.threadId }, 5000);
    const second = await client.event('stopped', previous, 8000);
    const after = await locals(client, second.threadId);
    assert.equal(after.frame.line, 4);
    assert.equal(after.values.find(item => item.name === 'result').value, '42');
    await client.request('continue', { threadId: second.threadId }, 5000);
    await client.event('terminated', previous, 8000);
  } finally {
    await client?.close();
    if (adapter.exitCode === null && adapter.signalCode === null) adapter.kill();
    await exited.catch(() => {});
    const verified = await fs.realpath(directory);
    assert.ok(!path.relative(directory, verified) && path.dirname(verified) === temp);
    await fs.rm(verified, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

async function locals(client, threadId) {
  const { stackFrames: [frame] } = await client.request('stackTrace', { threadId, levels: 1 }, 5000);
  const { scopes } = await client.request('scopes', { frameId: frame.id }, 5000);
  const reference = scopes.find(scope => scope.name === 'Locals').variablesReference;
  const { variables: values } = await client.request('variables', { variablesReference: reference }, 5000);
  return { frame, values };
}
