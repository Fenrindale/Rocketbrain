'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const {inflateSync}=require('node:zlib');
const {createHash}=require('node:crypto');

const fixture=path.join(__dirname,'../fixtures/javafx-preview');
const source=path.join('src/main/resources/views','inventory.fxml');
const stylesheet=path.join('src/main/resources/views','theme.css');
const changed=text=>text.replace('#112233','#55aa66');

function pixels(png) {
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  assert.deepEqual([width,height,png[24],png[25],png[28]],[96,72,8,6,0]);
  const chunks=[];
  for (let index=8;index<png.length;) {
    const size=png.readUInt32BE(index);
    if (png.toString('ascii',index+4,index+8)==='IDAT') chunks.push(png.subarray(index+8,index+8+size));
    index+=size+12;
  }
  const stride=width*4,rows=[],input=inflateSync(Buffer.concat(chunks),{maxOutputLength:(stride+1)*height});
  assert.equal(input.length,(stride+1)*height);
  for (let y=0;y<height;y++) {
    const start=y*(stride+1),filter=input[start],row=Buffer.alloc(stride),previous=rows[y-1];
    assert.ok(filter<=4);
    for (let x=0;x<stride;x++) {
      const left=row[x-4]||0,above=previous?.[x]||0,corner=previous?.[x-4]||0;
      const paeth=left+above-corner,dl=Math.abs(paeth-left),da=Math.abs(paeth-above),dc=Math.abs(paeth-corner);
      const fourth=dl<=da&&dl<=dc?left:da<=dc?above:corner;
      row[x]=input[start+1+x]+[0,left,above,Math.floor((left+above)/2),fourth][filter];
    }
    rows.push(row);
  }
  return (x,y)=>[...rows[y].subarray(x*4,x*4+4)];
}

function imageProof(bytes,report,updated=false,moved=false) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'),report.imageSha256);
  assert.equal(bytes.length,report.bytes);
  const get=pixels(bytes);
  const values={background:get(70,52),indicator:get(10,10),included:get(moved?63:51,18)};
  if (moved) assert.deepEqual(get(51,18),[85,170,102,255]);
  assert.deepEqual(values,{background:updated?[85,170,102,255]:[17,34,51,255],
    indicator:[204,51,68,255],included:[34,51,255,255]});
  return {...values,imageSha256:report.imageSha256};
}

module.exports={fixture,source,stylesheet,changed,imageProof,pixels};
