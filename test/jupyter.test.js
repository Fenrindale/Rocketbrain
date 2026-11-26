'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decodeNotebook, encodeNotebook, marker } = require('../src/python/jupyter-format');
const { openJupyterKernel } = require('../src/python/jupyter-kernel');
const { until } = require('./helpers/stdio-lsp');

const vscode = {
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookCellData: class { constructor(kind, value, languageId) { Object.assign(this, { kind, value, languageId }); } },
  NotebookData: class { constructor(cells) { this.cells = cells; } },
  NotebookCellOutput: class { constructor(items, metadata) { Object.assign(this, { items, metadata }); } },
  NotebookCellOutputItem: class {
    constructor(data, mime) { Object.assign(this, { data, mime }); }
    static text(data) { return { data, mime: 'text/plain' }; }
    static stdout(data) { return { data, mime: 'application/vnd.code.notebook.stdout' }; }
    static stderr(data) { return { data, mime: 'application/vnd.code.notebook.stderr' }; }
    static json(data) { return { data, mime: 'application/json' }; }
  }
};

const notebook = {
  nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    projectNotes: { schema: 'owned' } },
  cells: [
    { id: 'attachment', cell_type: 'markdown', metadata: { tags: ['note'] }, source: ['# Report\n', '![Image](attachment:plot.png)'],
      attachments: { 'plot.png': { 'image/png': 'aGVsbG8=' } } },
    { id: 'first', cell_type: 'code', metadata: { tags: ['visible'] }, source: 'value = 21', execution_count: 7,
      outputs: [{ output_type: 'display_data', metadata: { missingRenderer: true }, data: { 'text/html': '<strong>Preserve</strong>' } }] },
    { id: 'raw', cell_type: 'raw', metadata: {}, source: 'literal' }
  ]
};

test('nbformat metadata, attachments and unsupported MIME data survive model editing and serialization', () => {
  const data = decodeNotebook(vscode, Buffer.from(JSON.stringify(notebook)));
  assert.equal(data.cells[2].languageId, 'plaintext');
  assert.equal(data.cells[1].executionSummary.executionOrder, 7);
  assert.equal(data.cells[1].outputs[0].items[0].mime, 'text/plain');
  assert.equal(data.cells[1].outputs[0].metadata[marker].data['text/html'], '<strong>Preserve</strong>');
  data.cells[1].value = 'value = 22';
  const roundtrip = JSON.parse(encodeNotebook(vscode, data));
  assert.deepEqual(roundtrip.metadata, notebook.metadata);
  assert.deepEqual(roundtrip.cells[0], { ...notebook.cells[0], source: notebook.cells[0].source.join('') });
  assert.deepEqual(roundtrip.cells[1], { ...notebook.cells[1], source: 'value = 22' });
  assert.deepEqual(roundtrip.cells[2], notebook.cells[2]);
  assert.throws(() => decodeNotebook(vscode, Buffer.from('{"nbformat":3,"cells":[]}')), /nbformat 4/);
});

test('embedded notebook bridge matches the owned Python source', () => {
  assert.equal(require('../src/python/jupyter-bridge-source.json'),
    fs.readFileSync(path.join(__dirname, '../runtime/jupyter/notebook_bridge.py'), 'utf8'));
});

const python = process.env.ROCKETBRAIN_JUPYTER_TEST_PYTHON;
test('real ipykernel persists state, projects typed results and cancels a running cell', { skip: !python, timeout: 45000 }, async () => {
  const kernel = openJupyterKernel({ python, directory: __dirname });
  try {
    assert.equal((await kernel.ready).language, 'python');
    const first = await kernel.execute('value = 21\nprint(value)');
    assert.equal(first.executionCount, 1);
    assert.equal(first.outputs[0].text, '21\n');
    const second = await kernel.execute('value * 2');
    assert.equal(second.outputs[0].data['text/plain'], '42');
    const error = await kernel.execute('raise ValueError("owned error")');
    assert.equal(error.success, false);
    assert.equal(error.outputs.at(-1).ename, 'ValueError');
    const cancellation = new AbortController();
    const running = kernel.execute('import time\ntime.sleep(20)', { cancellation: cancellation.signal });
    const timer = setTimeout(() => cancellation.abort(), 900);
    try {
      const stopped = await running;
      assert.equal(stopped.cancelled, true);
      assert.equal(stopped.success, false);
    } finally { clearTimeout(timer); }
  } finally { await kernel.close(); }
  assert.equal(kernel.stopped, true);
});

