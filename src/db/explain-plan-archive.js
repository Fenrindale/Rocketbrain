'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { TextDecoder } = require('node:util');
const { normalizePlan } = require('./explain-plan');
const { sampleCount, summarizeSeries } = require('./explain-plan-series');

const MAX_SAMPLE_FILE_BYTES = 32 * 1024 * 1024;
const sizeError = () => Error('SQL plan sample files must be at most 32 MiB.');
const textField = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

function deserializeSamples(bytes) {
  if (bytes.length > MAX_SAMPLE_FILE_BYTES) throw sizeError();
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes));
  } catch {
    throw Error('Choose a UTF-8 Rocketbrain SQL plan sample JSON file.');
  }
  if (payload?.format !== 'RocketbrainSqlPlanSamples' || payload.version !== 1 ||
      !Array.isArray(payload.samples) || payload.summary?.measured !== true) {
    throw Error('Choose a Rocketbrain SQL plan sample file in version 1 format.');
  }
  sampleCount(payload.samples.length);
  const { engine, version, database, format, totalSamples } = payload.summary;
  if (!['mysql', 'mariadb'].includes(engine) || format !== (engine === 'mysql' ? 'tree' : 'json') ||
      !textField(version, 255) || !textField(database, 255) || totalSamples !== payload.samples.length) {
    throw Error('The saved SQL plan has inconsistent capture metadata.');
  }
  const { capturedAt } = payload;
  if (typeof capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capturedAt) ||
      !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) {
    throw Error('The saved SQL plan has an invalid capture timestamp.');
  }
  const plans = payload.samples.map((sample, index) => {
    if (sample?.number !== index + 1 || sample.format !== format) throw Error('The saved SQL plan samples are out of order or use mixed formats.');
    return normalizePlan({ raw:sample.raw, engine, version, database, format, measured:true });
  });
  // Raw server output is the input. Stored summaries, shapes and warnings are display data.
  return { series:summarizeSeries(plans), plans, capturedAt };
}

async function readSavedSamples(path) {
  return deserializeSamples(await readPlanFile(path, MAX_SAMPLE_FILE_BYTES, 'Choose a regular local SQL plan sample file.', sizeError));
}

async function readPlanFile(path, maxBytes, typeError, sizeError) {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error(typeError);
    if (stat.size > maxBytes) throw sizeError();
    const chunks = [];
    for await (const chunk of file.createReadStream({ start:0, end:maxBytes, autoClose:false })) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.length > maxBytes) throw sizeError();
    return bytes;
  } finally {
    await file.close();
  }
}

module.exports = { MAX_SAMPLE_FILE_BYTES, deserializeSamples, readSavedSamples, readPlanFile };
