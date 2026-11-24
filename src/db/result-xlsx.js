'use strict';

const { deflateRawSync } = require('node:zlib');

const workbookNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const worksheetLimit = 20 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function archive(parts) {
  const local = [], directory = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const filename = Buffer.from(name, 'ascii');
    const source = Buffer.from(xml, 'utf8'), compressed = deflateRawSync(source);
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(source), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(source.length, 22);
    header.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    directory.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory), trailer = Buffer.alloc(22);
  const count = Object.keys(parts).length;
  trailer.writeUInt32LE(0x06054b50);
  trailer.writeUInt16LE(count, 8);
  trailer.writeUInt16LE(count, 10);
  trailer.writeUInt32LE(central.length, 12);
  trailer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, trailer]);
}

function xmlString(value) {
  if (value.length > 32767 || (value.match(/\n/g)?.length || 0) > 253) {
    throw Error('A result value exceeds the Excel text cell limit. Export JSON to preserve the full value.');
  }
  if (/[\ud800-\udfff]/u.test(value)) throw Error('A result value contains invalid Unicode. Export JSON to preserve its escaped representation.');
  return value.replace(/_x[\da-fA-F]{4}_|[\x00-\x08\x0b-\x1f\ufffe\uffff]/g, token =>
    token.length > 1 ? '_x005F_' + token.slice(1) : '_x' + token.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase() + '_')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function columnAddress(index) {
  let value = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + ((n - 1) % 26)) + value;
  return value;
}

function cell(address, value) {
  if (value === null) return '';
  if (typeof value === 'boolean') return `<c r="${address}" t="b"><v>${value ? '1' : '0'}</v></c>`;
  // Exact DB numbers received as strings stay strings. JS numbers stay numeric
  // only if Excel's precision and range preserve the displayed value.
  if (typeof value === 'number' && !Object.is(value, -0) && Number(value.toPrecision(15)) === value &&
      Math.abs(value) <= 9.99999999999999e307 && (value === 0 || Math.abs(value) >= 2.2251e-308)) {
    return `<c r="${address}"><v>${value}</v></c>`;
  }
  const encoded = xmlString(Object.is(value, -0) ? '-0' : String(value));
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${encoded}</t></is></c>`;
}

function workbook(columns, rows) {
  if (columns.length > 16384 || rows.length >= 1048576) throw Error('This result exceeds the Excel worksheet dimensions.');
  const addresses = columns.map((_, index) => columnAddress(index));
  const worksheet = [];
  let bytes = 0;
  for (const [index, row] of [columns, ...rows].entries()) {
    const rowNumber = index + 1;
    const values = row.map((value, col) => cell(addresses[col] + rowNumber, value)).join('');
    const xml = `<row r="${rowNumber}">${values}</row>`;
    bytes += Buffer.byteLength(xml);
    if (bytes > worksheetLimit) throw Error('This result exceeds the 20 MiB Excel worksheet limit. Export a smaller page.');
    worksheet.push(xml);
  }
  return archive({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="${relationshipNamespace}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${workbookNamespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Query Results" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="${relationshipNamespace}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${workbookNamespace}"><sheetData>${worksheet.join('')}</sheetData></worksheet>`
  });
}

module.exports = { workbook };
