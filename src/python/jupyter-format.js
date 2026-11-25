'use strict';

const { randomUUID } = require('node:crypto');

const marker = 'rocketbrainJupyter';
const maxBytes = 16 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const text = value => Array.isArray(value) ? value.join('') : String(value ?? '');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function outputItem(vscode, output) {
  const { NotebookCellOutput, NotebookCellOutputItem: item } = vscode;
  const items = [];
  if (output.output_type === 'stream') {
    items.push(output.name === 'stderr' ? item.stderr(text(output.text)) : item.stdout(text(output.text)));
  } else if (output.output_type === 'error') {
    items.push(item.error({ name: text(output.ename), message: text(output.evalue),
      stack: Array.isArray(output.traceback) ? output.traceback.join('\n') : text(output.traceback) }));
  } else if (object(output.data)) {
    const data = output.data;
    if (typeof data['image/png'] === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(data['image/png'])) {
      items.push(new item(Buffer.from(data['image/png'], 'base64'), 'image/png'));
    }
    if (data['application/json'] !== undefined) items.push(item.json(data['application/json']));
    if (data['text/plain'] !== undefined) items.push(item.text(text(data['text/plain'])));
  }
  if (!items.length) items.push(item.text('This output is preserved in the notebook file.'));
  return new NotebookCellOutput(items, { [marker]: output });
}

function decodeNotebook(vscode, bytes) {
  if (bytes.length > maxBytes) throw Error('Open a Jupyter notebook up to 16 MiB.');
  const raw = bytes.length ? JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) : {
    nbformat: 4, nbformat_minor: 5, metadata: {}, cells: []
  };
  if (!object(raw) || raw.nbformat !== 4 || !Number.isSafeInteger(raw.nbformat_minor) ||
      raw.nbformat_minor < 0 || !Array.isArray(raw.cells) || raw.cells.length > 300) {
    throw Error('Open an nbformat 4 notebook with at most 300 cells.');
  }
  const { cells, ...header } = raw;
  const language = header.metadata?.language_info?.name || header.metadata?.kernelspec?.language || 'python';
  const languageId = typeof language === 'string' && /^[a-z][a-z0-9_-]{0,32}$/i.test(language) ? language.toLowerCase() : 'plaintext';
  const result = new vscode.NotebookData(cells.map(cell => {
    if (!object(cell) || !['code', 'markdown', 'raw'].includes(cell.cell_type) ||
        typeof cell.source !== 'string' && (!Array.isArray(cell.source) || cell.source.some(line => typeof line !== 'string'))) {
      throw Error('The notebook contains an unsupported cell or source value.');
    }
    const { source, outputs, execution_count: executionOrder, ...attributes } = cell;
    const code = cell.cell_type === 'code';
    const markup = cell.cell_type === 'markdown';
    const cellData = new vscode.NotebookCellData(markup ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
      text(source), markup ? 'markdown' : code ? languageId : 'plaintext');
    cellData.metadata = { [marker]: attributes };
    if (code) {
      if (!Array.isArray(outputs) || outputs.length > 500 || outputs.some(value => !object(value))) {
        throw Error('The notebook contains an invalid or oversized output list.');
      }
      cellData.outputs = outputs.map(output => outputItem(vscode, output));
      if (Number.isSafeInteger(executionOrder)) cellData.executionSummary = { executionOrder };
    }
    return cellData;
  }));
  result.metadata = { [marker]: header };
  return result;
}

function encodeNotebook(vscode, data) {
  if (data.cells.length > 300) throw Error('Save a Jupyter notebook with at most 300 cells.');
  const original = data.metadata?.[marker] || { nbformat: 4, nbformat_minor: 5, metadata: {} };
  const used = new Set();
  const cells = data.cells.map(cell => {
    const previous = cell.metadata?.[marker] || {};
    const cellType = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : previous.cell_type === 'raw' ? 'raw' : 'code';
    const id = validId(previous.id) && !used.has(previous.id) ? previous.id : original.nbformat_minor >= 5 ? randomUUID() : undefined;
    if (id) used.add(id);
    const result = { ...previous, cell_type: cellType, source: cell.value, metadata: previous.metadata || {} };
    if (id) result.id = id;
    else delete result.id;
    if (cellType === 'code') {
      result.execution_count = cell.executionSummary?.executionOrder ?? null;
      result.outputs = (cell.outputs || []).map(value => value.metadata?.[marker]).filter(object);
    }
    return result;
  });
  const output = Buffer.from(JSON.stringify({ ...original, cells }, null, 1) + '\n');
  if (output.length > maxBytes) throw Error('Save a Jupyter notebook up to 16 MiB.');
  return output;
}

module.exports = { marker, decodeNotebook, encodeNotebook, outputItem };
