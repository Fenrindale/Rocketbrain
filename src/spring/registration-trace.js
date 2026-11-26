'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const maxBytes = 2 * 1024 * 1024;
const maxEntries = 4096;
const operations = new Set(['register', 'remove', 'alias', 'unalias']);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const invalid = () => Error('The Spring registration trace contains an invalid record.');

function source(value) {
  if (value === null) return null;
  if (!text(value?.type, 2048) || !text(value.method, 512) || typeof value.file !== 'string' ||
      value.file.length > 512 || !Number.isInteger(value.line)) throw invalid();
  return { type: value.type, method: value.method, file: value.file, line: value.line };
}

function parseRegistrationTrace(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > maxBytes) {
    throw Error('Open a Spring registration trace up to 2 MiB.');
  }
  const rows = input.split('\n');
  const pendingLine = Boolean(rows.pop());
  let header;
  try { header = JSON.parse(rows.shift()); } catch { throw invalid(); }
  const factory = header?.version === 2 && header.mode === 'bean-factory';
  if (header?.kind !== 'spring-registration' || header.version !== 1 && !factory || rows.length > maxEntries + 1) throw invalid();

  const scopes = new Map(), mutations = [];
  let truncated = false;
  for (const line of rows) {
    let row;
    try { row = JSON.parse(line); } catch { throw invalid(); }
    if (truncated) throw invalid();
    if (row?.kind === 'truncated') {
      truncated = true;
      continue;
    }
    if (!Number.isInteger(row?.id) || row.id < 1 || row.id > maxEntries) throw invalid();
    if (row.kind === 'begin') {
      if (row.id !== scopes.size + 1 || !text(row.label, 512)) throw invalid();
      scopes.set(row.id, { id: row.id, label: row.label, outcome: 'open', mutationCount: 0 });
      continue;
    }
    const scope = scopes.get(row.id);
    if (scope?.outcome !== 'open') throw invalid();
    if (row.kind === 'end' && ['returned', 'threw'].includes(row.outcome)) {
      scope.outcome = row.outcome;
      continue;
    }
    const isAlias = row.operation === 'alias';
    if (row.kind !== 'mutation' || !operations.has(row.operation) || !text(row.name, 512) ||
        (isAlias ? !text(row.alias, 512) : row.alias !== undefined)) throw invalid();
    scope.mutationCount++;
    mutations.push({ scope: scope.id, label: scope.label, operation: row.operation, name: row.name,
      ...(isAlias && { alias: row.alias }), origin: source(row.origin),...(factory && {provider:source(row.provider)}) });
  }
  return { version:header.version,...(factory && {mode:header.mode}), truncated, pendingLine, scopes: [...scopes.values()], mutations };
}

async function readRegistrationTrace(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}|[\0\r\n]/u.test(file) ||
      path.extname(file).toLowerCase() !== '.jsonl') throw Error('Select a local Spring registration JSONL file.');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw Error('Open a regular Spring registration trace file up to 2 MiB.');
  }
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw Error('The Spring registration trace file changed.');
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const page = await handle.read(bytes, length, bytes.length - length, length);
      if (page.bytesRead === 0) break;
      length += page.bytesRead;
    }
    if (length > maxBytes) throw Error('Open a Spring registration trace up to 2 MiB.');
    return parseRegistrationTrace(bytes.toString('utf8', 0, length));
  } finally {
    await handle.close();
  }
}

module.exports = { parseRegistrationTrace, readRegistrationTrace };