test('real Jupyter debugger holds an exact cell line, steps over, reads locals and resets only its notebook', {
  skip: !python, timeout: 90000
}, async context => {
  const parent = fs.realpathSync(os.tmpdir());
  const owned = fs.mkdtempSync(path.join(parent, 'rb-jupyter-debug-'));
  const kernel = openJupyterKernel({ python, directory: owned });
  const peer = openJupyterKernel({ python, directory: owned });
  try {
    assert.equal((await kernel.ready).debugger, true);
    assert.equal((await kernel.execute('seed = 27')).success, true);
    assert.equal((await peer.execute('isolated = 83')).success, true);
    await assert.rejects(kernel.debug('raise RuntimeError("missing breakpoint executed")'), /breakpoint line/);
    await assert.rejects(kernel.debug('\nraise RuntimeError("wrong breakpoint executed")', 1), /executable Python line/);
    const pauses = [];
    const code = 'value = seed\r\ndouble = value * 2\r\nprint(double)';
    const run = kernel.debug(code, 2, { onDebug: value => pauses.push(value) });
    void run.catch(() => {});
    const first = await Promise.race([until(() => pauses[0], 18000), run.then(() => { throw Error('Missing source breakpoint.'); })]);
    assert.deepEqual(first, { state: 'paused', pause: 1, line: 2, reason: 'breakpoint' });
    await assert.rejects(kernel.execute('seed = 0'), /Wait for this notebook cell/);
    await assert.rejects(kernel.debugControl('evaluate', first.pause), /current paused/);
    const locals = (await kernel.debugControl('locals', first.pause)).variables;
    assert.deepEqual(locals.find(local => local.name === 'value'), { name: 'value', value: '27', type: 'int' });
    assert.ok(!locals.some(local => local.name === 'double'));
    await kernel.debugControl('next', first.pause);
    const second = await until(() => pauses[1], 10000);
    assert.deepEqual(second, { state: 'paused', pause: 2, line: 3, reason: 'step' });
    await assert.rejects(kernel.debugControl('continue', first.pause), /current paused/);
    assert.deepEqual((await kernel.debugControl('locals', second.pause)).variables.find(local => local.name === 'double'),
      { name: 'double', value: '54', type: 'int' });
    await kernel.debugControl('continue', second.pause);
    const complete = await run;
    assert.equal(complete.success, true);
    assert.equal(complete.outputs.map(output => output.text).join(''), '54\n');
    assert.equal((await kernel.execute('double + 1')).outputs[0].data['text/plain'], '55');
    const cancellation = new AbortController();
    let held;
    const markerFile = path.join(owned, 'continued-unexpectedly.txt');
    const stopCode = 'from pathlib import Path\nPath(' + JSON.stringify(markerFile) + ').write_text("unexpected")';
    const stopRun = kernel.debug(stopCode, 2, { cancellation: cancellation.signal, onDebug: event => { held = event; } });
    void stopRun.catch(() => {});
    assert.equal((await until(() => held, 18000)).line, 2);
    cancellation.abort();
    const stopped = await stopRun;
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.kernelStopped, true);
    assert.equal(kernel.stopped, true);
    assert.equal(fs.existsSync(markerFile), false);
    assert.equal((await peer.execute('isolated')).outputs[0].data['text/plain'], '83');
    const evidence = { exactBreakpoint: 2, steppedLine: 3, locals: [27, 54], outputPersisted: true,
      invalidBreakpointRejected: true, stalePauseRejected: true, genericEvaluationRejected: true,
      cancelledBeforeNextStatement: true, independentKernelPreserved: true };
    context.diagnostic(JSON.stringify(evidence));
    if (process.env.ROCKETBRAIN_JUPYTER_DEBUG_RECEIPT) {
      fs.writeFileSync(process.env.ROCKETBRAIN_JUPYTER_DEBUG_RECEIPT, JSON.stringify(evidence, null, 2) + '\n');
    }
  } finally {
    await Promise.all([kernel.close(), peer.close()]);
    const actual = fs.realpathSync(owned);
    assert.equal(actual, owned);
    assert.equal(path.dirname(actual), parent);
    assert.match(path.basename(actual), /^rb-jupyter-debug-/u);
    fs.rmSync(actual, { recursive: true, force: true });
  }
});
