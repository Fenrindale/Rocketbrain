'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const {inflateSync}=require('node:zlib');
const {createHash}=require('node:crypto');

const fixture=path.join(__dirname,'../fixtures/java/kmp-compose-preview');
const sourceFile=path.join('src/commonMain/kotlin/previewfixture','InventoryPreview.kt');
const updated=text=>text.replace('0xFFFF2244','0xFF44CC66');
const blocks={initial:[255,34,68,255],updated:[68,204,102,255],inset:[34,51,255,255]};

function pixels(png) {
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  assert.deepEqual([width,height,png[24],png[25],png[28]],[96,72,8,6,0]);
  const input=[];
  for (let offset=8;offset<png.length;) {
    const length=png.readUInt32BE(offset),kind=png.toString('ascii',offset+4,offset+8);
    if (kind==='IDAT') input.push(png.subarray(offset+8,offset+8+length));
    offset+=length+12;
  }
  const stride=width*4,raw=inflateSync(Buffer.concat(input),{maxOutputLength:(stride+1)*height}),rows=[];
  assert.equal(raw.length,(stride+1)*height);
  function paeth(left,up,corner) {
    const estimate=left+up-corner;
    const values=[left,up,corner],distances=values.map(value=>Math.abs(value-estimate));
    return values[distances.indexOf(Math.min(...distances))];
  }
  for (let y=0;y<height;y++) {
    const offset=y*(stride+1),filter=raw[offset],row=Buffer.alloc(stride),last=rows[y-1];
    assert.ok(filter<=4);
    for (let x=0;x<stride;x++) {
      const left=row[x-4]||0,up=last?.[x]||0,corner=last?.[x-4]||0;
      const predictors=[0,left,up,Math.floor((left+up)/2),paeth(left,up,corner)];
      row[x]=raw[offset+1+x]+predictors[filter];
    }
    rows.push(row);
  }
  return (x,y)=>[...rows[y].subarray(x*4,x*4+4)];
}

function verifyImage(png,report,variant) {
  assert.equal(report.imageSha256,createHash('sha256').update(png).digest('hex'));
  assert.equal(report.bytes,png.length);
  const rgba=pixels(png),background=rgba(45,40),inset=rgba(8,8);
  assert.deepEqual(background,blocks[variant]);
  assert.deepEqual(inset,blocks.inset);
  return {imageSha256:report.imageSha256,sourceSha256:report.sourceSha256,background,inset};
}

module.exports={fixture,sourceFile,updated,verifyImage};
