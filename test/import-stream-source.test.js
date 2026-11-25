'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {writeOwnedImportSource}=require('./helpers/owned-import-source'),writeSource=(file,bytes)=>writeOwnedImportSource(file,bytes,{ownedDirectory:path.dirname(file)});
const {scanSource,LIMITS}=require('../src/db/import-stream-source'),{workbook,entries,zip}=require('./helpers/xlsx-fixture');
const { delimitedFixture, encodeUtf16 } = require('./helpers/utf16-delimited-fixture');
async function fixture(t,name,text){const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'rocketbrain-stream-source-')),file=path.join(folder,name);await writeSource(file,text);t.after(async()=>{await fs.promises.unlink(file).catch(()=>{});await fs.promises.rmdir(folder);});return file;}
test('CSV streams beyond eight MiB and 500 rows, preserving quoted fields, exact values and NULL distinctions',async t=>{const text='label,amount,note\r\n'+Array.from({length:9000},(_,i)=>'"'+i+' '+('x'.repeat(1000))+'",1234567890123456.12345678,'+(i%2?'"\\N"':'\\N')+'\r\n').join(''),file=await fixture(t,'large.csv',text);assert.ok(Buffer.byteLength(text)>8*1024*1024);let seen=0;const result=await scanSource({file,hasHeader:true,nullToken:'\\N'},{onRow:row=>{assert.equal(row.values[1],'1234567890123456.12345678');assert.equal(row.nulls[2],seen%2===0);seen++;}});assert.equal(result.rowCount,9000);assert.equal(seen,9000);assert.equal(result.preview.length,10);assert.equal(result.fileHash.length,64);assert.equal(result.dataHash.length,64);});
test('CSV quoting spans read boundaries and rejects malformed UTF8, unmatched quotes and width drift',async t=>{const file=await fixture(t,'split.csv','a,b\n"'+('x'.repeat(LIMITS.chunkBytes-8))+'""tail\nline",yes\n');const value=await scanSource({file});assert.equal(value.rowCount,1);assert.ok(value.preview[0][0].startsWith('x'));await writeSource(file,'a,b\n"bad,cell\n');await assert.rejects(scanSource({file}),/not closed/);await writeSource(file,Buffer.from([0x61,0x0a,0xff]));await assert.rejects(scanSource({file}),/UTF-8/);await writeSource(file,'a,b\n1,2,3');await assert.rejects(scanSource({file}),/field count/);});
test('XLSX selected worksheet streams thousands of rows using bounded metadata and exact typed values',async t=>{const rows=[['label','amount','note'],...Array.from({length:4000},(_,i)=>['Row '+i,{value:'1e-8'},i%2?'':null])],file=await fixture(t,'large.xlsx',workbook({rows}));const inspect=await scanSource({file});assert.equal(inspect.needsSheet,true);assert.equal(inspect.sheets.length,2);let seen=0;const result=await scanSource({file,sheetId:'1',blankPolicy:'null'},{onRow:row=>{assert.equal(row.values[1],'0.00000001');assert.equal(row.nulls[2],seen%2===0);seen++;}});assert.equal(result.rowCount,4000);assert.equal(result.dateSystem,'1900');});
test('XLSX formula cached values are explicit and full selected-sheet CRC is checked',async t=>{const file=await fixture(t,'formula.xlsx',workbook({date1904:true,rows:[['label','amount','day'],['One',{formula:'1+1',value:'2'},{value:'0',style:1}]]}));await assert.rejects(scanSource({file,sheetId:'1'}),/Formula/);const report=await scanSource({file,sheetId:'1',formulaPolicy:'cached'});assert.equal(report.preview[0][1],'2');assert.equal(report.preview[0][2],'1904-01-01');assert.equal(report.formulaCount,1);const data=entries();data['xl/worksheets/sheet1.xml']=data['xl/worksheets/sheet1.xml'].replace('<sheetData>','<!DOCTYPE x [<!ENTITY e "bad">]><sheetData>');await writeSource(file,zip(data));await assert.rejects(scanSource({file,sheetId:'1'}),/DTD|Malformed/);const corrupt=workbook();for(let offset=0;offset<corrupt.length-46;offset++){if(corrupt.readUInt32LE(offset)!==0x02014b50)continue;const length=corrupt.readUInt16LE(offset+28),name=corrupt.subarray(offset+46,offset+46+length).toString();if(name==='xl/worksheets/sheet1.xml'){corrupt.writeUInt32LE((corrupt.readUInt32LE(offset+16)^1)>>>0,offset+16);break;}}await writeSource(file,corrupt);await assert.rejects(scanSource({file,sheetId:'1'}),/checksum/);});
test('source mutation during streaming and cancellation are rejected without accepting a partial source',async t=>{const file=await fixture(t,'mutable.tsv','a\tb\n1\t2\n3\t4\n'),controller=new AbortController();await assert.rejects(scanSource({file},{onRow:()=>controller.abort(),cancellation:controller.signal}),/cancelled/);await assert.rejects(scanSource({file},{onRow:async(row,n)=>{if(n===1)await fs.promises.appendFile(file,'5\t6\n');}}),/changed/);});

