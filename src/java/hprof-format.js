'use strict';

const {setImmediate:yieldTurn}=require('node:timers/promises');

const LIMITS=Object.freeze({bytes:64*1024*1024,objects:300000,edges:1500000,symbols:180000,roots:100000});
const width={4:1,5:2,6:4,7:8,8:1,9:2,10:4,11:8};
const primitive={4:'boolean',5:'char',6:'float',7:'double',8:'byte',9:'short',10:'int',11:'long'};
const rootKinds=Object.freeze({
  1:['JNI global',0],2:['JNI local',8],3:['Java frame',8],4:['Native stack',4],5:['Sticky class',0],
  6:['Thread block',4],7:['Monitor',0],8:['Java thread',8],255:['Unknown root',0]
});
const unchanged=tag=>[3,4,5,6,7,10,11,13,14].includes(tag);
const corrupt=message=>Error('Invalid HPROF heap dump. '+message);
const aborted=signal=>{if(signal?.aborted)throw Error('Heap dump analysis cancelled.');};
const checkpoint=async signal=>{aborted(signal);await yieldTurn();aborted(signal);};
const clean=value=>value.replace(/[\u0000-\u001f\u007f]/gu,'\ufffd').slice(0,512);

class Reader {
  constructor(bytes,start=0,end=bytes.length,idSize=4){this.bytes=bytes;this.at=start;this.end=end;this.idSize=idSize;}
  take(size){
    if(!Number.isSafeInteger(size)||size<0||size>this.end-this.at)throw corrupt('A record is truncated or has an invalid size.');
    const begin=this.at;this.at+=size;return begin;
  }
  byte(){return this.bytes.readUInt8(this.take(1));}
  short(){return this.bytes.readUInt16BE(this.take(2));}
  int(){return this.bytes.readUInt32BE(this.take(4));}
  id(){return this.idSize===4?this.int():this.bytes.readBigUInt64BE(this.take(8));}
  block(size){
    const start=this.take(size);
    return new Reader(this.bytes,start,this.at,this.idSize);
  }
  value(type){if(type===2)return this.id();this.take(this.size(type));return null;}
  size(type){if(type===2)return this.idSize;if(!width[type])throw corrupt('An invalid field type was found.');return width[type];}
  string(size){const offset=this.take(size);return this.bytes.toString('utf8',offset,this.at);}
  get left(){return this.end-this.at;}
}

