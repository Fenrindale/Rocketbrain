'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { compileExtractor, describeCapture, extract, limits } = require('./data-extractor');

const lifetime = 10 * 60 * 1000;
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_DATA_EXTRACTOR' });

async function loadExtractor(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.toLowerCase().endsWith('.rbextract.json')) {
    throw fail('Choose a local .rbextract.json extractor script.');
  }
  const handle = await fs.open(file, 'r');
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > limits.scriptBytes) throw fail('Choose a local extractor script up to 64 KiB.');
    const buffer = Buffer.alloc(limits.scriptBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = await handle.read(buffer, length, buffer.length - length, null);
      if (!count.bytesRead) break;
      length += count.bytesRead;
    }
    if (length > limits.scriptBytes) throw fail('The extractor script exceeds 64 KiB.');
    try { return new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw fail('The extractor script must contain valid UTF-8.'); }
  } finally { await handle.close(); }
}

function createExtractorReviews({ getCapture, canRead }) {
  const reviews = new Map();
  let disposed = false;
  const trusted = () => {
    if (disposed || !canRead()) throw fail('Trust this workspace before preparing or saving a custom extractor.');
  };
  function pending(id) {
    const review = reviews.get(id);
    if (!review || review.expires <= Date.now()) {
      reviews.delete(id);
      throw fail('Review the captured result and extractor again.');
    }
    return review;
  }
  const guard = (id, result) => () => !disposed && canRead() && getCapture(id) === result;
  return {
    async prepare(resultId, source, options = {}) {
      trusted();
      const result = getCapture(resultId);
      const catalog = describeCapture(result);
      const program = compileExtractor(source, catalog);
      const digest = createHash('sha256');
      const sample = [];
      let bytes = 0, previewBytes = 0;
      const current = guard(resultId, result);
      for await (const chunk of extract(program, result.rows, { guard: current, signal: options.signal })) {
        digest.update(chunk);
        bytes += chunk.length;
        if (previewBytes < limits.previewBytes) {
          const slice = chunk.subarray(0, limits.previewBytes - previewBytes);
          sample.push(slice);
          previewBytes += slice.length;
        }
      }
      if (!current() || options.signal?.aborted) throw fail('The captured result changed. Review it again.');
      if (!bytes) throw fail('The reviewed extractor produced an empty file. Adjust the filter or template.');
      const id = randomUUID(), expires = Date.now() + lifetime;
      const preview = new TextDecoder('utf8').decode(Buffer.concat(sample), { stream: previewBytes !== bytes });
      const summary = { id, resultId, script: program.name, extension: program.extension, rowCount: catalog.rowCount,
        schema: catalog.schema, table: catalog.table, partial: catalog.partial,
        scriptSha256: createHash('sha256').update(source).digest('hex'), sha256: digest.digest('hex'), bytes,
        preview, previewClipped: previewBytes !== bytes, expires: new Date(expires).toISOString() };
      for (const [key, value] of reviews) if (value.expires <= Date.now()) reviews.delete(key);
      while (reviews.size >= 8) reviews.delete(reviews.keys().next().value);
      reviews.set(id, { summary, program, resultId, result, expires });
      return { ...summary };
    },
    preview(id) {
      trusted();
      const review = pending(id);
      if (!guard(review.resultId, review.result)()) throw fail('The captured result changed. Review it again.');
      return { ...review.summary };
    },
    async write(id, file, { confirmed, signal } = {}) {
      trusted();
      const review = pending(id);
      if (confirmed !== true || typeof file !== 'string' || !path.isAbsolute(file) ||
          path.extname(file).slice(1).toLowerCase() !== review.summary.extension) {
        throw fail('Approve the reviewed extractor and choose a matching local output file.');
      }
      const current = guard(review.resultId, review.result);
      if (!current() || signal?.aborted) throw fail('The captured result changed. Review it again.');
      reviews.delete(id);
      const parent = await fs.realpath(path.dirname(file));
      const destination = path.join(parent, path.basename(file));
      const temporary = path.join(parent, '.rocketbrain-extractor-' + randomUUID() + '.pending');
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of extract(review.program, review.result.rows, { guard: current, signal })) {
          bytes += chunk.length;
          hash.update(chunk);
          if (chunk.length) await handle.writeFile(chunk);
        }
        const sha256 = hash.digest('hex');
        if (sha256 !== review.summary.sha256 || bytes !== review.summary.bytes) throw fail('The extractor output differs from the review. Prepare it again.');
        await handle.sync();
        if (!current() || signal?.aborted) throw fail('The captured result changed. Review it again.');
        try { await fs.link(temporary, destination); }
        catch { throw fail('Choose a new output name on a local filesystem that supports atomic file creation.'); }
        return { bytes, sha256, file: destination, rowCount: review.summary.rowCount };
      } finally {
        await handle.close();
        await fs.unlink(temporary);
      }
    },
    dispose() { disposed = true; reviews.clear(); }
  };
}

module.exports = { createExtractorReviews, loadExtractor };