test('BOM-marked UTF-16 CSV and TSV preserve chunk-split Unicode, quoted line endings and NULL distinctions', async t => {
  for (const [encoding, extension, delimiter] of [['utf-16le', 'tsv', '\t'], ['utf-16be', 'csv', ',']]) {
    const sample = delimitedFixture(delimiter, 3, LIMITS.chunkBytes);
    assert.equal(sample.text.charCodeAt(sample.splitAt), 0xd83d);
    assert.equal(sample.text.charCodeAt(sample.splitAt + 1), 0xde00);
    const file = await fixture(t, 'unicode.' + extension, encodeUtf16(sample.text, encoding));
    const seen = [];
    const report = await scanSource({ file, nullToken: 'NULL' }, {
      onRow: ({ values, nulls }) => seen.push([Number(values[0]), values[1], nulls[2] ? null : values[2]])
    });
    assert.deepEqual(seen, sample.sample);
    assert.deepEqual(report.headers, ['id', 'payload', 'marker']);
    assert.equal(report.textEncoding, encoding);
    assert.equal(report.byteOrderMark, true);
    assert.equal(report.rowCount, 3);
  }
});

test('only the byte-order marker is stripped and actual UTF-8 input remains readable', async t => {
  const content = '\ufeffid,value\n1,서울\n';
  const file = await fixture(t, 'utf8.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]));
  const marked = await scanSource({ file });
  assert.deepEqual(marked.headers, ['\ufeffid', 'value']);
  assert.equal(marked.textEncoding, 'utf-8');
  assert.equal(marked.byteOrderMark, true);
  await writeSource(file, 'id,value\n1,서울\n');
  const plain = await scanSource({ file });
  assert.equal(plain.byteOrderMark, false);
  assert.deepEqual(plain.preview, [['1', '서울']]);
});

test('UTF-16 malformed units, missing BOM and UTF-32 fail with no substitute text', async t => {
  const content = 'id,value\n1,서울\n';
  const file = await fixture(t, 'invalid.csv', Buffer.from('id,value\n1,ordinary ASCII\n', 'utf16le'));
  await assert.rejects(scanSource({ file }), /NUL/u);
  await writeSource(file, Buffer.concat([encodeUtf16(content, 'utf-16le'), Buffer.from([0x01])]));
  await assert.rejects(scanSource({ file }), /UTF-16LE/u);
  await writeSource(file, Buffer.concat([encodeUtf16(content, 'utf-16be'), Buffer.from([0xd8, 0x00])]));
  await assert.rejects(scanSource({ file }), /UTF-16BE/u);
  for (const bytes of [[0xff, 0xfe, 0x00, 0x00], [0x00, 0x00, 0xfe, 0xff]]) {
    await writeSource(file, Buffer.from(bytes));
    await assert.rejects(scanSource({ file }), /UTF-32/u);
  }
});
