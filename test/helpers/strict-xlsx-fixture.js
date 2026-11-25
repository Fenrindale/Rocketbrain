'use strict';

const { entries, zip } = require('./xlsx-fixture');

const spreadsheet = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const relationships = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const transitionalSpreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const transitionalRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function strictEntries(rows, { date1904 = true } = {}) {
  const parts = Object.fromEntries(Object.entries(entries({ rows, date1904 })).map(([name, xml]) => [
    name, xml.replaceAll(transitionalSpreadsheet, spreadsheet).replaceAll(transitionalRelationships, relationships).replaceAll(' xml:space="preserve"', '')
  ]));
  parts['xl/workbook.xml'] = parts['xl/workbook.xml'].replace('<workbook ', '<workbook conformance="strict" ');
  parts['xl/_rels/workbook.xml.rels'] = parts['xl/_rels/workbook.xml.rels'].replace('</Relationships>',
    '<Relationship Id="shared" Type="' + relationships + '/sharedStrings" Target="sharedStrings.xml"/></Relationships>');
  parts['xl/sharedStrings.xml'] = '<sst xmlns="' + spreadsheet + '" count="1" uniqueCount="1"><si>' +
    '<r><t>검증 </t></r><r><t>shared &amp; literal</t></r></si></sst>';
  const types = {
    '/xl/sharedStrings.xml': 'sharedStrings', '/xl/styles.xml': 'styles',
    '/xl/worksheets/sheet1.xml': 'worksheet', '/xl/worksheets/sheet2.xml': 'worksheet'
  };
  const overrides = Object.entries(types).map(([part, type]) => '<Override PartName="' + part +
    '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.' + type + '+xml"/>');
  parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('</Types>', overrides.join('') + '</Types>');
  return parts;
}

function strictRows(count, prefix = 'Strict') {
  return [
    ['label', 'amount', 'big_value', 'note', 'day', 'flag'],
    ...Array.from({ length: count }, (_, index) => [
      index === 0 && prefix === 'Strict' ? { type: 's', value: '0' } : prefix + ' ' + index,
      index === 0 && prefix === 'Strict' ? { formula: 'A2', value: '1234567890123456.12345678' } : { value: '1e-8' },
      { value: index === 0 ? '18446744073709551615' : '9007199254740993' },
      index % 2 ? '' : null,
      index % 2 ? { value: '0.5', style: 2 } : { type: 'd', value: '2026-01-03T12:34:56.123456' },
      { type: 'b', value: index % 2 ? '0' : '1' }
    ])
  ];
}

const strictWorkbook = (rows, options) => zip(strictEntries(rows, options));

module.exports = { strictEntries, strictWorkbook, strictRows, spreadsheet, relationships, transitionalSpreadsheet, transitionalRelationships };
