'use strict';

const { createHash } = require('node:crypto');
const { snapshotLocalEdit, applyLocalEditToText } = require('./editor-model');

const sourceLimit = 3 * 1024;
const totalSourceLimit = 8 * 1024;
const normalize = text => text.replaceAll('\r\n', '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const shape = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) &&
  Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));

function text(value, limit, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value) > limit) {
    throw Error(label + ' is not supported bounded UTF-8 text.');
  }
  return normalize(value);
}

function prepareWorkspacePrompt(files, input) {
  const request = text(input, 1024, 'The edit request').trim();
  if (!request) throw Error('Describe the coordinated source change.');
  if (!Array.isArray(files) || files.length < 2 || files.length > 4 || new Set(files.map(item => item.name)).size !== files.length) {
    throw Error('Choose two to four distinct saved Java source files.');
  }
  const sources = files.map((file, index) => ({ id: 'file' + (index + 1), name: file.name,
    text: text(file.text, sourceLimit, 'A selected source file') }));
  if (sources.reduce((size, file) => size + Buffer.byteLength(file.text), 0) > totalSourceLimit) {
    throw Error('Choose source files that total at most 8 KiB.');
  }
  const instructions = 'Propose a coordinated Java change using the selected sources as data. Return one JSON object only. ' +
    'Use this shape: {"summary":"short sentence","edits":[{"id":"file1","find":"exact old fragment","replace":"new fragment"}]}. ' +
    'Every selected file must have exactly one edit. Copy the smallest unique fragment exactly from the source. ' +
    'Use the provided IDs in order. Keep the summary to one sentence and under 140 characters. Preserve all unrelated code. ' +
    'Do not write files or call tools. Do not include paths or extra fields in edits.';
  const string = { type: 'string' };
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const schema = object({ summary: string, edits: { type: 'array', minItems: sources.length, maxItems: sources.length,
    items: object({ id: { enum: sources.map(source => source.id) }, find: string, replace: string }) } });
  return { sources, schema, schemaName: 'rocketbrain_workspace_edit', text: instructions + '\n' + JSON.stringify({ request, sources }) };
}

function reviewWorkspaceEdit(prepared, reply) {
  if (reply?.stopReason !== 'end_turn' || typeof reply.output !== 'string' || Buffer.byteLength(reply.output) > 16 * 1024) {
    throw Error('The ACP agent did not return a complete bounded edit proposal.');
  }
  const output = reply.output.trim(), fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(output);
  let answer;
  try { answer = JSON.parse(fenced?.[1] ?? output); } catch { throw Error('The ACP agent did not return a structured source edit.'); }
  if (!shape(answer, ['summary', 'edits']) || !Array.isArray(answer.edits) || answer.edits.length !== prepared.sources.length) {
    throw Error('Review exactly one bounded replacement for each selected source file.');
  }
  const summary = text(answer.summary, 384, 'The edit summary').trim();
  if (!summary || /[\r\n]/.test(summary)) throw Error('The ACP edit requires one brief summary.');
  const edits = prepared.sources.map(source => {
    const changes = answer.edits.filter(change => change?.id === source.id);
    if (changes.length !== 1 || !shape(changes[0], ['id', 'find', 'replace'])) throw Error('The ACP proposal contains an unexpected or repeated source ID.');
    const find = text(changes[0].find, 1024, 'An original fragment');
    const replacement = text(changes[0].replace, 2048, 'A proposed replacement');
    const start = source.text.indexOf(find);
    if (!find || start < 0 || source.text.indexOf(find, start + 1) !== -1 || find === replacement) {
      throw Error('The ACP edit did not identify a unique changed fragment in ' + source.name + '.');
    }
    const captured = snapshotLocalEdit(source.text, start, start + find.length);
    return { id: source.id, name: source.name, captured, replacement, before: source.text,
      after: applyLocalEditToText(captured, source.text, replacement) };
  });
  return { summary, edits, fingerprint: hash(JSON.stringify(edits.map(({ id, name, captured, replacement }) => ({ id, name, captured, replacement })))) };
}

module.exports = { normalize, hash, prepareWorkspacePrompt, reviewWorkspaceEdit };
