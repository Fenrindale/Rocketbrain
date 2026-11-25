'use strict';

function encodeUtf16(text, encoding) {
  const bytes = Buffer.from(text, 'utf16le');
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), bytes.swap16()]);
  throw Error('Choose a UTF-16 byte order.');
}

function delimitedFixture(delimiter, rowCount, chunkBytes) {
  const header = ['id', 'payload', 'marker'].join(delimiter) + '\r\n';
  const padding = 'x'.repeat(chunkBytes / 2 - 1 - header.length - 3);
  const firstPayload = padding + '😀끝\ufeff\r\n서울' + delimiter + '"인용"';
  const sample = [
    [1, firstPayload, null],
    [2, '둘째 "글자"', 'NULL'],
    [3, '', '']
  ];
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  const fixtureRows = sample.map(([id, payload, marker]) =>
    [id, quote(payload), marker === null ? 'NULL' : quote(marker)].join(delimiter));
  for (let id = 4; id <= rowCount; id++) fixtureRows.push([id, '행 ' + id, 'present'].join(delimiter));
  return { text: header + fixtureRows.join('\r\n') + '\r\n', sample, splitAt: chunkBytes / 2 - 1 };
}

module.exports = { delimitedFixture, encodeUtf16 };