function className(name) {
  const dimensions=/^\[+/.exec(name)?.[0].length??0;
  if(!dimensions)return clean(name.replaceAll('/','.'));
  const element=name.slice(dimensions),types={Z:'boolean',C:'char',F:'float',D:'double',B:'byte',S:'short',I:'int',J:'long'};
  return clean((types[element]??element.replace(/^L|;$/g,'').replaceAll('/','.'))+'[]'.repeat(dimensions));
}

function parseClass(record,id) {
  record.take(4);
  const superId=record.id(),loader=record.id(),signers=record.id(),domain=record.id();
  record.take(record.idSize*2+4);
  const fields=[],references=[];
  for(const [value,label] of [[superId,'superclass'],[loader,'class loader'],[signers,'signers'],[domain,'protection domain']]) {
    if(value)references.push({id:value,label});
  }
  let shallow=0;
  const constants=record.short();
  for(let index=0;index<constants;index++){
    const slot=record.short(),type=record.byte(),value=record.value(type);
    if(value)references.push({id:value,label:'constant pool #'+slot});
  }
  const statics=record.short();
  for(let index=0;index<statics;index++){
    const name=record.id(),type=record.byte(),value=record.value(type);
    shallow+=record.size(type);
    if(value)references.push({id:value,name,static:true});
  }
  const count=record.short();
  for(let index=0;index<count;index++){
    const name=record.id(),type=record.byte();
    fields.push({name,type,size:record.size(type)});
  }
  return {id,kind:'class',superId,fields,references,shallow};
}

async function parseHprof(bytes,{signal}={}) {
  aborted(signal);
  if(!Buffer.isBuffer(bytes)||bytes.length>LIMITS.bytes)throw Error('Use a local HPROF file of at most 64 MiB.');
  const boundary=bytes.indexOf(0);
  if(boundary<0||boundary>32||!/^JAVA PROFILE 1\.0\.[12]$/.test(bytes.toString('ascii',0,boundary))) {
    throw corrupt('Use a HotSpot HPROF 1.0.1 or 1.0.2 file.');
  }
  const reader=new Reader(bytes,boundary+1);
  const idSize=reader.int();
  if(idSize!==4&&idSize!==8)throw corrupt('Object identifiers must use four or eight bytes.');
  reader.idSize=idSize;
  reader.take(8);
  const symbols=new Map(),classSymbols=new Map(),objects=[],positions=new Map(),roots=new Map();
  let visits=0,segments=false,ended=false,unsegmented=false;
  function object(value) {
    if(!value.id||positions.has(value.id))throw corrupt('Duplicate or empty object identifiers.');
    if(objects.length===LIMITS.objects)throw Error('The heap dump exceeds the 300,000 object analysis limit.');
    positions.set(value.id,objects.length+1);
    objects.push(value);
  }
  async function heap(record) {
    while(record.left){
      if(++visits%8192===0)await checkpoint(signal);
      const tag=record.byte(),id=record.id(),root=rootKinds[tag];
      if(root){
        record.take(root[1]+(tag===1?idSize:0));
        if(id&&!roots.has(id)){
          if(roots.size===LIMITS.roots)throw Error('The heap contains too many GC roots.');
          roots.set(id,root[0]);
        }
        continue;
      }
      if(tag===0x20){object(parseClass(record,id));continue;}
      if(tag!==0x21&&tag!==0x22&&tag!==0x23)throw corrupt('Unsupported HotSpot heap subrecord 0x'+tag.toString(16)+'.');
      record.take(4);
      if(tag===0x21){
        const classId=record.id(),shallow=record.int(),offset=record.take(shallow);
        object({id,kind:'instance',classId,shallow,offset});
      }else{
        const length=record.int();
        const classId=tag===0x22?record.id():undefined,type=tag===0x23?record.byte():undefined;
        if(type!==undefined&&!width[type])throw corrupt('Unsupported primitive array type.');
        const shallow=length*(type===undefined?idSize:width[type]),offset=record.take(shallow);
        object({id,kind:type===undefined?'array':'primitive',classId,type,length,shallow,offset});
      }
    }
  }
  while(reader.left){
    if(++visits%8192===0)await checkpoint(signal);
    const tag=reader.byte();
    reader.take(4);
    const record=reader.block(reader.int());
    if(tag===1){
      const id=record.id();
      if(record.left>65536||symbols.size===LIMITS.symbols||!id||symbols.has(id))throw corrupt('Invalid or excessive symbol metadata.');
      symbols.set(id,record.string(record.left));
    }else if(tag===2){
      record.take(4);
      const id=record.id();record.take(4);
      const symbol=record.id();
      if(!id||!symbol||classSymbols.size===LIMITS.symbols)throw corrupt('Invalid or excessive class metadata.');
      const prior=classSymbols.get(id);
      if(prior&&prior!==symbol)throw corrupt('A class identifier names more than one type.');
      classSymbols.set(id,symbol);
    }else if(tag===0x0c||tag===0x1c){
      if(ended||unsegmented||(tag===0x0c&&segments))throw corrupt('Only one complete heap snapshot is supported.');
      if(tag===0x0c)unsegmented=true;else segments=true;
      await heap(record);
    }else if(tag===0x2c){
      if(record.left||!segments||ended)throw corrupt('Unexpected heap dump end record.');
      ended=true;
    }else if(unchanged(tag))record.take(record.left);
    else throw corrupt('Unsupported top-level record 0x'+tag.toString(16)+'.');
    if(record.left)throw corrupt('Unexpected trailing bytes in a record.');
  }
  if((!unsegmented&&!ended)||!objects.length||!roots.size)throw corrupt('A complete heap and its GC roots are required.');
  const typeNames=new Map();
  const nameFor=id=>{
    const cached=typeNames.get(id);
    if(cached)return cached;
    const name=symbols.get(classSymbols.get(id));
    if(!name)throw corrupt('An object references a class without a name.');
    const normalized=className(name);
    typeNames.set(id,normalized);
    return normalized;
  };
  const fieldName=id=>{
    const name=symbols.get(id);
    if(!name)throw corrupt('A field has no name record.');
    return clean(name);
  };
  const classesByName=new Map();
  for(const value of objects){
    if(++visits%8192===0)await checkpoint(signal);
    if(value.kind==='class'){
      value.typeName=nameFor(value.id);
      if(!classesByName.has(value.typeName))classesByName.set(value.typeName,value.id);
      for(const field of value.fields)field.label=fieldName(field.name);
      for(const reference of value.references)if(reference.static)reference.label='static '+fieldName(reference.name);
    }else if(value.kind==='primitive'){
      value.typeName=primitive[value.type]+'[]';
    }else value.typeName=nameFor(value.classId);
  }
  return {bytes,idSize,objects,positions,roots,classesByName};
}

module.exports={LIMITS,Reader,parseHprof,checkpoint,corrupt};
