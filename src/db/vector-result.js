'use strict';

const vectorType = 0xf2;
const maximumDimensions = 16383;

function vectorResultText(bytes) {
  if (bytes === null) return null;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length % 4 !== 0 || bytes.length > 4 * maximumDimensions) {
    throw Error('The server returned an invalid native VECTOR payload.');
  }
  const values = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const value = bytes.readFloatLE(offset);
    if (!Number.isFinite(value)) throw Error('The server returned a non-finite VECTOR value.');
    values.push(Object.is(value, -0) ? '-0' : String(value));
  }
  return '[' + values.join(',') + ']';
}

module.exports = { vectorType, vectorResultText };
