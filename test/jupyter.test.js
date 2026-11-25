'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { decodeNotebook, encodeNotebook, marker } = require('../src/python/jupyter-format');
const { openJupyterKernel } = require('../src/python/jupyter-kernel');

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
